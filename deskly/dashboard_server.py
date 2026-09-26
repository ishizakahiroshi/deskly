"""Loopback-only HTTP boundary for Deskly's read-only dashboard."""

from __future__ import annotations

import hmac
import json
import os
import secrets
import socket
import time
from collections.abc import Callable, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from threading import BoundedSemaphore, RLock
from typing import Any
from urllib.parse import urlsplit

DEFAULT_DASHBOARD_HOST = "127.0.0.1"
DEFAULT_DASHBOARD_PORT = 8766
DASHBOARD_PASSWORD_ENV = "DESKLY_DASHBOARD_PASSWORD"
SESSION_COOKIE_NAME = "deskly_dashboard_session"
SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 64
MAX_LOGIN_BODY_BYTES = 4096
MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_ACTIVE_REQUESTS = 8
MIN_PASSWORD_LENGTH = 16
MAX_PASSWORD_LENGTH = 1024
STATIC_ASSETS = frozenset({"index.html", "app.css", "app.js"})
STATIC_CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
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
    ) -> None:
        super().__init__(address, DashboardRequestHandler)
        self.password_bytes = password.encode("utf-8")
        self.dashboard_provider = dashboard_provider
        self.notification_provider = notification_provider
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
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(
            status,
            body,
            "application/json; charset=utf-8",
            extra_headers=extra_headers,
        )

    def _host_is_loopback(self) -> bool:
        host_values = self.headers.get_all("Host", [])
        if len(host_values) != 1:
            return False
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
        for cookie in cookie_headers[0].split(";"):
            name, separator, value = cookie.strip().partition("=")
            if name != SESSION_COOKIE_NAME:
                continue
            if not separator or found is not None:
                return None
            found = value
        if found is None or not found or len(found) > 128:
            return None
        return found

    def _authenticated(self) -> bool:
        session_id = self._session_id()
        if session_id is not None and self.server.valid_session(session_id):
            return True
        self._send_json(401, {"error": "unauthorized"})
        return False

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
        if path not in {"/api/dashboard", "/api/notification-preview"}:
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
            if logout_session_id is None or not self.server.valid_session(logout_session_id):
                self._send_json(401, {"error": "unauthorized"})
                return
            self.server.remove_session(logout_session_id)
            self._send_bytes(
                204,
                b"",
                "application/json; charset=utf-8",
                extra_headers=(
                    (
                        "Set-Cookie",
                        f"{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
                    ),
                ),
            )
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
) -> DashboardHTTPServer:
    """Create a loopback-only server; providers are called only after login."""
    if host != DEFAULT_DASHBOARD_HOST:
        raise DashboardConfigurationError("dashboard host must be 127.0.0.1")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise DashboardConfigurationError("dashboard port is invalid")
    password = _dashboard_password(environ)
    return DashboardHTTPServer(
        (host, port),
        password,
        dashboard_provider,
        notification_provider,
    )


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
    "serve_dashboard",
]
