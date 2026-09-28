"""Fixed, least-privilege client for the internal single-contact capability."""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from deskly.model import Contact, validate_contact_id
from deskly.store import LedgerError, NotFoundError

INTERNAL_CONTACT_API_URL = "http://app:8765"
MAX_RESPONSE_BYTES = 256 * 1024
CONTACT_FIELDS = frozenset({
    "id", "project", "recipient", "channel", "sent_at", "state", "due",
    "updated_at", "promise", "agreement", "sensitive", "basis", "note", "references",
    "shared_url", "body",
})


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class InternalContactReadClient:
    """Read one explicitly requested contact using its dedicated capability token."""

    def __init__(self, token: str, *, timeout: float = 5.0) -> None:
        if not token:
            raise ValueError("contact read token is not configured")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self._token = token
        self._timeout = timeout

    def get(self, contact_id: str) -> Contact:
        valid_id = validate_contact_id(contact_id)
        request = Request(
            f"{INTERNAL_CONTACT_API_URL}/internal/contacts/{quote(valid_id, safe='')}",
            headers={"Accept": "application/json", "Authorization": f"Bearer {self._token}"},
            method="GET",
        )
        opener = build_opener(_RejectRedirects)
        try:
            with opener.open(request, timeout=self._timeout) as response:
                if response.geturl() != request.full_url:
                    raise LedgerError("internal contact API redirect refused")
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if exc.code == 404:
                raise NotFoundError("contact not found") from exc
            if exc.code in {301, 302, 303, 307, 308}:
                raise LedgerError("internal contact API redirect refused") from exc
            raise LedgerError("internal contact API request failed") from exc
        except (TimeoutError, URLError, OSError) as exc:
            raise LedgerError("internal contact API is unavailable") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise LedgerError("internal contact API response is too large")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LedgerError("internal contact API response is invalid") from exc
        if not isinstance(payload, dict) or set(payload) != CONTACT_FIELDS:
            raise LedgerError("internal contact API response fields are invalid")
        try:
            return Contact(**payload)
        except (TypeError, ValueError) as exc:
            raise LedgerError("internal contact API response is invalid") from exc


__all__ = ["CONTACT_FIELDS", "INTERNAL_CONTACT_API_URL", "InternalContactReadClient"]
