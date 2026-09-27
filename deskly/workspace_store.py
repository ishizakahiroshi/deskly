"""Separate SQLite storage for one explicitly initialized workspace."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from deskly.workspace_model import Principal, WorkspaceError, uuid_text

SCHEMA_VERSION = 2

ACCESS_SCHEMA = """
    CREATE TABLE identities (workspace_id TEXT NOT NULL, member_id TEXT NOT NULL UNIQUE,
        issuer TEXT NOT NULL, subject TEXT NOT NULL,
        PRIMARY KEY (workspace_id, issuer, subject),
        FOREIGN KEY (member_id) REFERENCES members(id));
    CREATE TABLE project_memberships (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
        member_id TEXT NOT NULL, role TEXT CHECK (role IN ('editor', 'viewer')),
        version INTEGER NOT NULL CHECK (version >= 1),
        PRIMARY KEY (workspace_id, project_id, member_id),
        FOREIGN KEY (project_id) REFERENCES entities(id),
        FOREIGN KEY (member_id) REFERENCES members(id));
    CREATE TABLE source_memberships (workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
        member_id TEXT NOT NULL, allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        version INTEGER NOT NULL CHECK (version >= 1),
        PRIMARY KEY (workspace_id, source_id, member_id),
        FOREIGN KEY (source_id) REFERENCES entities(id),
        FOREIGN KEY (member_id) REFERENCES members(id));
    CREATE TABLE access_events (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        actor_member_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        route TEXT NOT NULL, reason TEXT NOT NULL, at_utc TEXT NOT NULL,
        before_json TEXT, after_json TEXT NOT NULL, request_hash TEXT NOT NULL,
        FOREIGN KEY (actor_member_id) REFERENCES members(id));
"""


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def workspace_path(home: Path, workspace_id: str) -> Path:
    return home / "workspaces" / f"{uuid_text(workspace_id)}.sqlite3"


class WorkspaceStore:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        if not self.path.is_file():
            raise WorkspaceError("workspace_not_initialized", 404)
        uri = f"{self.path.resolve().as_uri()}?mode={'rw' if write else 'ro'}"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            else:
                connection.execute("BEGIN")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @classmethod
    def initialize(cls, home: Path, name: str, timezone: str, owner_name: str) -> tuple[str, str]:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        from deskly.workspace_model import bounded_text

        name = bounded_text(name, required=True, limit=120)
        owner_name = bounded_text(owner_name, required=True, limit=120)
        try:
            ZoneInfo(timezone)
        except ZoneInfoNotFoundError as exc:
            # Windows Python can lack an IANA database; these two zones are exact.
            if timezone not in {"Asia/Tokyo", "UTC"}:
                raise WorkspaceError("invalid_timezone") from exc
        except ValueError as exc:
            raise WorkspaceError("invalid_timezone") from exc
        workspace_id, member_id = str(uuid4()), str(uuid4())
        directory = home / "workspaces"
        directory.mkdir(parents=True, exist_ok=True)
        path = workspace_path(home, workspace_id)
        with path.open("xb"):
            pass
        connection = sqlite3.connect(path)
        try:
            connection.executescript("""
                PRAGMA foreign_keys=ON;
                PRAGMA journal_mode=WAL;
                CREATE TABLE metadata (schema_version INTEGER NOT NULL, workspace_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL, timezone TEXT NOT NULL);
                CREATE TABLE members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                    name TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL);
                CREATE TABLE entities (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                    project_id TEXT, type TEXT NOT NULL, version INTEGER NOT NULL,
                    data TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX entities_project ON entities (workspace_id, project_id, type);
                CREATE TABLE events (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                    entity_id TEXT NOT NULL, member_id TEXT NOT NULL, route TEXT NOT NULL,
                    reason TEXT NOT NULL, at_utc TEXT NOT NULL, before_json TEXT,
                    after_json TEXT NOT NULL, request_hash TEXT NOT NULL);
            """)
            connection.executescript(ACCESS_SCHEMA)
            connection.execute("INSERT INTO metadata VALUES (?, ?, ?, ?)",
                               (SCHEMA_VERSION, workspace_id, name, timezone))
            connection.execute("INSERT INTO members VALUES (?, ?, ?, 'owner', 1)",
                               (member_id, workspace_id, owner_name))
            connection.commit()
        except Exception:
            connection.close()
            path.unlink(missing_ok=True)
            raise
        finally:
            connection.close()
        return workspace_id, member_id

    def upgrade_access(self, workspace_id: str, backup_destination: Path) -> None:
        """Explicitly upgrade a v1 workspace after a checked, exclusive backup."""
        from deskly.workspace_backup import export_workspace

        uuid_text(workspace_id)
        with self.connect(write=True) as db:
            meta = db.execute("SELECT workspace_id, schema_version FROM metadata").fetchone()
            if meta is None or meta["workspace_id"] != workspace_id:
                raise WorkspaceError("workspace_not_found", 404)
            if meta["schema_version"] != 1:
                raise WorkspaceError("invalid_schema_version", 409)
            manifest = export_workspace(self.path.parent.parent, workspace_id, backup_destination)
            if manifest["schema_version"] != 1:
                raise WorkspaceError("invalid_backup")
            for statement in ACCESS_SCHEMA.split(";"):
                if statement.strip():
                    db.execute(statement)
            db.execute("UPDATE metadata SET schema_version=?", (SCHEMA_VERSION,))

    def principal(self, workspace_id: str) -> Principal:
        uuid_text(workspace_id)
        with self.connect() as db:
            meta = db.execute("SELECT workspace_id FROM metadata").fetchone()
            if meta is None or meta["workspace_id"] != workspace_id:
                raise WorkspaceError("workspace_not_found", 404)
            owner = db.execute("SELECT * FROM members WHERE role='owner'").fetchone()
            if owner is None or not owner["active"]:
                raise WorkspaceError("member_inactive", 403)
            return Principal(workspace_id, owner["id"], owner["role"], True)

    def identity_principal(self, workspace_id: str, issuer: str, subject: str) -> Principal:
        """Resolve an already verified external identity by exact issuer and subject."""
        uuid_text(workspace_id)
        if not issuer or not subject:
            raise WorkspaceError("unauthorized", 401)
        with self.connect() as db:
            meta = db.execute("SELECT workspace_id, schema_version FROM metadata").fetchone()
            if meta is None or meta["workspace_id"] != workspace_id:
                raise WorkspaceError("workspace_not_found", 404)
            if meta["schema_version"] != SCHEMA_VERSION:
                raise WorkspaceError("sharing_not_enabled", 409)
            row = db.execute("""SELECT m.id, m.role, m.active FROM identities i
                JOIN members m ON m.id=i.member_id AND m.workspace_id=i.workspace_id
                WHERE i.workspace_id=? AND i.issuer=? AND i.subject=?""",
                             (workspace_id, issuer, subject)).fetchone()
            if row is None:
                raise WorkspaceError("unauthorized", 401)
            if not row["active"]:
                raise WorkspaceError("member_inactive", 403)
            return Principal(workspace_id, row["id"], row["role"], True)

    @staticmethod
    def entity(row: sqlite3.Row) -> dict[str, object]:
        data = json.loads(row["data"])
        if row["type"] == "reference":
            data.setdefault("source_id", "")
        return {"id": row["id"], "workspace_id": row["workspace_id"],
                "project_id": row["project_id"], "type": row["type"],
                "version": row["version"], "archived": bool(row["archived"]),
                **data}

    @staticmethod
    def read_entity(db: sqlite3.Connection, entity_id: str, workspace_id: str) -> dict[str, object]:
        row = db.execute("SELECT * FROM entities WHERE id=? AND workspace_id=?",
                         (uuid_text(entity_id), workspace_id)).fetchone()
        if row is None:
            raise WorkspaceError("not_found", 404)
        return WorkspaceStore.entity(row)
