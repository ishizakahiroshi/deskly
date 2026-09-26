"""標準ライブラリ urllib で LedgerStore API を呼ぶ remote 置き場。"""

from __future__ import annotations

import json
from collections.abc import Collection, Iterable, Mapping
from typing import Any, Self
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from deskly.model import Contact, validate_contact_id
from deskly.store import (
    Change,
    ConflictError,
    DuplicateIdError,
    ImportCounts,
    LedgerError,
    NotFoundError,
)

DEFAULT_TIMEOUT_SECONDS = 10.0


class _RejectRedirects(HTTPRedirectHandler):
    """認証ヘッダーを別 URL へ転送しない。"""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class RemoteStore:
    """認証付き API 上の台帳。トークンは属性にのみ保持し、ログや例外へ出さない。"""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        clean_url = base_url.rstrip("/")
        try:
            parsed = urlsplit(clean_url)
            port = parsed.port
        except ValueError as exc:
            raise ValueError("API の URL は正しい http(s) URL にしてください") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username is not None
            or parsed.password is not None
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError("API の URL は認証情報を含まない http(s) のルート URL にしてください")
        if parsed.scheme == "http" and parsed.hostname.casefold() not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            raise ValueError("API の http は loopback だけにできます")
        if not token:
            raise ValueError("API token が空です")
        if timeout <= 0:
            raise ValueError("timeout は 0 より大きくしてください")
        self.base_url = clean_url
        self._token = token
        self.timeout = timeout

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        """urllib は request ごとに接続を閉じるため何もしない。"""

    @staticmethod
    def _contact(data: Mapping[str, Any]) -> Contact:
        try:
            return Contact(**data)
        except (TypeError, ValueError) as exc:
            raise LedgerError("server API の連絡データが正しくありません") from exc

    @staticmethod
    def _json_body(data: object) -> bytes:
        return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _raise_http_error(self, status: int, payload: object) -> None:
        data = payload if isinstance(payload, Mapping) else {}
        message_value = data.get("error")
        message = message_value if isinstance(message_value, str) else "server API の要求が失敗しました"
        code = data.get("code")
        if status == 401:
            raise LedgerError("server API の認証に失敗しました")
        if status == 404:
            raise NotFoundError(message)
        if status == 409 and code == "conflict":
            contact_id = data.get("contact_id")
            expected = data.get("expected")
            actual = data.get("actual")
            if (
                isinstance(contact_id, str)
                and isinstance(expected, str)
                and isinstance(actual, str)
            ):
                raise ConflictError(contact_id, expected, actual)
        if status == 409 and code == "duplicate_id":
            raise DuplicateIdError(message)
        if status >= 500:
            raise LedgerError("server API 内部で台帳操作に失敗しました")
        raise LedgerError(message)

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, str | Collection[str]] | None = None,
        payload: object | None = None,
    ) -> Any:
        suffix = f"?{urlencode(query, doseq=True)}" if query else ""
        request = Request(
            f"{self.base_url}{path}{suffix}",
            data=None if payload is None else self._json_body(payload),
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._token}",
                **({"Content-Type": "application/json"} if payload is not None else {}),
            },
        )
        opener = build_opener(_RejectRedirects)
        try:
            with opener.open(request, timeout=self.timeout) as response:
                body = response.read()
        except HTTPError as exc:
            try:
                error_payload = json.loads(exc.read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                error_payload = None
            self._raise_http_error(exc.code, error_payload)
        except (TimeoutError, URLError, OSError) as exc:
            raise LedgerError("server API に接続できません") from exc
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LedgerError("server API の応答が JSON ではありません") from exc

    def create(self, fields: Mapping[str, Any] | None = None, *, actor: str = "unknown") -> Contact:
        result = self._request(
            "POST",
            "/contacts",
            payload={"fields": dict(fields or {}), "actor": actor},
        )
        if not isinstance(result, Mapping) or not isinstance(result.get("contact"), Mapping):
            raise LedgerError("server API の作成応答が正しくありません")
        return self._contact(result["contact"])

    def get(self, contact_id: str) -> Contact:
        valid_id = validate_contact_id(contact_id)
        result = self._request("GET", f"/contacts/{valid_id}")
        if not isinstance(result, Mapping):
            raise LedgerError("server API の連絡応答が正しくありません")
        return self._contact(result)

    def find_by_source_path(self, source_path: str) -> Contact | None:
        if not source_path:
            return None
        result = self._request("GET", "/contacts", query={"source_path": source_path})
        if not isinstance(result, list):
            raise LedgerError("server API の一覧応答が正しくありません")
        return self._contact(result[0]) if result else None

    def list_contacts(self, *, states: Collection[str] | None = None) -> list[Contact]:
        if states is not None and not states:
            return []
        query: dict[str, str | Collection[str]] = {}
        if states is not None:
            query["state"] = tuple(states)
        result = self._request("GET", "/contacts", query=query)
        if not isinstance(result, list) or not all(isinstance(item, Mapping) for item in result):
            raise LedgerError("server API の一覧応答が正しくありません")
        return [self._contact(item) for item in result]

    def update(
        self,
        contact_id: str,
        changes: Mapping[str, Any],
        *,
        expected_updated_at: str | None = None,
        actor: str = "unknown",
    ) -> Contact:
        valid_id = validate_contact_id(contact_id)
        if not expected_updated_at:
            raise ValueError("server API の更新には expected_updated_at が必要です")
        result = self._request(
            "PUT",
            f"/contacts/{valid_id}",
            payload={
                "changes": dict(changes),
                "expected_updated_at": expected_updated_at,
                "actor": actor,
            },
        )
        if not isinstance(result, Mapping) or not isinstance(result.get("contact"), Mapping):
            raise LedgerError("server API の更新応答が正しくありません")
        return self._contact(result["contact"])

    def history(self, contact_id: str) -> list[Change]:
        valid_id = validate_contact_id(contact_id)
        result = self._request("GET", f"/contacts/{valid_id}/history")
        if not isinstance(result, list) or not all(isinstance(item, Mapping) for item in result):
            raise LedgerError("server API の履歴応答が正しくありません")
        try:
            return [Change(**item) for item in result]
        except TypeError as exc:
            raise LedgerError("server API の履歴データが正しくありません") from exc

    def export_rows(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/export")
        if not isinstance(result, list) or not all(isinstance(item, Mapping) for item in result):
            raise LedgerError("server API の書き出し応答が正しくありません")
        return [dict(item) for item in result]

    def import_rows(self, rows: Iterable[Mapping[str, Any]]) -> ImportCounts:
        result = self._request("POST", "/import", payload={"rows": [dict(row) for row in rows]})
        if not isinstance(result, Mapping):
            raise LedgerError("server API の取り込み応答が正しくありません")
        try:
            return ImportCounts(contacts=int(result["contacts"]), changes=int(result["changes"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise LedgerError("server API の取り込み件数が正しくありません") from exc


__all__ = ["RemoteStore"]
