"""Read-only client for issuepost's paged case-list API."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from deskly.config import IssuepostSettings, validate_issuepost_url

PAGE_LIMIT = 200
MAX_PAGES = 100
REQUEST_TIMEOUT_SECONDS = 10
MAX_TOTAL_RUNTIME_SECONDS = 30
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_RESPONSE_BYTES = 32 * 1024 * 1024


class IssuepostError(Exception):
    """Base class for safe issuepost client errors."""


class IssuepostAuthError(IssuepostError):
    """The endpoint rejected the configured credential."""


class IssuepostNetworkError(IssuepostError):
    """The endpoint could not be reached or returned an HTTP error."""


class IssuepostSchemaError(IssuepostError):
    """The endpoint response did not match the case-list contract."""


@dataclass(frozen=True)
class IssuepostCase:
    """The six fields used by Deskly's case view; all other API fields are discarded."""

    number: str
    title: str
    status: str
    approval_state: str
    promised_due: str | None
    hold_until: str | None


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> Request | None:
        del request, file_pointer, code, message, headers, new_url
        return None


def _required_text(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise IssuepostSchemaError("issuepost case has an invalid required text field")
    return value


def _optional_text(data: dict[str, Any], key: str) -> str | None:
    if key not in data or data[key] is None or data[key] == "":
        return None
    value = data[key]
    if not isinstance(value, str):
        raise IssuepostSchemaError("issuepost case has an invalid optional text field")
    return value


def _date_text(data: dict[str, Any], key: str) -> str | None:
    value = _optional_text(data, key)
    if value is None:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise IssuepostSchemaError("issuepost case has an invalid date field") from None
    if parsed.isoformat() != value:
        raise IssuepostSchemaError("issuepost case has an invalid date field")
    return value


def _parse_case(value: object) -> IssuepostCase:
    if not isinstance(value, dict):
        raise IssuepostSchemaError("issuepost case list contains a non-object item")

    return IssuepostCase(
        number=_required_text(value, "number"),
        title=_required_text(value, "title"),
        status=_required_text(value, "status"),
        approval_state=_required_text(value, "approval_state"),
        promised_due=_date_text(value, "promised_due"),
        hold_until=_date_text(value, "hold_until"),
    )


class IssuepostClient:
    """Fetch all cases through GET only, following issuepost's opaque page cursor."""

    def __init__(
        self,
        settings: IssuepostSettings,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self._url = validate_issuepost_url(settings.url)
        environment = os.environ if environ is None else environ
        token = environment.get(settings.token_env, "")
        if not isinstance(token, str) or not token:
            raise IssuepostAuthError("issuepost token environment variable is unset")
        try:
            token.encode("ascii")
        except UnicodeEncodeError:
            raise IssuepostAuthError("issuepost token is invalid") from None
        if any(ord(char) < 0x20 or ord(char) == 0x7F for char in token):
            raise IssuepostAuthError("issuepost token is invalid")
        self._token = token
        self._opener = build_opener(ProxyHandler({}), _RejectRedirects())

    def list_cases(self) -> tuple[IssuepostCase, ...]:
        deadline = time.monotonic() + MAX_TOTAL_RUNTIME_SECONDS
        cases: list[IssuepostCase] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        pages_read = 0
        total_response_bytes = 0
        while True:
            remaining_runtime = deadline - time.monotonic()
            if remaining_runtime <= 0:
                raise IssuepostNetworkError("issuepost case-list exceeded its time limit")
            remaining_bytes = MAX_TOTAL_RESPONSE_BYTES - total_response_bytes
            if remaining_bytes <= 0:
                raise IssuepostSchemaError("issuepost case-list exceeded the response size limit")
            page, payload_size = self._get_page(
                cursor,
                remaining_bytes=remaining_bytes,
                timeout=min(REQUEST_TIMEOUT_SECONDS, remaining_runtime),
            )
            total_response_bytes += payload_size
            pages_read += 1
            raw_cases = page.get("cases")
            if not isinstance(raw_cases, list) or len(raw_cases) > PAGE_LIMIT:
                raise IssuepostSchemaError("issuepost case-list response has an invalid cases field")
            cases.extend(_parse_case(item) for item in raw_cases)

            if "next_cursor" not in page:
                return tuple(cases)
            next_cursor = page["next_cursor"]
            if not isinstance(next_cursor, str) or next_cursor == "":
                raise IssuepostSchemaError("issuepost case-list response has an invalid cursor")
            if next_cursor in seen_cursors:
                raise IssuepostSchemaError("issuepost case-list cursor repeated")
            if pages_read == MAX_PAGES:
                raise IssuepostSchemaError("issuepost case-list exceeded the page limit")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def _get_page(
        self, cursor: str | None, *, remaining_bytes: int, timeout: float
    ) -> tuple[dict[str, Any], int]:
        query = {"limit": str(PAGE_LIMIT)}
        if cursor is not None:
            query["cursor"] = cursor
        url = f"{self._url}/v1/cases?{urlencode(query)}"
        request = Request(
            url,
            headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
            method="GET",
        )
        if remaining_bytes <= 0:
            raise IssuepostSchemaError("issuepost case-list exceeded the response size limit")
        read_limit = min(MAX_RESPONSE_BYTES, remaining_bytes)
        try:
            with self._opener.open(request, timeout=timeout) as response:
                payload = response.read(read_limit + 1)
        except HTTPError as exc:
            if exc.code in {401, 403}:
                raise IssuepostAuthError("issuepost rejected the configured credential") from None
            raise IssuepostNetworkError(f"issuepost returned HTTP {exc.code}") from None
        except (URLError, TimeoutError, OSError):
            raise IssuepostNetworkError("issuepost request failed") from None

        if len(payload) > MAX_RESPONSE_BYTES:
            raise IssuepostSchemaError("issuepost response exceeded the size limit")
        if len(payload) > remaining_bytes:
            raise IssuepostSchemaError("issuepost case-list exceeded the response size limit")
        try:
            data = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise IssuepostSchemaError("issuepost response is not valid JSON") from None
        if not isinstance(data, dict):
            raise IssuepostSchemaError("issuepost case-list response is not an object")
        return data, len(payload)


__all__ = [
    "IssuepostAuthError",
    "IssuepostCase",
    "IssuepostClient",
    "IssuepostError",
    "IssuepostNetworkError",
    "IssuepostSchemaError",
    "MAX_PAGES",
    "MAX_TOTAL_RUNTIME_SECONDS",
    "MAX_TOTAL_RESPONSE_BYTES",
]
