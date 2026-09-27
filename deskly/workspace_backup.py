"""Versioned, checked export and empty-target restore for workspace data."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from deskly import __version__
from deskly.workspace_model import WorkspaceError, uuid_text
from deskly.workspace_store import ACCESS_SCHEMA, SCHEMA_VERSION, WorkspaceStore, workspace_path

FORMAT = "deskly-workspace-v1"
BASE_TABLES = ("metadata", "members", "entities", "events")
ACCESS_TABLES = ("identities", "project_memberships", "source_memberships", "access_events")
COLUMNS = {
    "metadata": {"schema_version", "workspace_id", "name", "timezone"},
    "members": {"id", "workspace_id", "name", "role", "active"},
    "entities": {"id", "workspace_id", "project_id", "type", "version", "data", "archived"},
    "events": {"operation_id", "workspace_id", "entity_id", "member_id", "route",
               "reason", "at_utc", "before_json", "after_json", "request_hash"},
    "identities": {"workspace_id", "member_id", "issuer", "subject"},
    "project_memberships": {"workspace_id", "project_id", "member_id", "role", "version"},
    "source_memberships": {"workspace_id", "source_id", "member_id", "allowed", "version"},
    "access_events": {"operation_id", "workspace_id", "actor_member_id", "target_type",
                      "target_id", "route", "reason", "at_utc", "before_json", "after_json",
                      "request_hash"},
}


def _tables(version: int) -> tuple[str, ...]:
    if version == 1:
        return BASE_TABLES
    if version == SCHEMA_VERSION:
        return BASE_TABLES + ACCESS_TABLES
    raise WorkspaceError("invalid_schema_version")


def _line(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def export_workspace(home: Path, workspace_id: str, destination: Path) -> dict[str, object]:
    store = WorkspaceStore(workspace_path(home, workspace_id))
    store.principal(workspace_id)
    with store.connect() as db:
        version = db.execute("SELECT schema_version FROM metadata").fetchone()[0]
        tables = _tables(version)
        rows = {table: [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY 1")]
                for table in tables}
    manifest = {"format": FORMAT, "schema_version": version,
                "app_version": __version__, "workspace_id": workspace_id,
                "created_at_utc": datetime.now(UTC).isoformat(),
                "counts": {table: len(rows[table]) for table in tables}}
    data = b"".join(_line({"table": table, "row": row})
                    for table in tables for row in rows[table])
    if len(data) > 64 * 1024 * 1024:
        raise WorkspaceError("backup_too_large")
    manifest["sha256"] = hashlib.sha256(data).hexdigest()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as stream:
        stream.write(_line(manifest))
        stream.write(data)
    return manifest


def restore_workspace(source: Path, home: Path) -> dict[str, object]:
    if source.stat().st_size > 64 * 1024 * 1024:
        raise WorkspaceError("invalid_backup")
    raw = source.read_bytes()
    if len(raw) > 64 * 1024 * 1024 or not raw.endswith(b"\n"):
        raise WorkspaceError("invalid_backup")
    header, separator, data = raw.partition(b"\n")
    if not separator:
        raise WorkspaceError("invalid_backup")
    try:
        manifest = json.loads(header)
        if manifest["format"] != FORMAT:
            raise WorkspaceError("invalid_backup")
        tables = _tables(manifest["schema_version"])
        workspace_id = uuid_text(manifest["workspace_id"])
        if manifest["sha256"] != hashlib.sha256(data).hexdigest():
            raise WorkspaceError("checksum_mismatch")
        rows: dict[str, list[dict[str, object]]] = {table: [] for table in tables}
        for line in data.splitlines():
            item = json.loads(line)
            table = item["table"]
            if table not in rows or not isinstance(item["row"], dict) or set(item["row"]) != COLUMNS[table]:
                raise WorkspaceError("invalid_backup")
            rows[table].append(item["row"])
        if {table: len(rows[table]) for table in tables} != manifest["counts"]:
            raise WorkspaceError("invalid_backup")
        if len(rows["metadata"]) != 1 or rows["metadata"][0]["workspace_id"] != workspace_id:
            raise WorkspaceError("invalid_backup")
        if rows["metadata"][0]["schema_version"] != manifest["schema_version"]:
            raise WorkspaceError("invalid_backup")
    except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkspaceError("invalid_backup") from exc
    destination = workspace_path(home, workspace_id)
    if destination.exists():
        raise WorkspaceError("restore_target_exists", 409)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # The schema is created in a temporary sibling and only published after verification.
    temporary = destination.with_suffix(".restore-tmp")
    if temporary.exists():
        raise WorkspaceError("restore_target_exists", 409)
    db = sqlite3.connect(temporary)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
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
        if manifest["schema_version"] == SCHEMA_VERSION:
            db.executescript(ACCESS_SCHEMA)
        for table in tables:
            for row in rows[table]:
                columns = list(row)
                db.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                           tuple(row[column] for column in columns))
        db.commit()
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise WorkspaceError("invalid_backup")
        for row in db.execute("SELECT workspace_id,project_id,type,data,version FROM entities"):
            if row[0] != workspace_id or row[4] < 1:
                raise WorkspaceError("invalid_backup")
            if row[2] not in {"project", "source"}:
                parent = db.execute("SELECT type FROM entities WHERE id=? AND workspace_id=?",
                                    (row[1], workspace_id)).fetchone()
                if parent is None or parent[0] != "project":
                    raise WorkspaceError("invalid_backup")
            json.loads(row[3])
        for row in db.execute("SELECT workspace_id,entity_id,member_id,before_json,after_json FROM events"):
            if row[0] != workspace_id or db.execute("SELECT 1 FROM entities WHERE id=?", (row[1],)).fetchone() is None or db.execute("SELECT 1 FROM members WHERE id=?", (row[2],)).fetchone() is None:
                raise WorkspaceError("invalid_backup")
            if row[3] is not None:
                json.loads(row[3])
            json.loads(row[4])
        owner = db.execute("SELECT 1 FROM members WHERE workspace_id=? AND role='owner' AND active=1",
                           (workspace_id,)).fetchone()
        if owner is None:
            raise WorkspaceError("invalid_backup")
        if manifest["schema_version"] == SCHEMA_VERSION:
            for row in db.execute("SELECT workspace_id,member_id,issuer,subject FROM identities"):
                if row[0] != workspace_id or not row[2] or not row[3]:
                    raise WorkspaceError("invalid_backup")
            for table, target_type in (("project_memberships", "project"),
                                       ("source_memberships", "source")):
                target_column = "project_id" if target_type == "project" else "source_id"
                for row in db.execute(f"SELECT workspace_id,{target_column} FROM {table}"):
                    target = db.execute("SELECT type FROM entities WHERE id=? AND workspace_id=?",
                                        (row[1], workspace_id)).fetchone()
                    if row[0] != workspace_id or target is None or target[0] != target_type:
                        raise WorkspaceError("invalid_backup")
            for row in db.execute("SELECT workspace_id,before_json,after_json FROM access_events"):
                if row[0] != workspace_id:
                    raise WorkspaceError("invalid_backup")
                if row[1] is not None:
                    json.loads(row[1])
                json.loads(row[2])
        db.close()
        temporary.rename(destination)
    except Exception:
        db.close()
        temporary.unlink(missing_ok=True)
        raise
    return manifest
