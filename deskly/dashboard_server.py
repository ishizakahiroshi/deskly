"""Loopback-only HTTP boundary for the legacy view and personal workspace."""

from __future__ import annotations

import hmac
import json
import os
import secrets
import socket
import sqlite3
import time
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from threading import BoundedSemaphore, RLock
from typing import Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

from deskly.shared_auth import (
    SHARED_SESSION_COOKIE_NAME,
    CredentialStoreError,
    LocalCredentialStore,
    SharedSessions,
    TrustedProxies,
    parse_trusted_proxies,
    resolve_client_address,
)
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_model import WorkspaceError

DEFAULT_DASHBOARD_HOST = "127.0.0.1"
DEFAULT_DASHBOARD_PORT = 8766
DASHBOARD_PASSWORD_ENV = "DESKLY_DASHBOARD_PASSWORD"
SESSION_COOKIE_NAME = "deskly_dashboard_session"
SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 64
MAX_LOGIN_BODY_BYTES = 4096
MAX_WORKSPACE_BODY_BYTES = 32768
MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_ACTIVE_REQUESTS = 8
# Socket I/O wait limit per connection (HTTP/1.0, closed after each response and
# no long-lived streams), so an idle connection cannot hold a request slot.
# Well above any legitimate request; provider work is not socket I/O.
REQUEST_READ_TIMEOUT_SECONDS = 30.0
MIN_PASSWORD_LENGTH = 16
MAX_PASSWORD_LENGTH = 1024
STATIC_ASSETS = frozenset({"index.html", "app.css", "app.js", "workspace.js"})
STATIC_CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "workspace.js": "text/javascript; charset=utf-8",
}
_INDEX_FALLBACK = (
    b"<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\">"
    b"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    b"<title>Deskly</title><body><main><h1>Deskly</h1>"
    b"<p>Dashboard UI assets are not installed.</p></main></body></html>"
)

DashboardProvider = Callable[[], Mapping[str, Any]]


class DashboardConfigurationError(ValueError):
    """Dashboard configuration is missing or unsafe."""


class DashboardHTTPServer(ThreadingHTTPServer):
    """Server state is limited to one password and in-memory sessions."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        password: str,
        dashboard_provider: DashboardProvider | None,
        notification_provider: DashboardProvider | None,
        workspace_service: Any | None = None,
        shared_accounts: LocalCredentialStore | None = None,
        shared_home: Path | None = None,
        shared_workspace_id: str | None = None,
        shared_origin: str | None = None,
        trusted_proxies: TrustedProxies = (),
    ) -> None:
        super().__init__(address, DashboardRequestHandler)
        self.password_bytes = password.encode("utf-8")
        self.dashboard_provider = dashboard_provider
        self.notification_provider = notification_provider
        self.workspace_service = workspace_service
        self.shared_accounts = shared_accounts
        self.shared_sessions = SharedSessions(shared_accounts) if shared_accounts else None
        self.shared_home = shared_home
        self.shared_workspace_id = shared_workspace_id
        self.shared_origin = shared_origin
        # Only the shared Web behind a reverse proxy reads forwarding headers.
        self.trusted_proxies = trusted_proxies if shared_accounts else ()
        self.shared_secret = secrets.token_bytes(32) if shared_accounts else None
        self.sessions: dict[str, float] = {}
        self.sessions_lock = RLock()
        self._request_slots = BoundedSemaphore(MAX_ACTIVE_REQUESTS)

    def process_request(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: tuple[str, int],
    ) -> None:
        if not self._request_slots.acquire(blocking=False):
            if isinstance(request, socket.socket):
                self._reject_busy_request(request)
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            self.shutdown_request(request)
            return

    def process_request_thread(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: tuple[str, int],
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()

    def _reject_busy_request(self, request: socket.socket) -> None:
        # Closing a socket with unread request bytes can discard the response
        # (notably as WSAECONNABORTED on Windows). Keep the accept loop bounded
        # while consuming a complete, reasonably sized request when available.
        self._drain_busy_request(request)
        body = b'{"error":"dashboard_busy"}'
        headers = (
            "HTTP/1.0 503 Service Unavailable\r\n"
            "Connection: close\r\n"
            "Cache-Control: no-store\r\n"
            "X-Content-Type-Options: nosniff\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n\r\n"
        ).encode("ascii")
        try:
            request.sendall(headers + body)
        except OSError:
            pass

    @staticmethod
    def _drain_busy_request(request: socket.socket) -> None:
        deadline = time.monotonic() + 0.05
        max_headers = 8192
        max_body = MAX_WORKSPACE_BODY_BYTES
        received = bytearray()
        expected_length: int | None = None
        original_timeout = request.gettimeout()
        try:
            while len(received) < max_headers + max_body:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                request.settimeout(remaining)
                try:
                    chunk = request.recv(min(4096, max_headers + max_body - len(received)))
                except OSError:
                    break
                if not chunk:
                    break
                received.extend(chunk)
                if expected_length is None:
                    header_end = received.find(b"\r\n\r\n")
                    if header_end < 0:
                        if len(received) >= max_headers:
                            break
                        continue
                    expected_length = header_end + 4
                    content_lengths = [
                        line.split(b":", 1)[1].strip()
                        for line in bytes(received[:header_end]).split(b"\r\n")[1:]
                        if line.lower().startswith(b"content-length:")
                    ]
                    if (
                        len(content_lengths) == 1
                        and len(content_lengths[0]) <= len(str(max_body))
                        and content_lengths[0].isdigit()
                    ):
                        body_length = int(content_lengths[0])
                        if body_length <= max_body:
                            expected_length += body_length
                if expected_length is not None and len(received) >= expected_length:
                    break
        finally:
            request.settimeout(original_timeout)

    def create_session(self) -> str:
        now = time.monotonic()
        with self.sessions_lock:
            self._remove_expired_sessions(now)
            if len(self.sessions) >= MAX_SESSIONS:
                oldest_session = min(self.sessions, key=self.sessions.__getitem__)
                self.sessions.pop(oldest_session, None)
            session_id = secrets.token_urlsafe(32)
            self.sessions[session_id] = now + SESSION_TTL_SECONDS
        return session_id

    def valid_session(self, session_id: str) -> bool:
        now = time.monotonic()
        with self.sessions_lock:
            expires_at = self.sessions.get(session_id)
            if expires_at is None:
                return False
            if expires_at <= now:
                self.sessions.pop(session_id, None)
                return False
            return True

    def remove_session(self, session_id: str) -> None:
        with self.sessions_lock:
            self.sessions.pop(session_id, None)

    def _remove_expired_sessions(self, now: float) -> None:
        expired = [session_id for session_id, expiry in self.sessions.items() if expiry <= now]
        for session_id in expired:
            self.sessions.pop(session_id, None)


class DashboardRequestHandler(BaseHTTPRequestHandler):
    server: DashboardHTTPServer
    protocol_version = "HTTP/1.0"
    # StreamRequestHandler applies this to the connection socket in setup().
    timeout = REQUEST_READ_TIMEOUT_SECONDS

    def log_message(self, _format: str, *_args: object) -> None:
        # Paths, query strings, and submitted values are private dashboard data.
        return

    def log_error(self, _format: str, *_args: object) -> None:
        return

    def send_error(
        self, code: int, message: str | None = None, explain: str | None = None
    ) -> None:
        del message, explain
        status = 405 if code == 501 else code if code in {400, 414, 431} else 400
        payload = {"error": "method_not_allowed" if status == 405 else "bad_request"}
        self._send_json(status, payload, extra_headers=(("Allow", "GET, POST"),))

    def _security_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'; form-action 'self'",
        )
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        extra_headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _send_json(
        self,
        status: int,
        payload: object,
        *,
        extra_headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        self._discard_rejected_body()
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(
            status,
            body,
            "application/json; charset=utf-8",
            extra_headers=extra_headers,
        )

    def _discard_rejected_body(self) -> None:
        if self.command != "POST" or getattr(self, "_request_body_read", False):
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()
            or len(lengths[0]) > len(str(MAX_WORKSPACE_BODY_BYTES))):
            self.close_connection = True
            return
        length = int(lengths[0])
        if length > MAX_WORKSPACE_BODY_BYTES:
            self.close_connection = True
            return
        previous_timeout = self.connection.gettimeout()
        try:
            self.connection.settimeout(1.0)
            discarded = self.rfile.read(length)
            if len(discarded) != length:
                self.close_connection = True
        except (OSError, TimeoutError):
            self.close_connection = True
        finally:
            self.connection.settimeout(previous_timeout)

    def _host_is_loopback(self) -> bool:
        host_values = self.headers.get_all("Host", [])
        if len(host_values) != 1:
            return False
        if self.server.shared_origin is not None:
            if self.path == "/healthz" and host_values[0] in {
                f"127.0.0.1:{self.server.server_port}",
                f"localhost:{self.server.server_port}",
            }:
                return True
            return host_values[0].casefold() == urlsplit(self.server.shared_origin).netloc.casefold()
        try:
            raw_host = host_values[0]
            if not raw_host or any(ord(char) <= 0x20 or ord(char) == 0x7F for char in raw_host):
                return False
            parsed = urlsplit(f"http://{raw_host}")
            hostname = parsed.hostname
            port = parsed.port if parsed.port is not None else 80
        except ValueError:
            return False
        return (
            hostname in {"127.0.0.1", "localhost"}
            and port == self.server.server_port
            and parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and not parsed.query
            and not parsed.fragment
        )

    def _same_origin(self, *, required: bool) -> bool:
        origins = self.headers.get_all("Origin", [])
        if self.server.shared_origin is not None:
            if (required or origins) and (len(origins) != 1 or origins[0] != self.server.shared_origin):
                return False
            fetch_sites = self.headers.get_all("Sec-Fetch-Site", [])
            return len(fetch_sites) <= 1 and (
                not fetch_sites or fetch_sites[0].casefold() == "same-origin"
            )
        if not origins:
            if required:
                return False
        elif len(origins) != 1:
            return False
        else:
            try:
                origin = urlsplit(origins[0])
                origin_port = origin.port if origin.port is not None else 80
            except ValueError:
                return False
            hosts = self.headers.get_all("Host", [])
            if (
                origin.scheme.casefold() != "http"
                or origin.hostname not in {"127.0.0.1", "localhost"}
                or origin_port != self.server.server_port
                or origin.username is not None
                or origin.password is not None
                or origin.path
                or origin.query
                or origin.fragment
                or len(hosts) != 1
            ):
                return False
            try:
                request_origin = urlsplit(f"http://{hosts[0]}")
                request_port = (
                    request_origin.port if request_origin.port is not None else 80
                )
            except ValueError:
                return False
            if (origin.hostname, origin_port) != (request_origin.hostname, request_port):
                return False

        fetch_sites = self.headers.get_all("Sec-Fetch-Site", [])
        return len(fetch_sites) <= 1 and (
            not fetch_sites or fetch_sites[0].casefold() == "same-origin"
        )

    def _request_path(self) -> str | None:
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            return None
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            return None
        return parsed.path if parsed.path.startswith("/") else None

    def _session_id(self) -> str | None:
        cookie_headers = self.headers.get_all("Cookie", [])
        if len(cookie_headers) != 1:
            return None
        found: str | None = None
        expected_name = SHARED_SESSION_COOKIE_NAME if self.server.shared_sessions else SESSION_COOKIE_NAME
        for cookie in cookie_headers[0].split(";"):
            name, separator, value = cookie.strip().partition("=")
            if name != expected_name:
                continue
            if not separator or found is not None:
                return None
            found = value
        if found is None or not found or len(found) > 128:
            return None
        return found

    def _authenticated(self) -> bool:
        session_id = self._session_id()
        if self.server.shared_sessions is not None:
            try:
                if session_id is not None and self.server.shared_sessions.subject(session_id):
                    return True
            except (OSError, sqlite3.Error, CredentialStoreError):
                self._send_json(503, {"error": "auth_unavailable"})
                return False
            self._send_json(401, {"error": "unauthorized"})
            return False
        if session_id is not None and self.server.valid_session(session_id):
            return True
        self._send_json(401, {"error": "unauthorized"})
        return False

    def _workspace_service(self) -> Any | None:
        if self.server.shared_sessions is None:
            return self.server.workspace_service
        token = self._session_id()
        subject = self.server.shared_sessions.subject(token) if token else None
        if subject is None:
            raise WorkspaceError("unauthorized", 401)
        from deskly.workspace_service import WorkspaceService

        assert self.server.shared_home is not None
        assert self.server.shared_workspace_id is not None
        assert self.server.shared_secret is not None
        service = WorkspaceService(self.server.shared_home, self.server.shared_workspace_id,
                                   secret=self.server.shared_secret,
                                   identity=(self.server.shared_origin or "", subject))
        service.principal()  # Recheck membership and active state on every request.
        return service

    def _shared_access(self, service: Any) -> WorkspaceAccess:
        if self.server.shared_sessions is None:
            raise WorkspaceError("not_found", 404)
        access = WorkspaceAccess(service.store, service.workspace_id, service.principal(),
                                 execution_route="dashboard")
        with service.store.connect() as db:
            access._owner(db)
        return access

    @staticmethod
    def _shared_command_allowed(value: object) -> bool:
        """Initial shared Web accepts only local md and HTTPS references."""
        if not isinstance(value, dict):
            return True  # Let the workspace service return the schema error.
        request = value.get("request", value)
        if not isinstance(request, dict):
            return True
        kind = request.get("type")
        if kind == "source":
            return False
        if kind != "reference":
            return True
        for snapshot in (request.get("data"), value.get("before"), value.get("after")):
            if isinstance(snapshot, dict) and snapshot.get("kind") not in {"md", "https"}:
                return False
        return True

    @staticmethod
    def _shared_workspace_result(path: str, result: Any, service: Any) -> Any:
        if not isinstance(result, dict):
            return result
        principal = service.principal()
        if principal.role == "owner":
            permissions: dict[str, str] = {}
            fallback = "owner"
        else:
            with service.store.connect() as db:
                permissions = {row["project_id"]: row["role"] for row in db.execute(
                    """SELECT project_id,role FROM project_memberships
                    WHERE workspace_id=? AND member_id=? AND role IS NOT NULL""",
                    (service.workspace_id, principal.member_id))}
            fallback = ""
        if path.endswith("/projects"):
            visible_sources = [{key: source[key] for key in ("id", "label", "adapter")
                                if key in source} for source in result.get("sources", [])
                               if not source.get("archived")]
            return {**result, "sources": visible_sources,
                    "projects": [{**item, "permission": permissions.get(item["id"], fallback)}
                                 for item in result["projects"]
                                 if principal.role == "owner" or item["id"] in permissions],
                    "archived_projects": [{**item, "permission": permissions.get(item["id"], fallback)}
                                          for item in result["archived_projects"]
                                          if principal.role == "owner" or item["id"] in permissions]}
        if path.endswith("/history"):
            if principal.role != "owner" and result.get("project_id") not in permissions:
                raise WorkspaceError("not_found", 404)
            events = []
            for event in result.get("events", []):
                snapshots = (event.get("before"), event.get("after"))
                if any(isinstance(item, dict) and (
                    item.get("type") in {"source", "observation"}
                    or (item.get("type") == "reference" and item.get("kind") not in {"md", "https"})
                ) for item in snapshots):
                    continue
                events.append(event)
            return {**result, "events": events}
        if "references" in result and "external" in result:
            if principal.role != "owner" and result["project"]["id"] not in permissions:
                raise WorkspaceError("not_found", 404)
            return {**result,
                    "project": {**result["project"],
                                "permission": permissions.get(result["project"]["id"], fallback)},
                    "references": [item for item in result["references"]
                                   if item.get("kind") in {"md", "https"}],
                    "external": {"status": "not_connected", "observations": []}}
        return result

    def _read_login_password(self) -> tuple[str | None, int]:
        content_types = self.headers.get_all("Content-Type", [])
        if len(content_types) != 1:
            return None, 415
        if content_types[0].split(";", 1)[0].strip().casefold() != "application/json":
            return None, 415
        if self.headers.get_all("Transfer-Encoding", []):
            return None, 400
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isdecimal():
            return None, 400
        if len(lengths[0]) > len(str(MAX_LOGIN_BODY_BYTES)):
            return None, 413
        length = int(lengths[0])
        if length > MAX_LOGIN_BODY_BYTES:
            return None, 413
        try:
            raw = self.rfile.read(length)
            self._request_body_read = True
            if len(raw) != length:
                return None, 400

            def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
                result: dict[str, Any] = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError("duplicate JSON key")
                    result[key] = value
                return result

            value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None, 400
        if not isinstance(value, dict) or set(value) != {"password"}:
            return None, 400
        password = value.get("password")
        if not isinstance(password, str):
            return None, 400
        if any(0xD800 <= ord(character) <= 0xDFFF for character in password):
            return None, 400
        return password, 200

    def _read_workspace_json(self) -> object:
        content_types = self.headers.get_all("Content-Type", [])
        lengths = self.headers.get_all("Content-Length", [])
        if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("content_type")
        if self.headers.get_all("Transfer-Encoding", []) or len(lengths) != 1 or not lengths[0].isdecimal():
            raise ValueError("length")
        if len(lengths[0]) > len(str(MAX_WORKSPACE_BODY_BYTES)) or int(lengths[0]) > MAX_WORKSPACE_BODY_BYTES:
            raise OverflowError("body_too_large")
        length = int(lengths[0])
        raw = self.rfile.read(length)
        self._request_body_read = True
        if len(raw) != length:
            raise ValueError("length")

        def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            value: dict[str, Any] = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate_key")
                value[key] = item
            return value

        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)

    def _workspace_get(self, path: str) -> bool:
        if path == "/api/workspace":
            if not self._authenticated():
                return True
            try:
                service = self._workspace_service()
            except WorkspaceError as exc:
                self._send_json(exc.status, {"error": exc.code})
                return True
            except (OSError, sqlite3.Error, CredentialStoreError):
                self._send_json(503, {"error": "workspace_unavailable"})
                return True
            result = {"configured": service is not None,
                      "workspace_id": service.workspace_id if service else None}
            if self.server.shared_sessions is not None and service is not None:
                try:
                    principal = service.principal()
                except WorkspaceError as exc:
                    self._send_json(exc.status, {"error": exc.code})
                    return True
                except (OSError, sqlite3.Error):
                    self._send_json(503, {"error": "workspace_unavailable"})
                    return True
                result.update({"member_id": principal.member_id, "role": principal.role})
            self._send_json(200, result)
            return True
        if not path.startswith("/api/workspaces/"):
            return False
        if not self._authenticated():
            return True
        try:
            service = self._workspace_service()
        except WorkspaceError as exc:
            self._send_json(exc.status, {"error": exc.code})
            return True
        except (OSError, sqlite3.Error, CredentialStoreError):
            self._send_json(503, {"error": "workspace_unavailable"})
            return True
        if service is None:
            self._send_json(404, {"error": "workspace_not_initialized"})
            return True
        parts = path.strip("/").split("/")
        if len(parts) < 4 or parts[2] != service.workspace_id:
            self._send_json(404, {"error": "workspace_not_found"})
            return True
        try:
            if (self.server.shared_sessions is not None and len(parts) == 5
                and parts[3:] == ["sources", "contact"]):
                from deskly.shared_contacts import list_contact_sources

                assert self.server.shared_home is not None
                self._send_json(200, list_contact_sources(self.server.shared_home, service))
                return True
            if (self.server.shared_sessions is not None and len(parts) >= 6
                and parts[3] == "projects" and parts[5] == "contacts"):
                from urllib.parse import unquote

                from deskly.shared_contacts import get_project_contact, list_project_contacts

                assert self.server.shared_home is not None
                if len(parts) == 6:
                    result = list_project_contacts(self.server.shared_home, service, parts[4])
                elif len(parts) == 7:
                    result = get_project_contact(
                        self.server.shared_home, service, parts[4], unquote(parts[6]),
                    )
                else:
                    self._send_json(404, {"error": "not_found"})
                    return True
                self._send_json(200, result)
                return True
            if len(parts) == 4 and parts[3] == "projects":
                result = service.projects()
            elif len(parts) == 4 and parts[3] == "counts":
                result = service.counts()
            elif len(parts) == 5 and parts[3] == "search":
                from urllib.parse import unquote

                result = service.search(unquote(parts[4]))
            elif len(parts) == 4 and parts[3] == "my-work":
                result = service.my_work()
            elif len(parts) == 5 and parts[3] == "projects":
                result = service.detail(parts[4])
            elif len(parts) == 6 and parts[3] == "projects" and parts[5] == "history":
                result = service.history(parts[4])
            elif len(parts) == 5 and parts[3:] == ["access", "members"]:
                result = self._shared_access(service).members_and_grants()
                assert self.server.shared_accounts is not None
                active_subjects = set(self.server.shared_accounts.active_subjects())
                with service.store.connect() as db:
                    for member in result["members"]:
                        identity = db.execute("""SELECT subject FROM identities
                            WHERE workspace_id=? AND member_id=? AND issuer=?""",
                            (service.workspace_id, member["member_id"],
                             self.server.shared_origin)).fetchone()
                        has_revocation_event = db.execute("""SELECT 1 FROM access_events
                            WHERE workspace_id=? AND target_type='member_credentials'
                            AND target_id=? LIMIT 1""",
                            (service.workspace_id, member["member_id"])).fetchone() is not None
                        member["credential_revocation_pending"] = bool(
                            not member["active"] and identity is not None and
                            (identity["subject"] in active_subjects or not has_revocation_event)
                        )
            elif len(parts) == 5 and parts[3:] == ["access", "sources"]:
                result = self._shared_access(service).source_members_and_grants()
            else:
                self._send_json(404, {"error": "not_found"})
                return True
            if self.server.shared_sessions is not None:
                result = self._shared_workspace_result(path, result, service)
            self._send_json(200, result)
        except WorkspaceError as exc:
            self._send_json(exc.status, {"error": exc.code})
        except (OSError, sqlite3.Error):
            self._send_json(503, {"error": "workspace_unavailable"})
        return True

    def _load_static_asset(self, filename: str) -> bytes | None:
        if filename not in STATIC_ASSETS:
            return None
        try:
            asset = resources.files("deskly").joinpath("static", filename)
            if not asset.is_file():
                return None
            return asset.read_bytes()
        except (FileNotFoundError, ModuleNotFoundError, OSError):
            return None

    def _default_dashboard_provider(self) -> Mapping[str, Any]:
        from deskly.dashboard import get_dashboard_payload

        return get_dashboard_payload()

    def _default_notification_provider(self) -> Mapping[str, Any]:
        from deskly.dashboard import get_notification_preview_payload

        return get_notification_preview_payload()

    def _serve_provider(self, provider: DashboardProvider | None, *, notification: bool) -> None:
        try:
            result = (
                provider()
                if provider is not None
                else self._default_notification_provider()
                if notification
                else self._default_dashboard_provider()
            )
            if not isinstance(result, Mapping):
                raise TypeError("dashboard provider returned a non-object")
            if notification:
                result = self._notification_allowlist(result)
            body = json.dumps(
                result, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            if len(body) > MAX_PROVIDER_RESPONSE_BYTES:
                raise ValueError("dashboard response exceeds size limit")
        except Exception:
            self._send_json(503, {"error": "dashboard_unavailable"})
            return
        self._send_bytes(200, body, "application/json; charset=utf-8")

    @staticmethod
    def _notification_allowlist(result: Mapping[str, Any]) -> dict[str, object]:
        as_of_utc = result.get("as_of_utc")
        waiting_count = result.get("waiting_count")
        overdue_count = result.get("overdue_count")
        if (
            result.get("preview_only") is not True
            or not isinstance(as_of_utc, str)
            or not as_of_utc
            or len(as_of_utc) > 64
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in as_of_utc)
            or isinstance(waiting_count, bool)
            or not isinstance(waiting_count, int)
            or waiting_count < 0
            or isinstance(overdue_count, bool)
            or not isinstance(overdue_count, int)
            or overdue_count < 0
        ):
            raise ValueError("notification provider returned an invalid result")
        return {
            "preview_only": True,
            "as_of_utc": as_of_utc,
            "waiting_count": waiting_count,
            "overdue_count": overdue_count,
        }

    def _method_not_allowed(self) -> None:
        self._send_json(
            405,
            {"error": "method_not_allowed"},
            extra_headers=(("Allow", "GET, POST"),),
        )

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._host_is_loopback():
            self._send_json(400, {"error": "invalid_host"})
            return
        path = self._request_path()
        if path is None:
            self._send_json(400, {"error": "invalid_request"})
            return
        if path == "/api/mode":
            self._send_json(200, {"mode": "shared" if self.server.shared_sessions else "personal"})
            return
        if path == "/healthz" and self.server.shared_accounts is not None:
            try:
                from deskly.workspace_store import SCHEMA_VERSION, WorkspaceStore, workspace_path

                assert self.server.shared_home is not None
                assert self.server.shared_workspace_id is not None
                store = WorkspaceStore(workspace_path(self.server.shared_home,
                                                       self.server.shared_workspace_id))
                with store.connect() as db:
                    row = db.execute("SELECT schema_version FROM metadata WHERE workspace_id=?",
                                     (self.server.shared_workspace_id,)).fetchone()
                ready = False
                if row is not None and row[0] == SCHEMA_VERSION:
                    for subject in self.server.shared_accounts.active_subjects():
                        try:
                            principal = store.identity_principal(self.server.shared_workspace_id,
                                                                 self.server.shared_origin or "", subject)
                        except WorkspaceError:
                            continue
                        if principal.role == "owner":
                            ready = True
                            break
                self._send_json(200 if ready else 503,
                                {"status": "ok" if ready else "unavailable"})
            except (OSError, sqlite3.Error, WorkspaceError, CredentialStoreError):
                self._send_json(503, {"status": "unavailable"})
            return
        if path == "/":
            body = self._load_static_asset("index.html") or _INDEX_FALLBACK
            self._send_bytes(200, body, "text/html; charset=utf-8")
            return
        if path.startswith("/static/"):
            filename = path.removeprefix("/static/")
            asset_body = self._load_static_asset(filename)
            if asset_body is None:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_bytes(200, asset_body, STATIC_CONTENT_TYPES[filename])
            return
        if path.startswith("/api/workspace"):
            if not self._same_origin(required=False):
                self._send_json(403, {"error": "same_origin_required"})
                return
            if self._workspace_get(path):
                return
        if path not in {"/api/dashboard", "/api/notification-preview"}:
            self._send_json(404, {"error": "not_found"})
            return
        if self.server.shared_sessions is not None:
            self._send_json(404, {"error": "not_found"})
            return
        if not self._same_origin(required=False):
            self._send_json(403, {"error": "same_origin_required"})
            return
        if not self._authenticated():
            return
        notification = path == "/api/notification-preview"
        provider = (
            self.server.notification_provider
            if notification
            else self.server.dashboard_provider
        )
        self._serve_provider(provider, notification=notification)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._request_body_read = False
        if not self._host_is_loopback():
            self._send_json(400, {"error": "invalid_host"})
            return
        if not self._same_origin(required=True):
            self._send_json(403, {"error": "same_origin_required"})
            return
        path = self._request_path()
        if path is None:
            self._send_json(400, {"error": "invalid_request"})
            return
        if path == "/login":
            if self.server.shared_sessions is not None:
                try:
                    lengths = self.headers.get_all("Content-Length", [])
                    if len(lengths) != 1 or not lengths[0].isdecimal() or int(lengths[0]) > MAX_LOGIN_BODY_BYTES:
                        raise ValueError("invalid length")
                    payload = self._read_workspace_json()
                    if not isinstance(payload, dict) or set(payload) != {"login", "password"}:
                        raise ValueError("invalid fields")
                    login, password = payload["login"], payload["password"]
                    if not isinstance(login, str) or not isinstance(password, str):
                        raise ValueError("invalid fields")
                except (ValueError, UnicodeDecodeError, OverflowError):
                    self._send_json(400, {"error": "invalid_login_request"})
                    return
                client = resolve_client_address(
                    self.client_address[0], self.headers.get_all("X-Real-IP", []),
                    self.headers.get_all("X-Forwarded-For", []), self.server.trusted_proxies)
                # Count per client address and login so that failures from one
                # client cannot lock the same login out for other clients.
                throttle_key = f"{client}|{login}"
                if not self.server.shared_sessions.allowed_login(throttle_key):
                    self._send_json(429, {"error": "login_throttled"})
                    return
                try:
                    account = self.server.shared_accounts.authenticate(login, password)  # type: ignore[union-attr]
                    if account is None:
                        self.server.shared_sessions.record_failure(throttle_key)
                        self._send_json(401, {"error": "unauthorized"})
                        return
                    from deskly.workspace_service import WorkspaceService

                    assert self.server.shared_home is not None
                    assert self.server.shared_workspace_id is not None
                    assert self.server.shared_secret is not None
                    login_service = WorkspaceService(self.server.shared_home, self.server.shared_workspace_id,
                                                     secret=self.server.shared_secret,
                                                     identity=(self.server.shared_origin or "", account[0]))
                    login_service.principal()
                except WorkspaceError:
                    self.server.shared_sessions.record_failure(throttle_key)
                    self._send_json(401, {"error": "unauthorized"})
                    return
                except (OSError, sqlite3.Error, CredentialStoreError):
                    self._send_json(503, {"error": "auth_unavailable"})
                    return
                session_id = self.server.shared_sessions.create(*account)
                self.server.shared_sessions.record_success(throttle_key)
                cookie = (f"{SHARED_SESSION_COOKIE_NAME}={session_id}; Path=/; "
                          f"Max-Age=1800; Secure; HttpOnly; SameSite=Strict")
                self._send_json(200, {"authenticated": True},
                                extra_headers=(("Set-Cookie", cookie),))
                return
            password, status = self._read_login_password()
            if status != 200 or password is None:
                self._send_json(status, {"error": "invalid_login_request"})
                return
            supplied = password.encode("utf-8")
            if not hmac.compare_digest(supplied, self.server.password_bytes):
                self._send_json(401, {"error": "unauthorized"})
                return
            session_id = self.server.create_session()
            cookie = (
                f"{SESSION_COOKIE_NAME}={session_id}; Path=/; "
                f"Max-Age={SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict"
            )
            self._send_json(
                200,
                {"authenticated": True},
                extra_headers=(("Set-Cookie", cookie),),
            )
            return
        if path == "/logout":
            lengths = self.headers.get_all("Content-Length", [])
            transfer_encoding = self.headers.get_all("Transfer-Encoding", [])
            if transfer_encoding or (lengths and (len(lengths) != 1 or lengths[0] != "0")):
                self._send_json(400, {"error": "invalid_logout_request"})
                return
            logout_session_id = self._session_id()
            valid = (self.server.shared_sessions.subject(logout_session_id)
                     if self.server.shared_sessions and logout_session_id else
                     self.server.valid_session(logout_session_id) if logout_session_id else None)
            if not valid:
                self._send_json(401, {"error": "unauthorized"})
                return
            assert logout_session_id is not None
            if self.server.shared_sessions:
                self.server.shared_sessions.remove(logout_session_id)
            else:
                self.server.remove_session(logout_session_id)
            self._send_bytes(
                204,
                b"",
                "application/json; charset=utf-8",
                extra_headers=(
                    (
                        "Set-Cookie",
                        (f"{SHARED_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"
                         if self.server.shared_sessions else
                         f"{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"),
                    ),
                ),
            )
            return
        if path.startswith("/api/workspaces/"):
            if not self._authenticated():
                return
            try:
                service = self._workspace_service()
            except WorkspaceError as exc:
                self._send_json(exc.status, {"error": exc.code})
                return
            except (OSError, sqlite3.Error, CredentialStoreError):
                self._send_json(503, {"error": "workspace_unavailable"})
                return
            parts = path.strip("/").split("/")
            if (self.server.shared_sessions is not None and service is not None
                and len(parts) >= 5 and parts[2] == service.workspace_id
                and ((len(parts) == 5 and parts[3:] == ["sources", "contact"])
                     or (len(parts) == 7 and parts[3] == "projects"
                         and parts[5:] == ["contacts", "link"]))):
                from deskly.shared_contacts import link_project_contact, register_contact_source

                try:
                    payload = self._read_workspace_json()
                    if not isinstance(payload, dict):
                        raise WorkspaceError("invalid_request")
                    assert self.server.shared_home is not None
                    if parts[3:] == ["sources", "contact"]:
                        if set(payload) != {"label", "binding", "operation_id", "reason"}:
                            raise WorkspaceError("invalid_request")
                        result = register_contact_source(
                            self.server.shared_home, service, label=payload["label"],
                            binding=payload["binding"], operation_id=payload["operation_id"],
                            reason=payload["reason"],
                        )
                    else:
                        if set(payload) != {"source_id", "contact_id", "label",
                                            "operation_id", "reason"}:
                            raise WorkspaceError("invalid_request")
                        result = link_project_contact(
                            self.server.shared_home, service, parts[4],
                            source_id=payload["source_id"], contact_id=payload["contact_id"],
                            label=payload["label"], operation_id=payload["operation_id"],
                            reason=payload["reason"],
                        )
                    self._send_json(200, result)
                except OverflowError:
                    self._send_json(413, {"error": "body_too_large"})
                except WorkspaceError as exc:
                    self._send_json(exc.status, {"error": exc.code})
                except (OSError, sqlite3.Error, CredentialStoreError):
                    self._send_json(503, {"error": "workspace_unavailable"})
                except (ValueError, UnicodeDecodeError):
                    self._send_json(400, {"error": "invalid_request"})
                return
            if (self.server.shared_sessions is not None and service is not None
                and len(parts) >= 5 and parts[2] == service.workspace_id
                and parts[3] == "access"):
                try:
                    access = self._shared_access(service)
                    payload = self._read_workspace_json()
                    if not isinstance(payload, dict):
                        raise WorkspaceError("invalid_request")
                    if len(parts) == 5 and parts[4] == "grants":
                        if set(payload) != {"project_id", "member_id", "role", "expected_version",
                                            "operation_id", "reason"}:
                            raise WorkspaceError("invalid_request")
                        result = access.set_project_role(
                            payload["project_id"], payload["member_id"], payload["role"],
                            expected_version=payload["expected_version"],
                            operation_id=payload["operation_id"], reason=payload["reason"])
                    elif len(parts) == 5 and parts[4] == "source-grants":
                        if set(payload) != {"source_id", "member_id", "allowed", "expected_version",
                                            "operation_id", "reason"}:
                            raise WorkspaceError("invalid_request")
                        result = access.set_source_access(
                            payload["source_id"], payload["member_id"], payload["allowed"],
                            expected_version=payload["expected_version"],
                            operation_id=payload["operation_id"], reason=payload["reason"])
                    elif len(parts) == 7 and parts[4] == "members" and parts[6] == "deactivate":
                        if set(payload) != {"expected_version", "operation_id", "reason"}:
                            raise WorkspaceError("invalid_request")
                        expected_version = payload["expected_version"]
                        if isinstance(expected_version, bool) or expected_version not in {1, 2}:
                            raise WorkspaceError("version_conflict", 409)
                        from deskly.workspace_model import uuid_text

                        member_id = uuid_text(parts[5])
                        with service.store.connect() as db:
                            identity = db.execute("""SELECT i.subject,m.active FROM identities i
                                JOIN members m ON m.id=i.member_id AND m.workspace_id=i.workspace_id
                                WHERE i.workspace_id=? AND i.member_id=? AND i.issuer=?""",
                                (service.workspace_id, member_id, self.server.shared_origin)).fetchone()
                        if identity is None:
                            raise WorkspaceError("invalid_member", 403)
                        if identity["active"]:
                            if expected_version != 1:
                                raise WorkspaceError("version_conflict", 409)
                            result = access.deactivate_member(member_id,
                                expected_version=1, operation_id=payload["operation_id"],
                                reason=payload["reason"])
                        elif expected_version == 1:
                            # A transport retry with the original operation ID may
                            # replay the completed workspace step after the member
                            # row has already been deactivated.
                            result = access.deactivate_member(member_id,
                                operation_id=payload["operation_id"], reason=payload["reason"])
                        elif expected_version == 2:
                            result = {"member_id": member_id, "active": False,
                                      "credential_revocation_pending": True}
                        else:
                            raise WorkspaceError("version_conflict", 409)
                        assert self.server.shared_accounts is not None
                        if identity["subject"] in set(self.server.shared_accounts.active_subjects()):
                            self.server.shared_accounts.deactivate(identity["subject"])
                        credential_operation = str(uuid5(
                            NAMESPACE_URL, f"deskly:credential-revocation:{uuid_text(payload['operation_id'])}"
                        ))
                        revocation = access.record_credential_revocation(
                            member_id, operation_id=credential_operation,
                            reason=payload["reason"],
                        )
                        result.update(revocation)
                        result["credential_revocation_pending"] = False
                    else:
                        self._send_json(404, {"error": "not_found"})
                        return
                    self._send_json(200, result)
                except OverflowError:
                    self._send_json(413, {"error": "body_too_large"})
                except WorkspaceError as exc:
                    self._send_json(exc.status, {"error": exc.code})
                except (OSError, sqlite3.Error, CredentialStoreError):
                    self._send_json(503, {"error": "workspace_unavailable"})
                except (ValueError, UnicodeDecodeError):
                    self._send_json(400, {"error": "invalid_request"})
                return
            if service is None or len(parts) != 5 or parts[2] != service.workspace_id or (
                (parts[3] != "commands" or parts[4] not in {"preview", "apply"})
                and (parts[3], parts[4]) != ("sources", "fetch")
            ):
                self._send_json(404, {"error": "not_found"})
                return
            if self.server.shared_sessions is not None and parts[3] == "sources":
                self._send_json(404, {"error": "not_found"})
                return
            try:
                payload = self._read_workspace_json()
                if parts[3] == "sources":
                    if not isinstance(payload, dict) or set(payload) != {"project_id"}:
                        raise WorkspaceError("invalid_request")
                    result = service.fetch_sources(payload["project_id"])
                else:
                    if self.server.shared_sessions is not None and not self._shared_command_allowed(payload):
                        self._send_json(404, {"error": "not_found"})
                        return
                    result = service.preview(payload) if parts[4] == "preview" else service.apply(payload)
                    if self.server.shared_sessions is not None and not self._shared_command_allowed(result):
                        self._send_json(404, {"error": "not_found"})
                        return
                self._send_json(200, result)
            except OverflowError:
                self._send_json(413, {"error": "body_too_large"})
            except (ValueError, UnicodeDecodeError) as exc:
                if isinstance(exc, WorkspaceError):
                    self._send_json(exc.status, {"error": exc.code})
                else:
                    self._send_json(400, {"error": "invalid_request"})
            except (OSError, sqlite3.Error):
                self._send_json(503, {"error": "workspace_unavailable"})
            return
        self._method_not_allowed()


def _dashboard_password(environ: Mapping[str, str] | None) -> str:
    environment = os.environ if environ is None else environ
    password = environment.get(DASHBOARD_PASSWORD_ENV, "")
    if (
        not isinstance(password, str)
        or not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH
        or any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in password)
    ):
        raise DashboardConfigurationError(
            "DESKLY_DASHBOARD_PASSWORD is missing or invalid"
        )
    return password


def create_dashboard_server(
    *,
    host: str = DEFAULT_DASHBOARD_HOST,
    port: int = DEFAULT_DASHBOARD_PORT,
    environ: Mapping[str, str] | None = None,
    dashboard_provider: DashboardProvider | None = None,
    notification_provider: DashboardProvider | None = None,
    workspace_service: Any | None = None,
) -> DashboardHTTPServer:
    """Create a loopback-only server; providers are called only after login."""
    if host != DEFAULT_DASHBOARD_HOST:
        raise DashboardConfigurationError("dashboard host must be 127.0.0.1")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise DashboardConfigurationError("dashboard port is invalid")
    password = _dashboard_password(environ)
    if workspace_service is None:
        import secrets as workspace_secrets

        from deskly.config import deskly_home, workspace_settings
        from deskly.workspace_service import WorkspaceService

        settings = workspace_settings()
        if settings is not None:
            workspace_service = WorkspaceService(
                deskly_home(), settings["workspace_id"], secret=workspace_secrets.token_bytes(32)
            )
    return DashboardHTTPServer(
        (host, port),
        password,
        dashboard_provider,
        notification_provider,
        workspace_service,
    )


def create_shared_dashboard_server(
    *,
    home: Path,
    workspace_id: str,
    credential_store: Path,
    public_origin: str,
    host: str = "0.0.0.0",
    port: int = DEFAULT_DASHBOARD_PORT,
    trusted_proxies: str = "",
) -> DashboardHTTPServer:
    """Build the separate shared Web entrypoint behind an HTTPS reverse proxy.

    The caller must publish this port only to a private ingress network. This
    function never enables legacy dashboard/communication-ledger providers.
    ``trusted_proxies`` lists proxy addresses/CIDRs whose ``X-Real-IP`` /
    ``X-Forwarded-For`` are used for login throttling; empty disables them.
    """
    from deskly.workspace_model import uuid_text

    try:
        origin = urlsplit(public_origin)
        if (origin.scheme != "https" or not origin.hostname or origin.username is not None
            or origin.password is not None or origin.path or origin.query or origin.fragment
            or origin.port not in {None, 443} or public_origin != f"https://{origin.hostname}"):
            raise ValueError("invalid origin")
        workspace_id = uuid_text(workspace_id)
        if not home.is_absolute() or not credential_store.is_absolute():
            raise ValueError("paths must be absolute")
        if host not in {"0.0.0.0", "127.0.0.1"}:
            raise ValueError("invalid bind host")
        if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("invalid port")
        proxies = parse_trusted_proxies(trusted_proxies)
        accounts = LocalCredentialStore(credential_store)
    except (ValueError, CredentialStoreError) as exc:
        raise DashboardConfigurationError("shared Web configuration is invalid") from exc
    return DashboardHTTPServer((host, port), "", None, None, None,
                               shared_accounts=accounts, shared_home=home,
                               shared_workspace_id=workspace_id, shared_origin=public_origin,
                               trusted_proxies=proxies)


def serve_dashboard(
    *,
    host: str = DEFAULT_DASHBOARD_HOST,
    port: int = DEFAULT_DASHBOARD_PORT,
) -> None:
    """Run the authenticated dashboard on IPv4 loopback until interrupted."""
    server = create_dashboard_server(host=host, port=port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


__all__ = [
    "DEFAULT_DASHBOARD_HOST",
    "DEFAULT_DASHBOARD_PORT",
    "DASHBOARD_PASSWORD_ENV",
    "DashboardConfigurationError",
    "DashboardHTTPServer",
    "MAX_ACTIVE_REQUESTS",
    "MAX_PROVIDER_RESPONSE_BYTES",
    "MAX_SESSIONS",
    "create_dashboard_server",
    "create_shared_dashboard_server",
    "serve_dashboard",
]
