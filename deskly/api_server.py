"""loopback を既定とする標準ライブラリの認証付き LedgerStore API。"""

from __future__ import annotations

import hmac
import json
import os
import sqlite3
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from deskly import __version__
from deskly.model import InvalidStateError, validate_contact_id
from deskly.store import (
    ConflictError,
    DuplicateIdError,
    LedgerError,
    NotFoundError,
    SqliteStore,
)

MAX_REQUEST_BYTES = 1_048_576
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


class RequestTooLargeError(ValueError):
    """HTTP request body is over the configured size limit."""


class DesklyHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        ledger_path: Path,
        token: str,
        revision: str,
    ) -> None:
        super().__init__(address, DesklyRequestHandler)
        self.ledger_path = ledger_path
        self.auth_token = token
        self.revision = revision


class DesklyRequestHandler(BaseHTTPRequestHandler):
    server: DesklyHTTPServer

    def log_message(self, _format: str, *_args: object) -> None:
        # Request paths may contain search terms or contact IDs. Do not log them.
        return

    def _send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        scheme, separator, supplied = header.partition(" ")
        if scheme.casefold() != "bearer" or not separator:
            self._send_json(401, {"code": "unauthorized", "error": "Bearer token が必要です"})
            return False
        if not hmac.compare_digest(supplied, self.server.auth_token):
            self._send_json(401, {"code": "unauthorized", "error": "認証に失敗しました"})
            return False
        return True

    def _body_json(self) -> Any:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ValueError("Content-Length がありません")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ValueError("Content-Length が正しくありません") from exc
        if length < 0:
            raise ValueError("Content-Length が正しくありません")
        if length > MAX_REQUEST_BYTES:
            raise RequestTooLargeError("request body が大きすぎます")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("request body は UTF-8 JSON にしてください") from exc

    def _execute(self, operation: Callable[[], tuple[int, object]]) -> None:
        try:
            status, result = operation()
        except RequestTooLargeError as exc:
            self._send_json(413, {"code": "too_large", "error": str(exc)})
        except ConflictError as exc:
            self._send_json(
                409,
                {
                    "code": "conflict",
                    "error": str(exc),
                    "contact_id": exc.contact_id,
                    "expected": exc.expected,
                    "actual": exc.actual,
                },
            )
        except DuplicateIdError as exc:
            self._send_json(409, {"code": "duplicate_id", "error": str(exc)})
        except NotFoundError as exc:
            self._send_json(404, {"code": "not_found", "error": str(exc)})
        except InvalidStateError as exc:
            self._send_json(400, {"code": "invalid_state", "error": str(exc)})
        except (LedgerError, ValueError, TypeError, KeyError) as exc:
            self._send_json(400, {"code": "invalid_request", "error": str(exc)})
        except sqlite3.Error:
            self._send_json(500, {"code": "ledger_error", "error": "台帳の操作に失敗しました"})
        except Exception:
            # Do not return internal paths, SQL, or request data to the caller.
            self._send_json(500, {"code": "internal_error", "error": "内部エラーです"})
        else:
            self._send_json(status, result)

    @contextmanager
    def _store(self) -> Iterator[SqliteStore]:
        with SqliteStore(self.server.ledger_path) as store:
            yield store

    @staticmethod
    def _mapping(value: object, field: str) -> Mapping[str, Any]:
        if not isinstance(value, Mapping):
            raise ValueError(f"{field} は JSON object にしてください")
        return value

    @staticmethod
    def _contact_id(path_segment: str) -> str:
        return validate_contact_id(unquote(path_segment))

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if parsed.path == "/healthz":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": __version__,
                    "revision": self.server.revision,
                },
            )
            return
        if not self._authorized():
            return
        self._execute(lambda: self._get(parsed.path, parse_qs(parsed.query, keep_blank_values=True)))

    def _get(self, path: str, query: Mapping[str, list[str]]) -> tuple[int, object]:
        if path == "/contacts":
            source_path = query.get("source_path", [""])[0]
            states = query.get("state")
            with self._store() as store:
                if source_path:
                    contact = store.find_by_source_path(source_path)
                    contacts = [] if contact is None else [contact]
                    if states:
                        wanted = set(states)
                        contacts = [item for item in contacts if item.state in wanted]
                else:
                    contacts = store.list_contacts(states=states)
            return 200, [contact.to_dict() for contact in contacts]
        if path == "/search":
            query_text = query.get("q", [""])[0].strip().casefold()
            if not query_text:
                raise ValueError("q に検索語が必要です")
            raw_limit = query.get("limit", ["20"])[0]
            try:
                limit = int(raw_limit)
            except ValueError as exc:
                raise ValueError("limit は 1 から 100 にしてください") from exc
            if not 1 <= limit <= 100:
                raise ValueError("limit は 1 から 100 にしてください")
            fields = (
                "project",
                "recipient",
                "channel",
                "promise",
                "agreement",
                "basis",
                "note",
                "body",
            )
            with self._store() as store:
                matches = [
                    contact
                    for contact in store.list_contacts()
                    if any(query_text in getattr(contact, field).casefold() for field in fields)
                ][:limit]
            return 200, [contact.to_dict() for contact in matches]
        if path == "/export":
            with self._store() as store:
                rows = store.export_rows()
            return 200, rows

        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "contacts" and parts[2] == "history":
            contact_id = self._contact_id(parts[1])
            with self._store() as store:
                changes = store.history(contact_id)
            return 200, [change.to_dict() for change in changes]
        if len(parts) == 2 and parts[0] == "contacts":
            contact_id = self._contact_id(parts[1])
            with self._store() as store:
                contact = store.get(contact_id)
            return 200, contact.to_dict()
        raise NotFoundError("API path が見つかりません")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._authorized():
            return
        parsed = urlsplit(self.path)
        self._execute(lambda: self._post(parsed.path, self._body_json()))

    def _post(self, path: str, value: object) -> tuple[int, object]:
        payload = self._mapping(value, "request body")
        if path == "/contacts":
            fields = self._mapping(payload.get("fields", {}), "fields")
            actor = payload.get("actor", "api")
            if not isinstance(actor, str) or not actor:
                raise ValueError("actor は空でない文字にしてください")
            with self._store() as store:
                contact = store.create(fields, actor=actor)
            return 201, {"contact": contact.to_dict()}
        if path == "/import":
            rows = payload.get("rows")
            if not isinstance(rows, list) or not all(isinstance(row, Mapping) for row in rows):
                raise ValueError("rows は JSON object の配列にしてください")
            with self._store() as store:
                counts = store.import_rows(rows)
            return 200, {"contacts": counts.contacts, "changes": counts.changes}
        raise NotFoundError("API path が見つかりません")

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._authorized():
            return
        parsed = urlsplit(self.path)
        self._execute(lambda: self._put(parsed.path, self._body_json()))

    def _put(self, path: str, value: object) -> tuple[int, object]:
        parts = path.strip("/").split("/")
        if len(parts) != 2 or parts[0] != "contacts":
            raise NotFoundError("API path が見つかりません")
        contact_id = self._contact_id(parts[1])
        payload = self._mapping(value, "request body")
        changes = self._mapping(payload.get("changes"), "changes")
        expected_updated_at = payload.get("expected_updated_at")
        actor = payload.get("actor", "api")
        if not isinstance(expected_updated_at, str) or not expected_updated_at:
            raise ValueError("expected_updated_at が必要です")
        if not isinstance(actor, str) or not actor:
            raise ValueError("actor は空でない文字にしてください")
        with self._store() as store:
            contact = store.update(
                contact_id,
                changes,
                expected_updated_at=expected_updated_at,
                actor=actor,
            )
        return 200, {"contact": contact.to_dict()}


def resolve_revision() -> str:
    """DESKLY_REVISION または RELEASE JSON から revision だけ読む。"""
    direct = os.environ.get("DESKLY_REVISION", "").strip()
    if direct:
        return direct
    manifest = os.environ.get("DESKLY_REVISION_FILE", "").strip()
    if not manifest:
        return "unknown"
    try:
        content = json.loads(Path(manifest).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return "unknown"
    revision = content.get("revision") if isinstance(content, Mapping) else None
    if isinstance(revision, str) and revision and "\n" not in revision and "\r" not in revision:
        return revision
    return "unknown"


def create_http_server(
    ledger_path: str | Path,
    token: str,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    revision: str | None = None,
) -> DesklyHTTPServer:
    """test や埋め込み用に server を作る。token が無い場合は起動しない。"""
    if not token:
        raise ValueError("API token が未設定のため起動できません")
    if not host:
        raise ValueError("host が空です")
    path = Path(ledger_path)
    # 認証が設定されてから、サービス用台帳を初期化する。
    with SqliteStore(path):
        pass
    return DesklyHTTPServer(
        (host, port),
        path,
        token,
        revision if revision is not None else resolve_revision(),
    )


def serve_api(
    ledger_path: str | Path,
    token: str,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    revision: str | None = None,
) -> None:
    """HTTP server を起動し、停止時は socket を閉じる。"""
    server = create_http_server(
        ledger_path,
        token,
        host=host,
        port=port,
        revision=revision,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DesklyHTTPServer",
    "create_http_server",
    "resolve_revision",
    "serve_api",
]
