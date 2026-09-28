"""Tests for the dedicated, single-contact internal API capability."""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener

import pytest

from deskly import contact_read_client
from deskly.api_server import create_http_server
from deskly.contact_read_client import InternalContactReadClient
from deskly.model import Contact, validate_contact_id
from deskly.shared_contacts import _contact
from deskly.store import LedgerError, SqliteStore

GENERAL_TOKEN = "synthetic-general-api-token"
READ_TOKEN = "synthetic-single-contact-capability"


def _call(url: str, path: str, token: str, *, method: str = "GET",
          body: object | None = None) -> tuple[int, object, dict[str, str]]:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = Request(url + path, headers=headers, data=data, method=method)
    try:
        response = build_opener().open(request, timeout=3)
    except HTTPError as exc:
        response = exc
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if raw else None, dict(response.headers)


@pytest.fixture
def contact_api(tmp_path: Path):
    ledger_path = tmp_path / "ledger.sqlite3"
    with SqliteStore(ledger_path) as store:
        fields = Contact(
            id="c-20260928-00000011", project="SYN-A", recipient="Synthetic recipient",
            channel="email", sent_at="2026-09-28 09:00", state="送信済み",
            promise="Synthetic promise", agreement="Synthetic agreement",
            sensitive="Synthetic sensitive value", basis="Synthetic basis", note="Synthetic note",
            references="Synthetic references", shared_url="https://example.test/synthetic",
            body="Synthetic body", source_path="synthetic-private-path",
            source_hash="synthetic-source-hash", extra={"private": "synthetic-extra"},
        ).to_dict()
        fields.pop("created_at")
        fields.pop("updated_at")
        contact = store.create(fields)
    server = create_http_server(
        ledger_path, GENERAL_TOKEN, contact_read_token=READ_TOKEN,
        host="127.0.0.1", port=0, revision="synthetic-revision",
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", tmp_path, contact
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()


def test_dedicated_capability_returns_fixed_projection_and_cannot_list_search_or_write(
    contact_api,
) -> None:
    url, _home, contact = contact_api
    status, result, headers = _call(
        url, f"/internal/contacts/{contact.id}", READ_TOKEN,
    )
    assert status == 200 and headers["Cache-Control"] == "no-store"
    assert set(result) == contact_read_client.CONTACT_FIELDS
    assert result["id"] == contact.id and result["body"] == "Synthetic body"
    assert result["sensitive"] == "Synthetic sensitive value"
    for forbidden in ("source_path", "source_hash", "extra", "ledger", "token"):
        assert forbidden not in result

    # The restricted credential is not accepted by any general ledger capability.
    assert _call(url, "/contacts", READ_TOKEN)[0] == 401
    assert _call(url, "/search?q=synthetic", READ_TOKEN)[0] == 401
    assert _call(url, "/contacts", READ_TOKEN, method="POST", body={"fields": {}})[0] == 401
    assert _call(url, f"/contacts/{contact.id}", READ_TOKEN, method="PUT",
                 body={"changes": {"note": "forbidden"},
                       "expected_updated_at": contact.updated_at})[0] == 401
    assert _call(url, "/import", READ_TOKEN, method="POST", body={"rows": []})[0] == 401
    # The general token cannot invoke the restricted internal capability.
    assert _call(url, f"/internal/contacts/{contact.id}", GENERAL_TOKEN)[0] == 401


def test_shared_reader_uses_dedicated_token_without_general_api_token(
    contact_api, monkeypatch: pytest.MonkeyPatch,
) -> None:
    url, home, contact = contact_api
    (home / "config.toml").write_text(
        "\n".join((
            'default_ledger = "company"', "", "[[ledgers]]",
            'name = "company"', 'label = "Synthetic company"', 'storage = "server"',
            'url = "https://configured-url-is-not-used.example.invalid"',
            'token_env = "DESKLY_API_TOKEN"', "",
        )),
        encoding="utf-8",
    )
    monkeypatch.setenv("DESKLY_CONTACT_READ_TOKEN", READ_TOKEN)
    monkeypatch.delenv("DESKLY_API_TOKEN", raising=False)
    monkeypatch.setattr(contact_read_client, "INTERNAL_CONTACT_API_URL", url)

    loaded = _contact(home, "company", contact.id)
    assert loaded.id == contact.id
    assert loaded.body == "Synthetic body"
    assert "DESKLY_API_TOKEN" not in os.environ


def test_contact_read_client_rejects_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "https://redirect.example.invalid/target")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(contact_read_client, "INTERNAL_CONTACT_API_URL",
                        f"http://127.0.0.1:{server.server_port}")
    try:
        with pytest.raises(LedgerError, match="redirect refused"):
            InternalContactReadClient(READ_TOKEN).get(validate_contact_id("c-20260928-00000011"))
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()
