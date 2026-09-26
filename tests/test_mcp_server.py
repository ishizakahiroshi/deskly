from __future__ import annotations

import asyncio
import builtins
import json
import sys
from datetime import date
from pathlib import Path

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
                "show_contact",
                "search_contacts",
                "add_draft",
                "set_state",
                "record_reply",
                "export_text",
            }
            result = await client.call_tool("waiting", {"today": "2026-09-26"})
            assert result.isError is not True

    asyncio.run(exercise())


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
