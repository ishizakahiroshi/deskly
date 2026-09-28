"""Paired recovery files for the shared Web credential and workspace stores.

The caller must stop the shared Web and every other writer first. SQLite's
backup API gives each database a sound individual snapshot; it cannot make the
two files one atomic cross-database snapshot.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from deskly import __version__
from deskly.shared_auth import CredentialStoreError, LocalCredentialStore
from deskly.workspace_backup import export_workspace, restore_workspace
from deskly.workspace_model import uuid_text
from deskly.workspace_store import SCHEMA_VERSION, workspace_path

FORMAT = "deskly-shared-pair-v1"
MANIFEST = "manifest.json"
CREDENTIALS = "shared-credentials.sqlite3"
WORKSPACE = "workspace.jsonl"
_LOCK = "shared-admin.lock"
_MAX_CREDENTIAL_BYTES = 64 * 1024 * 1024


class SharedBackupError(ValueError):
    """A paired backup cannot be safely created or restored."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, value: object) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _workspace_details(home: Path, workspace_id: str) -> tuple[int, str]:
    path = workspace_path(home, workspace_id)
    if _is_link(path) or not path.is_file():
        raise SharedBackupError("workspace_missing")
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True)) as db:
            row = db.execute("SELECT schema_version,workspace_id FROM metadata").fetchone()
        if row is None or row[0] != SCHEMA_VERSION or row[1] != workspace_id:
            raise SharedBackupError("workspace_schema_mismatch")
        return int(row[0]), str(row[1])
    except sqlite3.Error as exc:
        raise SharedBackupError("workspace_unavailable") from exc


def _validate_pair(credentials_path: Path, workspace_path_value: Path,
                   workspace_id: str) -> dict[str, Any]:
    """Check the join between the two stores without returning credential data."""
    try:
        LocalCredentialStore(credentials_path)
        with closing(sqlite3.connect(credentials_path.resolve().as_uri() + "?mode=ro", uri=True)) as accounts_db:
            accounts_db.row_factory = sqlite3.Row
            columns = {row[1] for row in accounts_db.execute("PRAGMA table_info(accounts)")}
            if columns != {"subject", "login", "salt", "password_hash", "active", "revision"}:
                raise SharedBackupError("credential_schema_mismatch")
            account_rows = accounts_db.execute(
                "SELECT subject,login,salt,password_hash,active,revision FROM accounts ORDER BY subject").fetchall()
            if accounts_db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SharedBackupError("credential_integrity_error")
            for account in account_rows:
                try:
                    uuid_text(str(account["subject"]))
                    LocalCredentialStore._validate_login(str(account["login"]))
                except (CredentialStoreError, ValueError) as exc:
                    raise SharedBackupError("credential_row_invalid") from exc
                if (not isinstance(account["salt"], bytes) or len(account["salt"]) != 32
                    or not isinstance(account["password_hash"], bytes)
                    or len(account["password_hash"]) != 64
                    or account["active"] not in (0, 1)
                    or not isinstance(account["revision"], int) or account["revision"] < 1):
                    raise SharedBackupError("credential_row_invalid")

        with closing(sqlite3.connect(workspace_path_value.resolve().as_uri() + "?mode=ro", uri=True)) as workspace_db:
            workspace_db.row_factory = sqlite3.Row
            meta = workspace_db.execute(
                "SELECT schema_version,workspace_id FROM metadata").fetchone()
            if meta is None or meta["schema_version"] != SCHEMA_VERSION or meta["workspace_id"] != workspace_id:
                raise SharedBackupError("workspace_schema_mismatch")
            identity_rows = workspace_db.execute(
                "SELECT i.workspace_id,i.member_id,i.issuer,i.subject,m.active,m.role "
                "FROM identities i JOIN members m ON m.id=i.member_id AND m.workspace_id=i.workspace_id "
                "ORDER BY i.subject").fetchall()
            dangling_identities = workspace_db.execute(
                "SELECT count(*) FROM identities i LEFT JOIN members m "
                "ON m.id=i.member_id AND m.workspace_id=i.workspace_id WHERE m.id IS NULL").fetchone()[0]
            members = {row["subject"]: row for row in identity_rows}
            account_subjects = {str(row["subject"]): bool(row["active"]) for row in account_rows}
            if (dangling_identities or len(account_subjects) != len(account_rows)
                or set(members) != set(account_subjects)):
                raise SharedBackupError("credential_identity_mismatch")
            issuers = {str(row["issuer"]) for row in identity_rows}
            if len(issuers) > 1:
                raise SharedBackupError("identity_issuer_mismatch")
            for subject, identity in members.items():
                if (identity["workspace_id"] != workspace_id or not identity["issuer"]
                    or not subject or bool(identity["active"]) != account_subjects[subject]):
                    raise SharedBackupError("credential_identity_mismatch")
            if not any(row["role"] == "owner" and bool(row["active"])
                       and account_subjects[str(row["subject"])] for row in identity_rows):
                raise SharedBackupError("active_owner_missing")
            return {"workspace_id": workspace_id, "schema_version": int(meta["schema_version"]),
                    "identity_issuer": next(iter(issuers), ""),
                    "account_count": len(account_rows), "identity_count": len(identity_rows)}
    except (sqlite3.Error, CredentialStoreError, OSError) as exc:
        raise SharedBackupError("pair_unavailable") from exc


def _assert_quiesced(home: Path, service_stopped: bool) -> tuple[str, Path]:
    if service_stopped is not True:
        raise SharedBackupError("service_must_be_stopped")
    if not home.is_absolute() or not home.is_dir():
        raise SharedBackupError("shared_home_unavailable")
    pointer = home / "workspace.json"
    credentials = home / CREDENTIALS
    if (_has_link_ancestor(home) or _is_link(pointer) or _is_link(credentials)):
        raise SharedBackupError("shared_home_path_unsafe")
    try:
        value = json.loads(pointer.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or set(value) != {"workspace_id"}:
            raise ValueError
        workspace_id = uuid_text(value["workspace_id"])
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise SharedBackupError("shared_home_not_ready") from exc
    _workspace_details(home, workspace_id)
    workspace = workspace_path(home, workspace_id)
    if _has_link_ancestor(workspace):
        raise SharedBackupError("shared_home_path_unsafe")
    _validate_pair(credentials, workspace, workspace_id)
    return workspace_id, credentials


def _is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def _has_link_ancestor(path: Path) -> bool:
    current = path.absolute()
    while True:
        if _is_link(current):
            return True
        if current.parent == current:
            return False
        current = current.parent


@contextmanager
def _backup_lock(home: Path):
    lock = home / _LOCK
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise SharedBackupError("shared_admin_operation_in_progress") from exc
    try:
        os.close(fd)
        yield
    finally:
        lock.unlink(missing_ok=True)


def create_shared_backup(home: Path, destination: Path, *, service_stopped: bool) -> dict[str, Any]:
    """Create a new private pair directory from a quiesced shared home.

    ``service_stopped`` is an explicit operator assertion; this library cannot
    discover every process that might write to the files. An admin operation
    lock and cross-database relationship checks are also enforced.
    """
    if (not destination.is_absolute() or destination.exists() or not destination.parent.is_dir()
        or _has_link_ancestor(destination.parent)):
        raise SharedBackupError("backup_destination_must_be_new")
    with _backup_lock(home):
        workspace_id, credentials_source = _assert_quiesced(home, service_stopped)
        stage = destination.with_name(f".{destination.name}.{uuid4().hex}.pending")
        stage.mkdir(mode=0o700)
        try:
            staged_credentials = stage / CREDENTIALS
            if credentials_source.stat().st_size > _MAX_CREDENTIAL_BYTES:
                raise SharedBackupError("credential_backup_too_large")
            source_uri = credentials_source.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(source_uri, uri=True)) as source_db:
                with closing(sqlite3.connect(staged_credentials)) as target_db:
                    source_db.backup(target_db)
                    target_db.execute("PRAGMA journal_mode=DELETE")
                    target_db.commit()
            if os.name != "nt":
                staged_credentials.chmod(0o600)
            workspace_export = stage / WORKSPACE
            export_workspace(home, workspace_id, workspace_export)
            verification_home = stage / ".verify"
            export_manifest = restore_workspace(workspace_export, verification_home)
            details = _validate_pair(
                staged_credentials,
                workspace_path(verification_home, workspace_id), workspace_id)
            shutil.rmtree(verification_home)
            manifest = {
                "format": FORMAT,
                "created_at_utc": datetime.now(UTC).isoformat(),
                "app_version": __version__,
                "workspace_id": workspace_id,
                "workspace_schema_version": details["schema_version"],
                "identity_issuer": details["identity_issuer"],
                "account_count": details["account_count"],
                "identity_count": details["identity_count"],
                "credential_file": CREDENTIALS,
                "credential_sha256": _sha256(staged_credentials),
                "workspace_file": WORKSPACE,
                "workspace_sha256": _sha256(workspace_export),
                "workspace_export_sha256": export_manifest["sha256"],
                "service_stopped_asserted": True,
                "atomic_cross_database_snapshot": False,
            }
            _write_json(stage / MANIFEST, manifest)
            stage.rename(destination)
            return manifest
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise


def _load_manifest(source: Path) -> dict[str, Any]:
    try:
        if (_has_link_ancestor(source) or not source.is_dir()
            or {item.name for item in source.iterdir()} != {
                MANIFEST, CREDENTIALS, WORKSPACE
            }):
            raise SharedBackupError("invalid_backup")
        for name in (MANIFEST, CREDENTIALS, WORKSPACE):
            item = source / name
            if _is_link(item) or not item.is_file():
                raise SharedBackupError("invalid_backup")
        manifest = json.loads((source / MANIFEST).read_text(encoding="utf-8"))
        if (manifest.get("format") != FORMAT or manifest.get("credential_file") != CREDENTIALS
            or manifest.get("workspace_file") != WORKSPACE
            or manifest.get("service_stopped_asserted") is not True
            or manifest.get("atomic_cross_database_snapshot") is not False):
            raise SharedBackupError("invalid_backup")
        workspace_id = uuid_text(manifest["workspace_id"])
        if (manifest["workspace_schema_version"] != SCHEMA_VERSION
            or _sha256(source / CREDENTIALS) != manifest["credential_sha256"]
            or _sha256(source / WORKSPACE) != manifest["workspace_sha256"]):
            raise SharedBackupError("backup_checksum_or_schema_mismatch")
        return {**manifest, "workspace_id": workspace_id}
    except SharedBackupError:
        raise
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise SharedBackupError("invalid_backup") from exc


def restore_shared_backup(source: Path, destination_home: Path, *, expected_origin: str) -> dict[str, Any]:
    """Restore a verified pair into a path that does not already exist."""
    manifest = _load_manifest(source)
    from urllib.parse import urlsplit

    try:
        parsed_origin = urlsplit(expected_origin)
        valid_origin = (
            parsed_origin.scheme == "https" and bool(parsed_origin.hostname)
            and parsed_origin.username is None and parsed_origin.password is None
            and not parsed_origin.path and not parsed_origin.query and not parsed_origin.fragment
            and parsed_origin.port in {None, 443}
            and expected_origin == f"https://{parsed_origin.hostname}"
        )
    except ValueError:
        valid_origin = False
    if not valid_origin or manifest["identity_issuer"] != expected_origin:
        raise SharedBackupError("identity_issuer_mismatch")
    if (not destination_home.is_absolute() or destination_home.exists()
        or _is_link(destination_home) or not destination_home.parent.is_dir()
        or _has_link_ancestor(destination_home.parent)):
        raise SharedBackupError("restore_target_must_be_new")
    stage = destination_home.with_name(f".{destination_home.name}.{uuid4().hex}.restore")
    stage.mkdir(mode=0o700)
    try:
        workspace_manifest = restore_workspace(source / WORKSPACE, stage)
        if workspace_manifest.get("workspace_id") != manifest["workspace_id"]:
            raise SharedBackupError("workspace_identity_mismatch")
        credential_target = stage / CREDENTIALS
        with closing(sqlite3.connect((source / CREDENTIALS).resolve().as_uri() + "?mode=ro", uri=True)) as source_db:
            with closing(sqlite3.connect(credential_target)) as target_db:
                source_db.backup(target_db)
                target_db.execute("PRAGMA journal_mode=DELETE")
                target_db.commit()
        if os.name != "nt":
            credential_target.chmod(0o600)
        restored_details = _validate_pair(
            credential_target, workspace_path(stage, manifest["workspace_id"]),
            manifest["workspace_id"])
        if (restored_details["account_count"] != manifest["account_count"]
            or restored_details["identity_count"] != manifest["identity_count"]
            or restored_details["identity_issuer"] != manifest["identity_issuer"]
            or restored_details["workspace_id"] != manifest["workspace_id"]):
            raise SharedBackupError("pair_manifest_mismatch")
        _write_json(stage / "workspace.json", {"workspace_id": manifest["workspace_id"]})
        stage.rename(destination_home)
        return {**manifest, "restored_to": str(destination_home)}
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
