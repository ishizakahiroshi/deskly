from __future__ import annotations

import asyncio
import builtins
import json
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from deskly.cli import main
from deskly.config import LEDGER_COMPANY, ledger_path
from deskly.ledgers import load_ledgers
from deskly.mcp_server import (
    add_draft,
    export_text,
    record_reply,
    search_contacts,
    set_state,
    show_contact,
    waiting,
)
from deskly.model import STATE_DONE, STATE_IN_PROGRESS, STATE_WAITING
from deskly.store import ConflictError, SqliteStore
from deskly.views import build_waiting_rows


@contextmanager
def _case_server(
    body: bytes, *, status: int = 200
) -> Iterator[tuple[str, list[tuple[str, str | None]]]]:
    requests: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append((self.command, self.headers.get("Authorization")))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format_string: str, *args: Any) -> None:
            del format_string, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def _write_case_config(home: Path, *, url: str, ledger_path: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    config = "\n".join(
        (
            'default_ledger = "company"',
            "",
            "[[ledgers]]",
            'name = "company"',
            'label = "Synthetic ledger"',
            'storage = "local"',
            f"path = {json.dumps(str(ledger_path))}",
            "",
            "[issuepost]",
            f"url = {json.dumps(url)}",
            'token_env = "ISSUEPOST_TEST_TOKEN"',
            "",
            "[issuepost.turn_mapping.status]",
            '"synthetic-open" = "対応中"',
            "",
        )
    )
    (home / "config.toml").write_text(config, encoding="utf-8")


def _tool_payload(result: Any) -> dict[str, Any]:
    if result.structuredContent is not None:
        return result.structuredContent
    return json.loads(result.content[0].text)


def test_write_tools_preview_without_writing_and_require_apply_preconditions(
    isolate_deskly_home: Path,
) -> None:
    path = ledger_path(LEDGER_COMPANY)
    preview = add_draft(project="Synthetic Project", body="Synthetic draft")
    assert preview == {
        "applied": False,
        "expected_updated_at": "new",
        "preview": {
            "ledger": "company",
            "ledger_label": "company",
            "state": "下書き",
            "project": "Synthetic Project",
            "body": "Synthetic draft",
        },
    }
    assert not path.exists()

    with pytest.raises(ValueError, match="expected_updated_at='new'"):
        add_draft(project="Synthetic Project", apply=True)
    assert not path.exists()

    created = add_draft(
        project="Synthetic Project",
        body="Synthetic draft",
        apply=True,
        expected_updated_at="new",
    )
    assert created["applied"] is True
    contact = created["contact"]
    assert contact["state"] == "下書き"

    state_preview = set_state(contact["id"], STATE_WAITING)
    assert state_preview["applied"] is False
    assert state_preview["expected_updated_at"] == contact["updated_at"]
    assert state_preview["preview"]["to_state"] == STATE_WAITING

    with pytest.raises(ValueError, match="expected_updated_at"):
        set_state(contact["id"], STATE_WAITING, apply=True)
    with pytest.raises(ConflictError):
        set_state(
            contact["id"],
            STATE_WAITING,
            apply=True,
            expected_updated_at="stale-version",
        )

    updated = set_state(
        contact["id"],
        STATE_WAITING,
        apply=True,
        expected_updated_at=contact["updated_at"],
    )
    assert updated["contact"]["state"] == STATE_WAITING

    reply_preview = record_reply(contact["id"], "Synthetic reply summary")
    assert reply_preview["applied"] is False
    assert reply_preview["expected_updated_at"] == updated["contact"]["updated_at"]
    assert reply_preview["preview"]["state"] == STATE_IN_PROGRESS
    assert "返信要約" not in json.dumps(show_contact(contact["id"]), ensure_ascii=False)

    applied_reply = record_reply(
        contact["id"],
        "Synthetic reply summary",
        apply=True,
        expected_updated_at=updated["contact"]["updated_at"],
    )
    assert applied_reply["contact"]["state"] == STATE_IN_PROGRESS
    assert applied_reply["contact"]["note"] == "返信要約: Synthetic reply summary"

    with SqliteStore(path) as store:
        history = store.history(contact["id"])
        assert [change.actor for change in history] == ["mcp", "mcp", "mcp", "mcp"]
        assert [change.field for change in history] == ["_created", "state", "note", "state"]


def test_read_tools_match_waiting_view_and_search_without_writing(
    isolate_deskly_home: Path,
) -> None:
    path = ledger_path(LEDGER_COMPANY)
    assert waiting(today="2026-09-26") == []
    assert search_contacts("synthetic") == []
    assert not path.exists()

    with SqliteStore(path) as store:
        first = store.create(
            {
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "recipient": "Synthetic Recipient",
                "body": "Synthetic message body",
            }
        )
        second = store.create(
            {"state": STATE_DONE, "project": "Synthetic Project", "body": "Archived item"}
        )
        expected = [
            row.to_dict()
            for row in build_waiting_rows(
                load_ledgers().list_contacts(), today=date(2026, 9, 26)
            )
        ]

    assert waiting(today="2026-09-26") == expected
    assert waiting(include_all=True, today="2026-09-26") == [
        row.to_dict()
        for row in build_waiting_rows(
            load_ledgers().list_contacts(),
            today=date(2026, 9, 26),
            include_all=True,
        )
    ]
    results = search_contacts("SYNTHETIC recipient")
    assert [item["id"] for item in results] == [first.id]
    assert show_contact(second.id)["state"] == STATE_DONE
    assert export_text(first.id) == "Synthetic message body"


def test_mcp_tool_registration_and_in_memory_protocol_call(isolate_deskly_home: Path) -> None:
    pytest.importorskip("mcp")
    from mcp.shared.memory import create_connected_server_and_client_session

    from deskly.mcp_server import create_server

    async def exercise() -> None:
        async with create_connected_server_and_client_session(create_server()) as client:
            available = await client.list_tools()
            names = {tool.name for tool in available.tools}
            assert names == {
                "waiting",
                "list_cases",
                "show_contact",
                "search_contacts",
                "add_draft",
                "set_state",
                "record_reply",
                "export_text",
            }
            result = await client.call_tool("waiting", {"today": "2026-09-26"})
            assert result.isError is not True
            cases = await client.call_tool("list_cases", {})
            assert cases.isError is not True
            assert _tool_payload(cases) == {
                "status": "not_connected",
                "view": None,
                "error": None,
            }

    asyncio.run(exercise())


def test_mcp_list_cases_matches_cli_and_does_not_write_contacts(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    pytest.importorskip("mcp")
    from mcp.shared.memory import create_connected_server_and_client_session

    from deskly.mcp_server import create_server

    token = "synthetic-issuepost-token"
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", token)
    ledger_path = tmp_path / "company.sqlite3"
    with SqliteStore(ledger_path) as store:
        linked = store.create(
            {
                "state": STATE_WAITING,
                "project": "synthetic-case-1",
                "due": "2026-10-03",
                "body": "synthetic private contact body",
            }
        )
        unlinked = store.create(
            {
                "state": STATE_IN_PROGRESS,
                "project": "synthetic-unlinked-case",
                "body": "another synthetic private body",
            }
        )
        history_before = {
            linked.id: store.history(linked.id),
            unlinked.id: store.history(unlinked.id),
        }

    case_payload = {
        "cases": [
            {
                "number": "synthetic-case-1",
                "title": "Synthetic case title",
                "status": "synthetic-open",
                "approval_state": "synthetic-approval",
                "promised_due": "2026-10-02",
                "hold_until": "2026-10-04",
                "body": "synthetic private issuepost body",
            }
        ]
    }
    with _case_server(json.dumps(case_payload).encode("utf-8")) as (url, requests):
        _write_case_config(isolate_deskly_home, url=url, ledger_path=ledger_path)
        assert main(["cases", "--json"]) == 0
        cli_payload = json.loads(capsys.readouterr().out)

        async def exercise() -> dict[str, Any]:
            async with create_connected_server_and_client_session(create_server()) as client:
                tools = await client.list_tools()
                assert "list_cases" in {tool.name for tool in tools.tools}
                result = await client.call_tool("list_cases", {})
                assert result.isError is not True
                return _tool_payload(result)

        mcp_payload = asyncio.run(exercise())

    assert mcp_payload == cli_payload
    assert cli_payload["status"] == "connected"
    assert cli_payload["view"]["cases"] == [
        {
            "number": "synthetic-case-1",
            "title": "Synthetic case title",
            "status": "synthetic-open",
            "approval_state": "synthetic-approval",
            "promised_due": "2026-10-02",
            "hold_until": "2026-10-04",
            "turn": "対応中",
            "linked_contacts": [
                {
                    "contact_id": linked.id,
                    "project": "synthetic-case-1",
                    "state": STATE_WAITING,
                    "due": "2026-10-03",
                    "ledger_name": "company",
                }
            ],
        }
    ]
    assert [
        item["contact_id"] for item in cli_payload["view"]["unlinked_contacts"]
    ] == [unlinked.id]
    serialized = json.dumps(cli_payload, ensure_ascii=False)
    assert "synthetic private contact body" not in serialized
    assert "another synthetic private body" not in serialized
    assert "synthetic private issuepost body" not in serialized
    assert requests == [("GET", f"Bearer {token}")] * 2
    with SqliteStore(ledger_path) as store:
        assert store.history(linked.id) == history_before[linked.id]
        assert store.history(unlinked.id) == history_before[unlinked.id]


@pytest.mark.parametrize(
    ("status", "body", "expected_status"),
    [
        (401, b"", "auth_error"),
        (503, b"", "network_error"),
        (200, b"synthetic schema failure body", "schema_error"),
    ],
)
def test_mcp_list_cases_returns_safe_issuepost_error_statuses(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    status: int,
    body: bytes,
    expected_status: str,
) -> None:
    pytest.importorskip("mcp")
    from mcp.shared.memory import create_connected_server_and_client_session

    from deskly.mcp_server import create_server

    token = "synthetic-issuepost-token"
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", token)
    ledger_path = tmp_path / "company.sqlite3"

    with _case_server(body, status=status) as (url, requests):
        _write_case_config(isolate_deskly_home, url=url, ledger_path=ledger_path)

        async def exercise() -> dict[str, Any]:
            async with create_connected_server_and_client_session(create_server()) as client:
                result = await client.call_tool("list_cases", {})
                assert result.isError is not True
                return _tool_payload(result)

        payload = asyncio.run(exercise())

    assert payload["status"] == expected_status
    assert payload["view"] is None
    assert payload["error"]
    serialized = json.dumps(payload, ensure_ascii=False)
    assert token not in serialized
    if body:
        assert body.decode("utf-8", errors="ignore") not in serialized
    assert requests == [("GET", f"Bearer {token}")]


def test_mcp_cli_starts_stdio_server(isolate_deskly_home: Path) -> None:
    pytest.importorskip("mcp")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def exercise() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["-m", "deskly.cli", "mcp"],
            env={"DESKLY_HOME": str(isolate_deskly_home)},
            cwd=Path.cwd(),
        )
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                assert "waiting" in {tool.name for tool in tools.tools}
                result = await session.call_tool(
                    "waiting", {"today": "2026-09-26", "include_all": False}
                )
                assert result.isError is not True

    asyncio.run(exercise())


def test_mcp_cli_explains_missing_optional_dependency(monkeypatch, capsys) -> None:
    original_import = builtins.__import__

    def import_without_mcp(name, *args, **kwargs):
        if name.startswith("mcp"):
            raise ModuleNotFoundError("missing optional mcp dependency", name="mcp")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_mcp)
    assert main(["mcp"]) == 1
    captured = capsys.readouterr()
    assert "deskly[mcp]" in captured.err
    assert captured.out == ""
    with pytest.raises(SystemExit) as version_exit:
        main(["--version"])
    assert version_exit.value.code == 0
    assert capsys.readouterr().out.startswith("deskly ")


def test_mcp_updates_do_not_create_a_missing_ledger(isolate_deskly_home: Path) -> None:
    with pytest.raises(FileNotFoundError):
        set_state("c-20260101-00000000", STATE_WAITING, apply=True, expected_updated_at="v1")
    with pytest.raises(FileNotFoundError):
        record_reply(
            "c-20260101-00000000",
            "Synthetic reply",
            apply=True,
            expected_updated_at="v1",
        )
    assert not ledger_path(LEDGER_COMPANY).exists()
