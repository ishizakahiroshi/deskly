from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from deskly import __version__
from deskly.api_server import create_http_server
from deskly.cli import main
from deskly.config import parse_config
from deskly.importer import run_import
from deskly.mcp_server import set_state as mcp_set_state
from deskly.model import STATE_DONE, STATE_WAITING
from deskly.remote_store import RemoteStore
from deskly.store import ConflictError, LedgerError, SqliteStore

TEST_TOKEN = "synthetic-test-token"


@contextmanager
def running_api(path: Path, *, token: str = TEST_TOKEN) -> Iterator[str]:
    server = create_http_server(
        path,
        token,
        host="127.0.0.1",
        port=0,
        revision="synthetic-revision",
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()


def _get_json(url: str, token: str | None = None) -> object:
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    with urlopen(Request(url, headers=headers), timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def _write_config(home: Path, *, local_path: Path, server_url: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.toml").write_text(
        "\n".join(
            (
                'default_ledger = "local"',
                "",
                "[[ledgers]]",
                'name = "local"',
                'label = "Local synthetic"',
                'storage = "local"',
                f"path = {json.dumps(str(local_path))}",
                "",
                "[[ledgers]]",
                'name = "remote"',
                'label = "Remote synthetic"',
                'storage = "server"',
                f"url = {json.dumps(server_url)}",
                'token_env = "DESKLY_API_TOKEN"',
                "",
            )
        ),
        encoding="utf-8",
    )


def _write_server_only_config(home: Path, *, server_url: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.toml").write_text(
        "\n".join(
            (
                'default_ledger = "company"',
                "",
                "[[ledgers]]",
                'name = "company"',
                'label = "Remote synthetic"',
                'storage = "server"',
                f"url = {json.dumps(server_url)}",
                'token_env = "DESKLY_API_TOKEN"',
                "",
            )
        ),
        encoding="utf-8",
    )


def test_healthz_is_public_and_other_routes_require_bearer_token(tmp_path: Path) -> None:
    ledger_path = tmp_path / "api.sqlite3"
    contact_id = "c-20260101-00000000"
    with running_api(ledger_path) as base_url:
        health = _get_json(f"{base_url}/healthz")
        assert health == {
            "status": "ok",
            "version": __version__,
            "revision": "synthetic-revision",
        }

        unauthorized_requests = [
            Request(f"{base_url}/contacts"),
            Request(f"{base_url}/contacts/{contact_id}"),
            Request(f"{base_url}/contacts/{contact_id}/history"),
            Request(f"{base_url}/search?q=synthetic"),
            Request(f"{base_url}/export"),
            Request(
                f"{base_url}/contacts",
                data=b'{"fields":{}}',
                method="POST",
            ),
            Request(f"{base_url}/import", data=b'{"rows":[]}', method="POST"),
            Request(
                f"{base_url}/contacts/{contact_id}",
                data=b'{"expected_updated_at":"synthetic","changes":{}}',
                method="PUT",
            ),
        ]
        for request in unauthorized_requests:
            with pytest.raises(HTTPError) as unauthenticated:
                urlopen(request, timeout=3)
            assert unauthenticated.value.code == 401

        with pytest.raises(HTTPError) as wrong_token:
            _get_json(f"{base_url}/contacts", "wrong-synthetic-token")
        assert wrong_token.value.code == 401

        with SqliteStore(ledger_path) as store:
            assert store.list_contacts() == [], "unauthenticated calls must not write contacts"


def test_remote_store_roundtrip_conflict_history_search_and_import(tmp_path: Path) -> None:
    with running_api(tmp_path / "source.sqlite3") as source_url:
        with running_api(tmp_path / "target.sqlite3") as target_url:
            with RemoteStore(source_url, TEST_TOKEN) as remote:
                created = remote.create(
                    {
                        "state": STATE_WAITING,
                        "project": "Synthetic Project",
                        "body": "Synthetic unique phrase",
                        "source_path": "synthetic/reply.txt",
                    },
                    actor="test",
                )
                assert remote.get(created.id) == created
                assert remote.find_by_source_path("synthetic/reply.txt") == created
                assert remote.list_contacts(states=[STATE_WAITING]) == [created]
                assert _get_json(f"{source_url}/search?q=unique", TEST_TOKEN)[0]["id"] == created.id

                updated = remote.update(
                    created.id,
                    {"note": "Synthetic note"},
                    expected_updated_at=created.updated_at,
                    actor="test",
                )
                with pytest.raises(ConflictError):
                    remote.update(
                        created.id,
                        {"note": "Stale update"},
                        expected_updated_at=created.updated_at,
                        actor="test",
                    )
                history = remote.history(created.id)
                assert [change.field for change in history] == ["_created", "note"]
                assert history[-1].actor == "test"
                rows = remote.export_rows()

            with RemoteStore(target_url, TEST_TOKEN) as target:
                counts = target.import_rows(rows)
                assert counts.contacts == 1
                assert counts.changes == 2
                assert target.export_rows() == rows
                assert target.get(updated.id).note == "Synthetic note"


def test_remote_store_rejects_invalid_contact_ids_before_request() -> None:
    remote = RemoteStore("http://127.0.0.1:1", TEST_TOKEN)
    with pytest.raises(ValueError):
        remote.get("../contacts")
    with pytest.raises(ValueError):
        remote.history("not-an-id")
    remote.close()


def test_remote_store_does_not_forward_token_through_redirect() -> None:
    received_authorization: list[str | None] = []

    class TargetHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            received_authorization.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, _format: str, *_args: object) -> None:
            return

    target = HTTPServer(("127.0.0.1", 0), TargetHandler)
    target_thread = threading.Thread(target=target.serve_forever, daemon=True)
    target_thread.start()
    target_url = f"http://127.0.0.1:{target.server_port}/contacts"

    class RedirectHandler(BaseHTTPRequestHandler):
        location = target_url

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self.send_response(307)
            self.send_header("Location", self.location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    redirect = HTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirect_thread = threading.Thread(target=redirect.serve_forever, daemon=True)
    redirect_thread.start()
    try:
        remote = RemoteStore(f"http://127.0.0.1:{redirect.server_port}", TEST_TOKEN)
        with pytest.raises(LedgerError):
            remote.list_contacts()
        assert received_authorization == []
    finally:
        redirect.shutdown()
        target.shutdown()
        redirect_thread.join(timeout=3)
        target_thread.join(timeout=3)
        redirect.server_close()
        target.server_close()


def test_cli_and_mcp_writes_route_to_server_ledger(
    isolate_deskly_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
) -> None:
    with running_api(tmp_path / "server.sqlite3") as server_url:
        _write_server_only_config(isolate_deskly_home, server_url=server_url)
        monkeypatch.setenv("DESKLY_API_TOKEN", TEST_TOKEN)
        with RemoteStore(server_url, TEST_TOKEN) as remote:
            contact = remote.create(
                {"state": STATE_WAITING, "project": "Synthetic Remote", "body": "Remote"},
                actor="test",
            )

        assert main(["waiting", "--json", "--today", "2026-09-26"]) == 0
        waiting_rows = json.loads(capsys.readouterr().out)
        assert waiting_rows[0]["contact_refs"] == [f"company/{contact.id}"]

        assert main(["set-state", contact.id, STATE_DONE]) == 0
        assert capsys.readouterr().out.startswith(f"{contact.id} ")
        with RemoteStore(server_url, TEST_TOKEN) as remote:
            current = remote.get(contact.id)
        preview = mcp_set_state(contact.id, STATE_WAITING)
        assert preview["preview"]["ledger"] == "company"
        applied = mcp_set_state(
            contact.id,
            STATE_WAITING,
            apply=True,
            expected_updated_at=current.updated_at,
        )
        assert applied["contact"]["state"] == STATE_WAITING
        with RemoteStore(server_url, TEST_TOKEN) as remote:
            assert [change.actor for change in remote.history(contact.id)] == [
                "test",
                "cli",
                "mcp",
            ]


def test_importer_dry_run_and_apply_use_remote_store(
    isolate_deskly_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "reply"
    source.mkdir()
    (source / "synthetic.txt").write_text(
        "状態: 回答待ち\n宛先: Synthetic Recipient\n案件: Synthetic Project\n\nSynthetic reply",
        encoding="utf-8",
    )
    exclusions = tmp_path / "excluded.csv"
    exclusions.write_text("synthetic_name\nExcluded Synthetic Person\n", encoding="utf-8")

    with running_api(tmp_path / "server.sqlite3") as server_url:
        monkeypatch.setenv("DESKLY_API_TOKEN", TEST_TOKEN)
        config = parse_config(
            {
                "default_ledger": "company",
                "ledgers": [
                    {
                        "name": "company",
                        "storage": "server",
                        "url": server_url,
                        "token_env": "DESKLY_API_TOKEN",
                    }
                ],
                "sources": [{"path": str(source), "ledger": "company"}],
                "excluded_recipients": {
                    "csv": str(exclusions),
                    "column": "synthetic_name",
                },
            }
        )
        dry_run = run_import(config, dry_run=True)
        assert dry_run.totals()["created"] == 1
        with RemoteStore(server_url, TEST_TOKEN) as remote:
            assert remote.list_contacts() == []

        applied = run_import(config)
        repeated = run_import(config)
        assert applied.totals()["created"] == 1
        assert repeated.totals()["unchanged"] == 1
        with RemoteStore(server_url, TEST_TOKEN) as remote:
            assert len(remote.list_contacts()) == 1


def test_move_ledger_copies_exact_rows_and_preserves_source(
    isolate_deskly_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    local_path = tmp_path / "source.sqlite3"
    with SqliteStore(local_path) as source:
        contact = source.create(
            {
                "id": "c-20260926-00000021",
                "state": STATE_WAITING,
                "project": "Synthetic Move",
                "body": "Synthetic migration content",
            },
            actor="test",
        )
        source.update(contact.id, {"note": "Synthetic history"}, actor="test")
        original_rows = source.export_rows()

    with running_api(tmp_path / "remote.sqlite3") as remote_url:
        _write_config(isolate_deskly_home, local_path=local_path, server_url=remote_url)
        monkeypatch.setenv("DESKLY_API_TOKEN", TEST_TOKEN)
        assert main(["move-ledger", "--from", "local", "--to", "remote"]) == 0
        output = capsys.readouterr().out
        assert "1 件" in output
        assert "synthetic-test-token" not in output

        with SqliteStore(local_path) as source:
            assert source.export_rows() == original_rows
        with RemoteStore(remote_url, TEST_TOKEN) as target:
            assert target.export_rows() == original_rows
            assert [item.id for item in target.list_contacts()] == [contact.id]


def test_serve_api_missing_token_stops_before_creating_ledger(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.delenv("DESKLY_API_TOKEN", raising=False)
    assert main(["serve-api", "--ledger", "company"]) == 1
    output = capsys.readouterr()
    assert "未設定" in output.err
    assert not (isolate_deskly_home / "ledger" / "company.sqlite3").exists()


def test_dockerfile_installs_release_wheel_and_keeps_data_in_volume() -> None:
    dockerfile = Path(__file__).parents[1] / "deploy" / "Dockerfile"
    content = dockerfile.read_text(encoding="utf-8")
    assert "COPY dist/*.whl /tmp/wheels/" in content
    assert "ENV DESKLY_HOME=/data" in content
    assert 'VOLUME ["/data"]' in content
    assert 'LABEL org.opencontainers.image.title="deskly"' in content
    assert '"serve-api", "--host", "0.0.0.0"' in content
