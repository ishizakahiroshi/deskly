from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from deskly.cli import main
from deskly.commands import record_reply
from deskly.config import LEDGER_COMPANY, ledger_path
from deskly.model import STATE_IN_PROGRESS, STATE_WAITING
from deskly.store import ConflictError, SqliteStore


def test_cli_write_workflow_records_each_changed_field(
    isolate_deskly_home: Path, capsys
) -> None:
    assert main(["add", "--project", "Synthetic Project", "--body", "Synthetic draft", "--note", "First note"]) == 0
    created_output = capsys.readouterr().out
    match = re.fullmatch(r"(c-\d{8}-[0-9a-f]{8}) 下書き\n", created_output)
    assert match is not None
    contact_id = match.group(1)

    assert main(["set-state", contact_id, STATE_WAITING]) == 0
    capsys.readouterr()
    assert main(["record-reply", contact_id, "--summary", "Synthetic reply summary"]) == 0
    capsys.readouterr()

    assert main(["show", contact_id, "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["state"] == STATE_IN_PROGRESS
    assert shown["note"] == "First note\n返信要約: Synthetic reply summary"

    assert main(["export", contact_id]) == 0
    assert capsys.readouterr().out == "Synthetic draft"

    with SqliteStore(ledger_path(LEDGER_COMPANY)) as store:
        history = store.history(contact_id)
        assert [change.field for change in history] == ["_created", "state", "note", "state"]
        assert [change.actor for change in history] == ["cli"] * 4
        assert store.get(contact_id).state == STATE_IN_PROGRESS


def test_record_reply_rejects_stale_snapshot_without_writing(isolate_deskly_home: Path) -> None:
    with SqliteStore(ledger_path(LEDGER_COMPANY)) as store:
        contact = store.create({"state": STATE_WAITING, "note": "Original"})
        stale = contact.updated_at
        current = store.update(contact.id, {"note": "Concurrent update"})

        with pytest.raises(ConflictError):
            record_reply(
                store,
                contact.id,
                "Synthetic reply",
                expected_updated_at=stale,
            )

        assert store.get(contact.id) == current
        assert len(store.history(contact.id)) == 2


def test_backup_cli_writes_roundtrippable_json_lines_and_keeps_generations(
    isolate_deskly_home: Path, tmp_path: Path, capsys
) -> None:
    destination = tmp_path / "synthetic-backups"
    with SqliteStore(ledger_path(LEDGER_COMPANY)) as store:
        contact = store.create(
            {
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "body": "Synthetic body",
            }
        )
        store.update(contact.id, {"state": STATE_IN_PROGRESS, "note": "Synthetic note"})
        expected_rows = store.export_rows()

    destination.mkdir()
    unrelated = destination / "keep-me.txt"
    unrelated.write_text("synthetic", encoding="utf-8")
    root_unowned = destination / "company-20260101T000000000000Z.jsonl"
    root_unowned.write_text("synthetic root file\n", encoding="utf-8")
    (destination / "personal-20260101T000000000000Z.jsonl").write_text(
        "synthetic\n", encoding="utf-8"
    )
    (destination / "company-not-generated.jsonl").write_text("synthetic\n", encoding="utf-8")
    backup_directory = destination / "deskly-backups"
    backup_directory.mkdir()
    nested_unowned = backup_directory / "company-20260102T000000000000Z.jsonl"
    nested_unowned.write_text("synthetic unowned file\n", encoding="utf-8")

    assert main(["backup", "--dest", str(destination), "--keep", "2"]) == 0
    first_output = capsys.readouterr().out
    first_path = Path(first_output.removeprefix("控えを書き出しました: ").strip())
    assert first_path.is_file()
    assert first_path.parent == backup_directory
    owner_marker = first_path.with_name(f"{first_path.name}.deskly-owner")
    owner_data = json.loads(owner_marker.read_text(encoding="utf-8"))
    assert owner_data == {
        "owner": "deskly",
        "version": 1,
        "file": first_path.name,
        "sha256": hashlib.sha256(first_path.read_bytes()).hexdigest(),
    }
    rows = [json.loads(line) for line in first_path.read_text(encoding="utf-8").splitlines()]
    assert rows == expected_rows

    restored_path = tmp_path / "restored" / "company.sqlite3"
    with SqliteStore(restored_path) as restored:
        counts = restored.import_rows(rows)
        assert counts.contacts == 1
        assert counts.changes == 3
        assert restored.export_rows() == expected_rows

    backup_paths = [first_path]
    for _ in range(2):
        assert main(["backup", "--dest", str(destination), "--keep", "2"]) == 0
        backup_output = capsys.readouterr().out
        backup_paths.append(Path(backup_output.removeprefix("控えを書き出しました: ").strip()))

    retained = sorted(
        path
        for path in backup_directory.glob("company-*.jsonl")
        if re.fullmatch(r"company-\d{8}T\d{12}Z(?:-\d+)?\.jsonl", path.name)
        and path.with_name(f"{path.name}.deskly-owner").is_file()
    )
    assert len(retained) == 2
    assert first_path not in retained
    assert all(path.is_file() for path in backup_paths[-2:])
    assert unrelated.read_text(encoding="utf-8") == "synthetic"
    assert root_unowned.read_text(encoding="utf-8") == "synthetic root file\n"
    assert nested_unowned.read_text(encoding="utf-8") == "synthetic unowned file\n"
    assert (destination / "personal-20260101T000000000000Z.jsonl").is_file()
    assert (destination / "company-not-generated.jsonl").is_file()


def test_add_is_always_a_draft_and_backup_keep_must_be_positive(
    isolate_deskly_home: Path, capsys
) -> None:
    with pytest.raises(SystemExit) as add_error:
        main(["add", "--state", STATE_WAITING])
    assert add_error.value.code == 2
    capsys.readouterr()

    with pytest.raises(SystemExit) as backup_error:
        main(["backup", "--keep", "0"])
    assert backup_error.value.code == 2


def test_update_commands_do_not_create_a_missing_ledger(
    isolate_deskly_home: Path, capsys
) -> None:
    contact_id = "c-20260101-00000000"

    assert main(["set-state", contact_id, STATE_WAITING]) == 1
    assert "台帳がありません" in capsys.readouterr().err
    assert main(["record-reply", contact_id, "--summary", "Synthetic reply"]) == 1
    assert "台帳がありません" in capsys.readouterr().err
    assert not ledger_path(LEDGER_COMPANY).exists()
