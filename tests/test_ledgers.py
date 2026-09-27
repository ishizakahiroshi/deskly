from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from deskly.cli import main
from deskly.config import ConfigError, load_ledger_config, parse_config
from deskly.ledgers import AmbiguousContactError, load_ledgers
from deskly.mcp_server import add_draft as mcp_add_draft
from deskly.mcp_server import list_contacts as mcp_list_contacts
from deskly.mcp_server import search_contacts as mcp_search_contacts
from deskly.mcp_server import set_state as mcp_set_state
from deskly.model import STATE_DONE, STATE_WAITING
from deskly.store import SqliteStore
from deskly.views import build_waiting_rows


def _ledger_config_data(tmp_path: Path) -> dict[str, object]:
    return {
        "default_ledger": "company",
        "ledgers": [
            {
                "name": "company",
                "label": "Work",
                "storage": "local",
                "path": str(tmp_path / "work.sqlite3"),
            },
            {
                "name": "personal",
                "label": "Personal",
                "storage": "local",
                "path": str(tmp_path / "personal.sqlite3"),
            },
        ],
        "sources": [],
        "excluded_recipients": {
            "csv": str(tmp_path / "excluded.csv"),
            "column": "synthetic_name",
        },
    }


def _write_config(home: Path, data: dict[str, object]) -> Path:
    lines = [f"default_ledger = {json.dumps(str(data['default_ledger']))}", ""]
    for item in data["ledgers"]:  # type: ignore[index]
        assert isinstance(item, dict)
        lines.extend(
            [
                "[[ledgers]]",
                f"name = {json.dumps(item['name'])}",
                f"label = {json.dumps(item['label'])}",
                f"storage = {json.dumps(item['storage'])}",
            ]
        )
        if "path" in item:
            lines.append(f"path = {json.dumps(item['path'])}")
        if "url" in item:
            lines.append(f"url = {json.dumps(item['url'])}")
            lines.append(f"token_env = {json.dumps(item['token_env'])}")
        lines.append("")
    excluded = data.get("excluded_recipients")
    if excluded is not None:
        assert isinstance(excluded, dict)
        lines.extend(
            [
                "[excluded_recipients]",
                f"csv = {json.dumps(excluded['csv'])}",
                f"column = {json.dumps(excluded['column'])}",
                "",
            ]
        )
    home.mkdir(parents=True, exist_ok=True)
    path = home / "config.toml"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def test_ledger_collection_merges_views_and_resolves_each_id(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    data = _ledger_config_data(tmp_path)
    _write_config(isolate_deskly_home, data)
    definitions = parse_config(data)
    work_path = definitions.local_ledger_path("company")
    personal_path = definitions.local_ledger_path("personal")
    with SqliteStore(work_path) as work, SqliteStore(personal_path) as personal:
        work_contact = work.create(
            {
                "id": "c-20260926-00000001",
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "body": "Work update",
            }
        )
        personal_contact = personal.create(
            {
                "id": "c-20260926-00000002",
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "body": "Personal update",
            }
        )
        history_before = {
            work_contact.id: work.history(work_contact.id),
            personal_contact.id: personal.history(personal_contact.id),
        }

    ledgers = load_ledgers()
    rows = build_waiting_rows(ledgers.list_contacts(), today=date(2026, 9, 26))
    assert len(rows) == 1
    assert rows[0].ledger_names == ("company", "personal")
    assert rows[0].contact_refs == (
        f"company/{work_contact.id}",
        f"personal/{personal_contact.id}",
    )
    assert ledgers.find_contact(work_contact.id).ledger.name == "company"
    assert ledgers.find_contact(personal_contact.id).ledger.name == "personal"

    first_page = mcp_list_contacts(limit=1)
    second_page = mcp_list_contacts(limit=1, offset=1)
    assert first_page == {
        "items": [work_contact.to_dict() | {"ledger": "company", "ledger_label": "Work"}],
        "total": 2,
        "limit": 1,
        "offset": 0,
        "next_offset": 1,
    }
    assert second_page["items"] == [
        personal_contact.to_dict() | {"ledger": "personal", "ledger_label": "Personal"}
    ]
    assert second_page["next_offset"] is None
    empty_page = mcp_list_contacts(limit=1, offset=5)
    assert empty_page == {
        "items": [],
        "total": 2,
        "limit": 1,
        "offset": 5,
        "next_offset": None,
    }
    assert [item["id"] for item in mcp_search_contacts("UPDATE", limit=1)] == [
        work_contact.id
    ]
    assert [
        item["id"] for item in mcp_search_contacts("UPDATE", limit=1, offset=1)
    ] == [personal_contact.id]
    with pytest.raises(ValueError, match="limit は 1 から 100"):
        mcp_list_contacts(limit=101)
    with pytest.raises(ValueError, match="offset は 0 以上"):
        mcp_list_contacts(offset=-1)
    with pytest.raises(ValueError, match="offset は 0 以上"):
        mcp_search_contacts("UPDATE", limit=1, offset=-1)
    with SqliteStore(work_path) as work, SqliteStore(personal_path) as personal:
        assert work.history(work_contact.id) == history_before[work_contact.id]
        assert personal.history(personal_contact.id) == history_before[personal_contact.id]


def test_cli_contacts_list_and_search_across_ledgers(
    isolate_deskly_home: Path, tmp_path: Path, capsys
) -> None:
    data = _ledger_config_data(tmp_path)
    _write_config(isolate_deskly_home, data)
    config = parse_config(data)
    work_path = config.local_ledger_path("company")
    personal_path = config.local_ledger_path("personal")
    with SqliteStore(work_path) as work, SqliteStore(personal_path) as personal:
        work_contact = work.create(
            {
                "id": "c-20260926-00000011",
                "state": STATE_WAITING,
                "project": "Synthetic\nInjected project",
                "recipient": "Synthetic Work Recipient",
                "body": "private synthetic body one",
            }
        )
        personal_contact = personal.create(
            {
                "id": "c-20260926-00000012",
                "state": STATE_DONE,
                "project": "Synthetic Personal Project",
                "recipient": "Synthetic Personal Recipient",
                "body": "private synthetic body two",
            }
        )

    assert main(["contacts", "list", "--json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert [(item["ledger"], item["id"]) for item in listed] == [
        ("company", work_contact.id),
        ("personal", personal_contact.id),
    ]
    assert listed[0]["body"] == "private synthetic body one"

    assert main(["contacts", "search", "SYNTHETIC PERSONAL", "--json"]) == 0
    matched = json.loads(capsys.readouterr().out)
    assert [item["id"] for item in matched] == [personal_contact.id]

    assert main(["contacts", "list"]) == 0
    human_output = capsys.readouterr().out
    assert "\\x0aInjected project" in human_output
    assert "private synthetic body one" not in human_output
    assert "private synthetic body two" not in human_output

    assert main(["contacts", "search", "", "--json"]) == 1
    assert "検索語を空にできません" in capsys.readouterr().err


def test_cli_waits_across_ledgers_and_writes_only_to_the_selected_ledger(
    isolate_deskly_home: Path, tmp_path: Path, capsys
) -> None:
    data = _ledger_config_data(tmp_path)
    _write_config(isolate_deskly_home, data)
    config = parse_config(data)
    work_path = config.local_ledger_path("company")
    personal_path = config.local_ledger_path("personal")
    with SqliteStore(personal_path) as store:
        personal = store.create(
            {
                "id": "c-20260926-00000003",
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "body": "Personal request",
            }
        )

    assert main(["waiting", "--json", "--today", "2026-09-26"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows[0]["ledger_names"] == ["personal"]
    assert rows[0]["contact_refs"] == [f"personal/{personal.id}"]

    assert main(["set-state", personal.id, STATE_DONE]) == 0
    assert capsys.readouterr().out.startswith(f"personal/{personal.id} ")
    assert main(["add", "--ledger", "personal", "--project", "Synthetic Project"]) == 0
    created_output = capsys.readouterr().out
    assert created_output.startswith("personal/c-")

    with SqliteStore(work_path) as work:
        assert work.list_contacts() == []
    with SqliteStore(personal_path) as store:
        contacts = store.list_contacts()
        assert len(contacts) == 2
        assert store.get(personal.id).state == STATE_DONE
        assert store.history(personal.id)[-1].actor == "cli"
        created_id = created_output.split()[0].split("/", maxsplit=1)[1]
        assert all(change.actor == "cli" for change in store.history(created_id))


def test_duplicate_contact_ids_are_rejected_as_ambiguous(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    config = parse_config(_ledger_config_data(tmp_path))
    for name in ("company", "personal"):
        with SqliteStore(config.local_ledger_path(name)) as store:
            store.create({"id": "c-20260926-00000004"})
    with pytest.raises(AmbiguousContactError, match="複数の台帳"):
        load_ledgers(config).find_contact("c-20260926-00000004")


def test_mcp_write_tools_route_to_the_selected_ledger(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    data = _ledger_config_data(tmp_path)
    _write_config(isolate_deskly_home, data)
    config = parse_config(data)
    work_path = config.local_ledger_path("company")
    personal_path = config.local_ledger_path("personal")

    preview = mcp_add_draft(ledger_name="personal", body="Synthetic personal note")
    assert preview["preview"]["ledger"] == "personal"
    created = mcp_add_draft(
        ledger_name="personal",
        body="Synthetic personal note",
        apply=True,
        expected_updated_at="new",
    )
    contact = created["contact"]
    updated = mcp_set_state(
        contact["id"],
        STATE_WAITING,
        apply=True,
        expected_updated_at=contact["updated_at"],
    )
    assert updated["contact"]["ledger"] == "personal"

    assert not work_path.exists()
    with SqliteStore(personal_path) as store:
        assert [item.id for item in store.list_contacts()] == [contact["id"]]
        assert {item.actor for item in store.history(contact["id"])} == {"mcp"}


def test_backup_covers_existing_ledgers_and_reports_uncreated_ones(
    isolate_deskly_home: Path, tmp_path: Path, capsys
) -> None:
    data = _ledger_config_data(tmp_path)
    _write_config(isolate_deskly_home, data)
    personal_path = parse_config(data).local_ledger_path("personal")
    with SqliteStore(personal_path) as store:
        store.create({"body": "Synthetic backup content"})

    destination = tmp_path / "backups"
    assert main(["backup", "--dest", str(destination)]) == 0
    output = capsys.readouterr().out.splitlines()
    assert output[0] == "控えをスキップしました（台帳が未作成）: company"
    assert "personal-" in output[1]
    assert len(list((destination / "deskly-backups").glob("personal-*.jsonl"))) == 1
    assert not list(destination.glob("company-*.jsonl"))


def test_single_ledger_default_and_server_definition_are_valid(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    legacy = parse_config(
        {
            "sources": [],
            "excluded_recipients": {
                "csv": str(tmp_path / "excluded.csv"),
                "column": "synthetic_name",
            },
        }
    )
    assert legacy.default_ledger == "company"
    assert len(legacy.ledgers) == 1
    assert load_ledgers(load_ledger_config()).default.name == "company"

    data = {
        "default_ledger": "company",
        "ledgers": [
            {
                "name": "company",
                "label": "Work",
                "storage": "server",
                "url": "http://127.0.0.1:8765",
                "token_env": "DESKLY_API_TOKEN",
            }
        ],
        "sources": [],
    }
    server_config = parse_config(data, require_exclusions=False)
    definition = server_config.ledger("company")
    assert definition.storage == "server"
    assert definition.url == "http://127.0.0.1:8765"
    assert definition.token_env == "DESKLY_API_TOKEN"
    with pytest.raises(ConfigError, match="C8"):
        server_config.local_ledger_path("company")


def test_config_rejects_unsafe_server_urls_and_shared_local_paths(tmp_path: Path) -> None:
    data = _ledger_config_data(tmp_path)
    data["ledgers"] = [
        {
            "name": "company",
            "label": "Work",
            "storage": "server",
            "url": "http://service.example.test",
            "token_env": "DESKLY_API_TOKEN",
        }
    ]
    with pytest.raises(ConfigError, match="loopback"):
        parse_config(data, require_exclusions=False)

    data = _ledger_config_data(tmp_path)
    personal = data["ledgers"][1]  # type: ignore[index]
    assert isinstance(personal, dict)
    personal["path"] = data["ledgers"][0]["path"]  # type: ignore[index]
    with pytest.raises(ConfigError, match="同じファイル"):
        parse_config(data)
