"""Synthetic recovery checks for the paired shared Web databases."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from deskly import shared_backup
from deskly.shared_admin import bootstrap
from deskly.shared_admin import main as shared_admin_main
from deskly.shared_auth import LocalCredentialStore
from deskly.shared_backup import (
    SharedBackupError,
    create_shared_backup,
    restore_shared_backup,
)

ORIGIN = "https://shared.example.test"
PASSWORD = "synthetic owner passphrase 01"


def _shared_home(path: Path) -> tuple[str, str]:
    path.mkdir(mode=0o700)
    result = bootstrap(home=path, origin=ORIGIN, workspace_name="Synthetic team",
                       owner_name="Synthetic owner", owner_login="owner",
                       timezone="UTC", password=PASSWORD)
    return result["workspace_id"], result["owner_subject"]


def test_paired_backup_restores_credentials_and_workspace_to_new_home(tmp_path: Path) -> None:
    home = tmp_path / "shared"
    workspace_id, subject = _shared_home(home)
    destination = tmp_path / "backup"

    manifest = create_shared_backup(home, destination, service_stopped=True)

    assert manifest["workspace_id"] == workspace_id
    assert manifest["account_count"] == manifest["identity_count"] == 1
    assert manifest["service_stopped_asserted"] is True
    assert manifest["atomic_cross_database_snapshot"] is False
    assert {item.name for item in destination.iterdir()} == {
        "manifest.json", "shared-credentials.sqlite3", "workspace.jsonl"}
    assert "password" not in (destination / "manifest.json").read_text(encoding="utf-8").lower()

    restored = tmp_path / "restored"
    result = restore_shared_backup(destination, restored, expected_origin=ORIGIN)

    assert result["workspace_id"] == workspace_id
    accounts = LocalCredentialStore(restored / "shared-credentials.sqlite3")
    assert accounts.authenticate("owner", PASSWORD) == (subject, 1)
    pointer = json.loads((restored / "workspace.json").read_text(encoding="utf-8"))
    assert pointer == {"workspace_id": workspace_id}
    with sqlite3.connect(restored / "workspaces" / f"{workspace_id}.sqlite3") as db:
        assert db.execute("SELECT count(*) FROM identities").fetchone()[0] == 1
        assert db.execute("SELECT subject FROM identities").fetchone()[0] == subject


def test_paired_backup_requires_stopped_service_lock_free_home_and_new_destination(
    tmp_path: Path,
) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    backup = tmp_path / "backup"
    with pytest.raises(SharedBackupError, match="service_must_be_stopped"):
        create_shared_backup(home, backup, service_stopped=False)
    assert not backup.exists()

    (home / "shared-admin.lock").touch()
    with pytest.raises(SharedBackupError, match="shared_admin_operation_in_progress"):
        create_shared_backup(home, backup, service_stopped=True)
    (home / "shared-admin.lock").unlink()

    backup.mkdir()
    with pytest.raises(SharedBackupError, match="backup_destination_must_be_new"):
        create_shared_backup(home, backup, service_stopped=True)


def test_restore_rejects_existing_target_and_tampered_pair(tmp_path: Path) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    backup = tmp_path / "backup"
    create_shared_backup(home, backup, service_stopped=True)

    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(SharedBackupError, match="restore_target_must_be_new"):
        restore_shared_backup(backup, existing, expected_origin=ORIGIN)

    tampered = backup / "workspace.jsonl"
    tampered.write_bytes(tampered.read_bytes() + b"{}\n")
    with pytest.raises(SharedBackupError, match="backup_checksum_or_schema_mismatch"):
        restore_shared_backup(backup, tmp_path / "tampered-restore", expected_origin=ORIGIN)
    assert not (tmp_path / "tampered-restore").exists()


def test_pair_validation_rejects_unmatched_account_and_identity(tmp_path: Path) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    credentials = home / "shared-credentials.sqlite3"
    accounts = LocalCredentialStore(credentials)
    accounts.create_account("orphan", "synthetic orphan passphrase 02")

    with pytest.raises(SharedBackupError, match="credential_identity_mismatch"):
        create_shared_backup(home, tmp_path / "backup", service_stopped=True)
    assert not (tmp_path / "backup").exists()


def test_backup_holds_shared_admin_lock_until_pair_is_exported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    original_export = shared_backup.export_workspace

    def checked_export(source_home: Path, workspace_id: str, target: Path) -> dict[str, object]:
        assert (home / "shared-admin.lock").is_file()
        return original_export(source_home, workspace_id, target)

    monkeypatch.setattr(shared_backup, "export_workspace", checked_export)
    create_shared_backup(home, tmp_path / "backup", service_stopped=True)
    assert not (home / "shared-admin.lock").exists()


def test_restore_rejects_manifest_issuer_mismatch(tmp_path: Path) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    backup = tmp_path / "backup"
    create_shared_backup(home, backup, service_stopped=True)
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["identity_issuer"] = "https://wrong.example.test"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(SharedBackupError, match="identity_issuer_mismatch"):
        restore_shared_backup(backup, tmp_path / "restore", expected_origin=ORIGIN)
    assert not (tmp_path / "restore").exists()


def test_restore_requires_exact_https_origin(tmp_path: Path) -> None:
    home = tmp_path / "shared"
    _shared_home(home)
    backup = tmp_path / "backup"
    create_shared_backup(home, backup, service_stopped=True)

    with pytest.raises(SharedBackupError, match="identity_issuer_mismatch"):
        restore_shared_backup(backup, tmp_path / "restore", expected_origin="https://other.example.test")
    assert not (tmp_path / "restore").exists()


def test_shared_admin_exposes_backup_and_restore_commands(tmp_path: Path, capsys) -> None:
    home = tmp_path / "shared"
    workspace_id, _ = _shared_home(home)
    backup = tmp_path / "backup"
    assert shared_admin_main(
        ["backup", "--home", str(home), "--destination", str(backup), "--service-stopped"],
        require_tty=False,
    ) == 0
    backup_result = json.loads(capsys.readouterr().out)
    assert backup_result["workspace_id"] == workspace_id

    restored = tmp_path / "restored"
    assert shared_admin_main(
        ["restore", "--source", str(backup), "--home", str(restored), "--origin", ORIGIN], require_tty=False
    ) == 0
    restore_result = json.loads(capsys.readouterr().out)
    assert restore_result["restored_to"] == str(restored)
