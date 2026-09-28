"""Interactive, local CLI for a shared workspace identity.

Run with ``python -m deskly.shared_cli`` on a trusted machine that can access
the shared workspace files. Passwords are read only from a TTY prompt. This
does not authenticate an AI caller: events identify the authenticated member
and record the shared-CLI execution route, while MCP stays unavailable until
it has an equivalent verified credential transport.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sqlite3
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from deskly.config import deskly_home
from deskly.shared_auth import CredentialStoreError, LocalCredentialStore
from deskly.workspace_model import WorkspaceError, uuid_text
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import workspace_path

_POINTER_FILE = "workspace.json"
_CREDENTIAL_FILE = "shared-credentials.sqlite3"
_LOCK_FILE = "shared-admin.lock"
_MAX_REQUEST_BYTES = 128 * 1024


def _validate_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.port not in {None, 443}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or value != f"https://{parsed.hostname}"
        ):
            raise ValueError
    except ValueError as exc:
        raise WorkspaceError("invalid_origin") from exc
    return value


def _resolve_home(path: Path) -> Path:
    if not path.is_absolute():
        raise WorkspaceError("home_must_be_absolute")
    try:
        mode = path.lstat().st_mode
    except OSError as exc:
        raise WorkspaceError("workspace_not_initialized", 404) from exc
    if path.is_symlink() or not stat.S_ISDIR(mode) or (os.name != "nt" and mode & 0o077):
        raise WorkspaceError("home_permissions_unsafe", 403)
    return path.resolve(strict=True)


def _workspace_id(home: Path) -> str:
    if (home / _LOCK_FILE).exists():
        raise WorkspaceError("workspace_recovery_required", 409)
    pointer = home / _POINTER_FILE
    if not pointer.is_file() or pointer.is_symlink():
        raise WorkspaceError("workspace_not_initialized", 404)
    try:
        data = json.loads(pointer.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or set(data) != {"workspace_id"}:
            raise ValueError
        workspace_id = uuid_text(data["workspace_id"])
        database = workspace_path(home, workspace_id)
        database_mode = database.lstat().st_mode
        if not stat.S_ISREG(database_mode):
            raise ValueError
        return workspace_id
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise WorkspaceError("workspace_not_initialized", 404) from exc


def _read_request(path: Path) -> object:
    try:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > _MAX_REQUEST_BYTES:
            raise WorkspaceError("invalid_request_file")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise WorkspaceError("invalid_request_file") from exc


def _json_result(result: object) -> None:
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


def main(
    argv: list[str] | None = None,
    *,
    login_reader: Callable[[str], str] | None = None,
    password_reader: Callable[[str], str] | None = None,
    confirmation_reader: Callable[[str], str] | None = None,
    require_tty: bool = True,
) -> int:
    parser = argparse.ArgumentParser(
        description="Authenticated local CLI for one shared Deskly workspace"
    )
    parser.add_argument("--home", type=Path, default=deskly_home())
    parser.add_argument("--origin", required=True, help="the exact HTTPS identity issuer origin")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("projects", help="list projects visible to the authenticated member")
    search = commands.add_parser("search", help="search only records visible to the authenticated member")
    search.add_argument("--query", required=True)
    commands.add_parser("counts", help="count only projects and records visible to the member")
    detail = commands.add_parser("detail", help="read one project visible to the member")
    detail.add_argument("--project-id", required=True)
    history = commands.add_parser("history", help="read visible project history")
    history.add_argument("--project-id", required=True)
    change = commands.add_parser("change", help="preview and interactively confirm one JSON command")
    change.add_argument("--request-file", type=Path, required=True)
    link = commands.add_parser(
        "link-contact", help="owner-only link of one known contact ID to one project"
    )
    link.add_argument("--workspace-id", required=True)
    link.add_argument("--project-id", required=True)
    link.add_argument("--source-id", required=True)
    link.add_argument("--contact-id", required=True)
    link.add_argument("--label", required=True)
    link.add_argument("--operation-id", required=True)
    link.add_argument("--reason", required=True)
    args = parser.parse_args(argv)

    try:
        if require_tty and (not sys.stdin.isatty() or not sys.stdout.isatty()):
            raise WorkspaceError("interactive_terminal_required", 403)
        home = _resolve_home(args.home.expanduser())
        origin = _validate_origin(args.origin)
        workspace_id = _workspace_id(home)
        credentials = LocalCredentialStore(home / _CREDENTIAL_FILE)
        login = (login_reader or input)("Login: ")
        password = (password_reader or getpass.getpass)("Password: ")
        authenticated = credentials.authenticate(login, password)
        # Do not retain the plaintext any longer than the credential check.
        del password
        if authenticated is None:
            raise WorkspaceError("unauthorized", 401)
        subject, revision = authenticated
        if not credentials.is_current(subject, revision):
            raise WorkspaceError("unauthorized", 401)
        service = WorkspaceService(
            home,
            workspace_id,
            secret=os.urandom(32),
            identity=(origin, subject),
            execution_route="shared-cli",
        )
        # Resolving exact issuer + subject binds the credential account to an
        # active member. No member ID, role, or actor is accepted from input.
        service.principal()

        if args.command == "projects":
            result: Any = service.projects()
        elif args.command == "search":
            result = service.search(args.query)
        elif args.command == "counts":
            result = service.counts()
        elif args.command == "detail":
            result = service.detail(args.project_id)
        elif args.command == "history":
            result = service.history(args.project_id)
        elif args.command == "change":
            preview = service.preview(_read_request(args.request_file))
            _json_result(preview)
            if require_tty and not sys.stdin.isatty():
                raise WorkspaceError("interactive_terminal_required", 403)
            answer = (confirmation_reader or input)("Apply this exact preview? [y/N] ")
            if answer.strip().casefold() != "y":
                print("not_applied")
                return 0
            result = service.apply(preview)
        elif args.command == "link-contact":
            principal = service.principal()
            if principal.workspace_id != uuid_text(args.workspace_id):
                raise WorkspaceError("workspace_not_found", 404)
            if principal.role != "owner":
                raise WorkspaceError("forbidden", 403)
            _json_result({"workspace_id": workspace_id, "project_id": args.project_id,
                          "source_id": args.source_id, "contact_id": args.contact_id,
                          "label": args.label, "operation_id": args.operation_id})
            if require_tty and not sys.stdin.isatty():
                raise WorkspaceError("interactive_terminal_required", 403)
            answer = (confirmation_reader or input)("Link this exact contact? [y/N] ")
            if answer.strip().casefold() != "y":
                print("not_applied")
                return 0
            from deskly.shared_contacts import link_project_contact

            result = link_project_contact(
                home,
                service,
                args.project_id,
                source_id=args.source_id,
                contact_id=args.contact_id,
                label=args.label,
                operation_id=args.operation_id,
                reason=args.reason,
            )
        else:  # argparse enforces the subcommand set above.
            raise WorkspaceError("invalid_command")
        _json_result(result)
        return 0
    except (WorkspaceError, CredentialStoreError) as exc:
        print(f"shared_cli_error:{exc}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error):
        print("shared_cli_error:storage_failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
