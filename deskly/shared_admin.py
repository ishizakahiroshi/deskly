"""Operator-only shared Web setup. Never accept passwords in arguments or logs.

Recovery: workspace.json is written last. If setup stops earlier, the original
workspace/credential files and a shared-admin.lock remain for inspection. Do
not rerun over a partial state or delete files blindly: inspect the files,
back them up, and either complete recovery from that backup or move the partial
set aside before a fresh bootstrap. A completed matching bootstrap is safe to
rerun and reports the existing IDs without changing passwords or data.
"""

from __future__ import annotations

import argparse
import getpass
import hmac
import json
import os
import sqlite3
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from deskly.shared_auth import CredentialStoreError, LocalCredentialStore
from deskly.shared_backup import SharedBackupError, create_shared_backup, restore_shared_backup
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_model import WorkspaceError, bounded_text, uuid_text
from deskly.workspace_store import SCHEMA_VERSION, WorkspaceStore, workspace_path

_CREDENTIAL_FILE = "shared-credentials.sqlite3"
_POINTER_FILE = "workspace.json"
_LOCK_FILE = "shared-admin.lock"


class AdminError(ValueError):
    """Safe, value-free error code for operator setup."""


def _origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.port not in {None, 443}
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
            or value != f"https://{parsed.hostname}"):
            raise ValueError
    except ValueError as exc:
        raise AdminError("invalid_origin") from exc
    return value


def _home(path: Path) -> Path:
    if not path.is_absolute():
        raise AdminError("home_must_be_absolute")
    if path.exists():
        mode = path.lstat().st_mode
        if not stat.S_ISDIR(mode) or (os.name != "nt" and mode & 0o077):
            raise AdminError("home_permissions_unsafe")
    return path


def _timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        if value not in {"UTC", "Asia/Tokyo"}:
            raise AdminError("invalid_timezone") from exc
    except ValueError as exc:
        raise AdminError("invalid_timezone") from exc
    return value


def _read_account(path: Path, login: str) -> tuple[str, bool] | None:
    LocalCredentialStore(path)  # Check type and permissions before opening.
    uri = f"{path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        row = db.execute("SELECT subject,active FROM accounts WHERE login=?", (login,)).fetchone()
    return (str(row[0]), bool(row[1])) if row else None


def _read_ready(home: Path, origin: str, *, allow_lock: bool = False) -> dict[str, Any] | None:
    if (home / _LOCK_FILE).exists() and not allow_lock:
        raise AdminError("partial_state_requires_recovery")
    pointer, credentials = home / _POINTER_FILE, home / _CREDENTIAL_FILE
    if not pointer.exists() and not credentials.exists():
        if any((home / "workspaces").glob("*.sqlite3")):
            raise AdminError("partial_state_requires_recovery")
        return None
    if not pointer.is_file() or not credentials.is_file():
        raise AdminError("partial_state_requires_recovery")
    try:
        pointer_data = json.loads(pointer.read_text(encoding="utf-8"))
        if not isinstance(pointer_data, dict) or set(pointer_data) != {"workspace_id"}:
            raise ValueError
        wid = uuid_text(pointer_data["workspace_id"])
        store = WorkspaceStore(workspace_path(home, wid))
        with store.connect() as db:
            metadata = db.execute("SELECT schema_version,name,timezone FROM metadata WHERE workspace_id=?",
                                  (wid,)).fetchone()
            owner = db.execute("SELECT id,name FROM members WHERE workspace_id=? AND role='owner' AND active=1",
                               (wid,)).fetchone()
        if metadata is None or metadata[0] != SCHEMA_VERSION or owner is None:
            raise ValueError
        return {"workspace_id": wid, "owner_member_id": str(owner[0]),
                "workspace_name": str(metadata[1]), "timezone": str(metadata[2]),
                "owner_name": str(owner[1]), "credential_store": credentials,
                "store": store, "origin": origin}
    except (OSError, sqlite3.Error, UnicodeError, ValueError, WorkspaceError) as exc:
        raise AdminError("partial_state_requires_recovery") from exc


def _owner_account(ready: dict[str, Any], login: str) -> str:
    account = _read_account(ready["credential_store"], login)
    if account is None or not account[1]:
        raise AdminError("configuration_conflict")
    try:
        principal = ready["store"].identity_principal(ready["workspace_id"],
                                                       ready["origin"], account[0])
    except WorkspaceError as exc:
        raise AdminError("configuration_conflict") from exc
    if principal.member_id != ready["owner_member_id"] or principal.role != "owner":
        raise AdminError("configuration_conflict")
    return account[0]


def inspect_bootstrap(home: Path, origin: str, workspace_name: str,
                      owner_name: str, owner_login: str, timezone: str) -> dict[str, str] | None:
    """Return an exact existing setup, or fail closed on mismatch/partial state."""
    home = _home(home)
    origin = _origin(origin)
    workspace_name = bounded_text(workspace_name, required=True, limit=120)
    owner_name = bounded_text(owner_name, required=True, limit=120)
    owner_login = LocalCredentialStore._validate_login(owner_login)
    timezone = _timezone(timezone)
    if not home.exists():
        return None
    ready = _read_ready(home, origin)
    if ready is None:
        return None
    if (ready["workspace_name"], ready["owner_name"], ready["timezone"]) != (
        workspace_name, owner_name, timezone
    ):
        raise AdminError("configuration_conflict")
    subject = _owner_account(ready, owner_login)
    return {"status": "already_ready", "workspace_id": ready["workspace_id"],
            "owner_member_id": ready["owner_member_id"], "owner_subject": subject,
            "origin": origin, "credential_store": str(ready["credential_store"])}


def _lock(home: Path, intent: dict[str, str] | None = None) -> Path:
    lock = home / _LOCK_FILE
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(intent or {"kind": "bootstrap"}, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
    except FileExistsError as exc:
        raise AdminError("partial_state_requires_recovery") from exc
    return lock


def _write_pointer(path: Path, workspace_id: str) -> None:
    raw = (json.dumps({"workspace_id": workspace_id}) + "\n").encode("utf-8")
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())


def bootstrap(*, home: Path, origin: str, workspace_name: str, owner_name: str,
              owner_login: str, timezone: str, password: str) -> dict[str, str]:
    prior = inspect_bootstrap(home, origin, workspace_name, owner_name,
                              owner_login, timezone)
    if prior is not None:
        return prior
    # Validate the secret before creating any file; never use it in diagnostics.
    LocalCredentialStore._validate_password(password)
    home.mkdir(parents=True, mode=0o700, exist_ok=True)
    _home(home)
    lock = _lock(home)
    # On any failure the lock and partial files remain for explicit recovery.
    workspace_id, owner_member_id = WorkspaceStore.initialize(
        home, workspace_name, timezone, owner_name
    )
    credentials = home / _CREDENTIAL_FILE
    accounts = LocalCredentialStore.initialize(credentials)
    subject = accounts.create_account(owner_login, password)
    store = WorkspaceStore(workspace_path(home, workspace_id))
    access = WorkspaceAccess(store, workspace_id, store.principal(workspace_id),
                             execution_route="shared-admin-cli")
    access.bind_owner_identity(origin, subject, operation_id=str(uuid4()),
                               reason="shared Web bootstrap")
    _write_pointer(home / _POINTER_FILE, workspace_id)
    lock.unlink()
    return {"status": "created", "workspace_id": workspace_id,
            "owner_member_id": owner_member_id, "owner_subject": subject,
            "origin": origin, "credential_store": str(credentials)}


def add_member(*, home: Path, origin: str, login: str, name: str,
               project_id: str, role: str, password: str) -> dict[str, str]:
    home = _home(home)
    origin = _origin(origin)
    login = LocalCredentialStore._validate_login(login)
    name = bounded_text(name, required=True, limit=120)
    project_id = uuid_text(project_id)
    if role not in {"viewer", "editor"}:
        raise AdminError("invalid_role")
    ready = _read_ready(home, origin)
    if ready is None or (home / _LOCK_FILE).exists():
        raise AdminError("bootstrap_required_or_partial")
    store: WorkspaceStore = ready["store"]
    with store.connect() as db:
        project = store.read_entity(db, project_id, ready["workspace_id"])
        if project["type"] != "project" or project["archived"]:
            raise AdminError("invalid_project")
    account = _read_account(ready["credential_store"], login)
    if account is not None:
        try:
            principal = store.identity_principal(ready["workspace_id"], origin, account[0])
            with store.connect() as db:
                member = db.execute("SELECT name FROM members WHERE id=?", (principal.member_id,)).fetchone()
                grant = db.execute("""SELECT role FROM project_memberships
                    WHERE workspace_id=? AND project_id=? AND member_id=?""",
                                   (ready["workspace_id"], project_id, principal.member_id)).fetchone()
            if account[1] and member and member[0] == name and grant and grant[0] == role:
                return {"status": "already_ready", "workspace_id": ready["workspace_id"],
                        "member_id": principal.member_id, "subject": account[0],
                        "project_id": project_id, "role": role}
        except WorkspaceError:
            pass
        raise AdminError("partial_state_requires_recovery")
    LocalCredentialStore._validate_password(password)
    intent = {"kind": "add-member", "origin": origin, "login": login,
              "name": name, "project_id": project_id, "role": role}
    lock = _lock(home, intent)
    accounts = LocalCredentialStore(ready["credential_store"])
    subject = accounts.create_account(login, password)
    access = WorkspaceAccess(store, ready["workspace_id"], store.principal(ready["workspace_id"]),
                             execution_route="shared-admin-cli")
    member = access.add_member(name, origin, subject, operation_id=str(uuid4()),
                               reason="shared Web member enrollment")
    access.set_project_role(project_id, member["member_id"], role, expected_version=0,
                            operation_id=str(uuid4()), reason="shared Web initial project grant")
    lock.unlink()
    return {"status": "created", "workspace_id": ready["workspace_id"],
            "member_id": member["member_id"], "subject": subject,
            "project_id": project_id, "role": role}


def recover_member(*, home: Path, origin: str, login: str, name: str,
                   project_id: str, role: str, password: str,
                   service_stopped: bool) -> dict[str, str]:
    """Resume only the exact interrupted member enrollment recorded in the lock."""
    home = _home(home)
    origin = _origin(origin)
    login = LocalCredentialStore._validate_login(login)
    name = bounded_text(name, required=True, limit=120)
    project_id = uuid_text(project_id)
    if role not in {"viewer", "editor"}:
        raise AdminError("invalid_role")
    LocalCredentialStore._validate_password(password)
    if not service_stopped:
        raise AdminError("service_must_be_stopped")
    lock = home / _LOCK_FILE
    intent = {"kind": "add-member", "origin": origin, "login": login,
              "name": name, "project_id": project_id, "role": role}
    was_locked = lock.exists()
    if was_locked:
        try:
            journal = json.loads(lock.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise AdminError("recovery_journal_invalid") from exc
        if journal != intent:
            raise AdminError("recovery_intent_mismatch")
    ready = _read_ready(home, origin, allow_lock=was_locked)
    if ready is None:
        raise AdminError("bootstrap_required_or_partial")
    store: WorkspaceStore = ready["store"]
    with store.connect() as db:
        project = store.read_entity(db, project_id, ready["workspace_id"])
        if project["type"] != "project" or project["archived"]:
            raise AdminError("invalid_project")
    accounts = LocalCredentialStore(ready["credential_store"])
    account = _read_account(ready["credential_store"], login)
    if account is None:
        subject = accounts.create_account(login, password)
    else:
        authenticated = accounts.authenticate(login, password)
        if authenticated is None or authenticated[0] != account[0] or not account[1]:
            raise AdminError("credential_mismatch")
        subject = account[0]
    access = WorkspaceAccess(store, ready["workspace_id"],
                             store.principal(ready["workspace_id"]),
                             execution_route="shared-admin-cli")
    with store.connect() as db:
        identity = db.execute("""SELECT m.id,m.name,m.active FROM identities i
            JOIN members m ON m.id=i.member_id AND m.workspace_id=i.workspace_id
            WHERE i.workspace_id=? AND i.issuer=? AND i.subject=?""",
            (ready["workspace_id"], origin, subject)).fetchone()
        grant = (db.execute("""SELECT role FROM project_memberships
            WHERE workspace_id=? AND project_id=? AND member_id=?""",
            (ready["workspace_id"], project_id, identity["id"])).fetchone()
            if identity else None)
    if identity is None:
        member = access.add_member(name, origin, subject, operation_id=str(uuid4()),
                                   reason="shared Web member enrollment recovery")
        member_id = str(member["member_id"])
        grant = None
    else:
        if not identity["active"] or identity["name"] != name:
            raise AdminError("recovery_state_conflict")
        member_id = str(identity["id"])
    if grant is None:
        access.set_project_role(project_id, member_id, role, expected_version=0,
                                operation_id=str(uuid4()),
                                reason="shared Web enrollment recovery")
    elif grant["role"] != role:
        raise AdminError("recovery_state_conflict")
    if was_locked:
        lock.unlink()
    return {"status": "recovered" if was_locked else "already_ready",
            "workspace_id": ready["workspace_id"], "member_id": member_id,
            "subject": subject, "project_id": project_id, "role": role}


def _password(reader: Callable[[str], str]) -> str:
    first = reader("Shared Web password: ")
    second = reader("Confirm password: ")
    if not hmac.compare_digest(first, second):
        raise AdminError("password_confirmation_mismatch")
    LocalCredentialStore._validate_password(first)
    return first


def main(argv: list[str] | None = None, *,
         secret_reader: Callable[[str], str] = getpass.getpass,
         require_tty: bool = True) -> int:
    parser = argparse.ArgumentParser(
        description="Explicit local setup for the shared workspace Web",
        epilog=("Recovery: workspace.json is written last. On partial_state, "
                "back up and inspect the lock, workspace DB and credential DB. "
                "Do not remove or overwrite them until their ownership and data are verified."),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    first = commands.add_parser("bootstrap", help="create one shared workspace and owner account")
    first.add_argument("--home", type=Path, required=True)
    first.add_argument("--origin", required=True)
    first.add_argument("--workspace-name", required=True)
    first.add_argument("--owner-name", required=True)
    first.add_argument("--owner-login", required=True)
    first.add_argument("--timezone", default="Asia/Tokyo")
    member = commands.add_parser("add-member", help="add one account and project grant")
    member.add_argument("--home", type=Path, required=True)
    member.add_argument("--origin", required=True)
    member.add_argument("--login", required=True)
    member.add_argument("--name", required=True)
    member.add_argument("--project-id", required=True)
    member.add_argument("--role", choices=("viewer", "editor"), required=True)
    recover = commands.add_parser("recover-member", help="resume one exact interrupted enrollment")
    recover.add_argument("--home", type=Path, required=True)
    recover.add_argument("--origin", required=True)
    recover.add_argument("--login", required=True)
    recover.add_argument("--name", required=True)
    recover.add_argument("--project-id", required=True)
    recover.add_argument("--role", choices=("viewer", "editor"), required=True)
    recover.add_argument("--service-stopped", action="store_true", required=True,
                         help="assert that the Web and every other writer are stopped")
    backup = commands.add_parser("backup", help="create a verified credential/workspace recovery pair")
    backup.add_argument("--home", type=Path, required=True)
    backup.add_argument("--destination", type=Path, required=True)
    backup.add_argument("--service-stopped", action="store_true", required=True,
                        help="assert that the Web and every other writer are stopped")
    restore = commands.add_parser("restore", help="restore a verified pair into a new shared home")
    restore.add_argument("--source", type=Path, required=True)
    restore.add_argument("--home", type=Path, required=True)
    restore.add_argument("--origin", required=True,
                         help="require the exact HTTPS issuer origin recorded in the pair")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        print("unsupported_arguments", file=sys.stderr)
        return 2
    try:
        if args.command == "bootstrap":
            existing = inspect_bootstrap(args.home, args.origin, args.workspace_name,
                                         args.owner_name, args.owner_login, args.timezone)
            if existing is not None:
                result = existing
            else:
                if require_tty and not sys.stdin.isatty():
                    raise AdminError("interactive_terminal_required")
                result = bootstrap(home=args.home, origin=args.origin,
                                   workspace_name=args.workspace_name, owner_name=args.owner_name,
                                   owner_login=args.owner_login, timezone=args.timezone,
                                   password=_password(secret_reader))
        elif args.command == "add-member":
            if require_tty and not sys.stdin.isatty():
                raise AdminError("interactive_terminal_required")
            result = add_member(home=args.home, origin=args.origin, login=args.login,
                                name=args.name, project_id=args.project_id, role=args.role,
                                password=_password(secret_reader))
        elif args.command == "recover-member":
            if require_tty and not sys.stdin.isatty():
                raise AdminError("interactive_terminal_required")
            result = recover_member(home=args.home, origin=args.origin, login=args.login,
                                    name=args.name, project_id=args.project_id, role=args.role,
                                    password=_password(secret_reader),
                                    service_stopped=args.service_stopped)
        elif args.command == "backup":
            result = create_shared_backup(args.home, args.destination,
                                          service_stopped=args.service_stopped)
        else:
            result = restore_shared_backup(args.source, args.home, expected_origin=args.origin)
    except (AdminError, WorkspaceError, CredentialStoreError, SharedBackupError) as exc:
        print(f"shared_admin_error:{type(exc).__name__}:{str(exc)}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error):
        print("shared_admin_error:storage_failure; inspect partial files", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
