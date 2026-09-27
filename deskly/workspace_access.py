"""Workspace membership changes and project grants for a verified principal."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from deskly.workspace_model import Principal, WorkspaceError, bounded_text, uuid_text
from deskly.workspace_store import SCHEMA_VERSION, WorkspaceStore, utc_now


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _identity(issuer: object, subject: object) -> tuple[str, str]:
    if not isinstance(issuer, str) or not isinstance(subject, str):
        raise WorkspaceError("invalid_identity")
    try:
        parsed = urlsplit(issuer)
    except ValueError as exc:
        raise WorkspaceError("invalid_identity") from exc
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
        or parsed.query or parsed.fragment or not subject or len(subject) > 500
        or any(ord(char) < 0x20 for char in subject)):
        raise WorkspaceError("invalid_identity")
    return issuer, subject


class WorkspaceAccess:
    def __init__(self, store: WorkspaceStore, workspace_id: str, principal: Principal):
        self.store = store
        self.workspace_id = uuid_text(workspace_id)
        self.principal = principal

    def _owner(self, db: sqlite3.Connection) -> None:
        version = db.execute("SELECT schema_version FROM metadata WHERE workspace_id=?",
                             (self.workspace_id,)).fetchone()
        if version is None or version[0] != SCHEMA_VERSION:
            raise WorkspaceError("sharing_not_enabled", 409)
        row = db.execute("SELECT role, active FROM members WHERE id=? AND workspace_id=?",
                         (self.principal.member_id, self.workspace_id)).fetchone()
        if row is None or row["role"] != "owner" or not row["active"]:
            raise WorkspaceError("forbidden", 403)

    def _replay(self, db: sqlite3.Connection, operation_id: str,
                payload: object) -> tuple[str, dict[str, Any] | None]:
        request_hash = hashlib.sha256(_json(payload).encode()).hexdigest()
        row = db.execute("SELECT actor_member_id,request_hash,after_json FROM access_events WHERE operation_id=?",
                         (operation_id,)).fetchone()
        if row is None:
            return request_hash, None
        if row["actor_member_id"] != self.principal.member_id or row["request_hash"] != request_hash:
            raise WorkspaceError("operation_conflict", 409)
        return request_hash, json.loads(row["after_json"])

    def _event(self, db: sqlite3.Connection, operation_id: str, target_type: str,
               target_id: str, reason: str, before: object, after: object,
               request_hash: str) -> None:
        db.execute("""INSERT INTO access_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                   (operation_id, self.workspace_id, self.principal.member_id,
                    target_type, target_id, "workspace-access", reason, utc_now(),
                   _json(before) if before is not None else None, _json(after), request_hash))

    def members_and_grants(self) -> dict[str, Any]:
        """Owner-only shared Web view; identities and source grants stay private."""
        with self.store.connect() as db:
            self._owner(db)
            members = [{"member_id": row["id"], "name": row["name"],
                        "role": row["role"], "active": bool(row["active"]),
                        "version": 1 if row["active"] else 2}
                       for row in db.execute("""SELECT id,name,role,active FROM members
                           WHERE workspace_id=? ORDER BY name,id""", (self.workspace_id,))]
            grants = [dict(row) for row in db.execute("""SELECT project_id,member_id,role,version
                FROM project_memberships WHERE workspace_id=? ORDER BY project_id,member_id""",
                                                (self.workspace_id,))]
            return {"members": members, "grants": grants}

    def bind_owner_identity(self, issuer: str, subject: str, *, operation_id: str,
                            reason: str) -> dict[str, Any]:
        """Local owner bootstrap; never expose this method through shared HTTP."""
        issuer, subject = _identity(issuer, subject)
        operation_id = uuid_text(operation_id)
        reason = bounded_text(reason, required=True, limit=240)
        payload = {"kind": "owner_identity", "issuer": issuer, "subject": subject,
                   "reason": reason}
        with self.store.connect(write=True) as db:
            self._owner(db)
            request_hash, prior = self._replay(db, operation_id, payload)
            if prior is not None:
                return prior
            if db.execute("SELECT 1 FROM identities WHERE workspace_id=?",
                          (self.workspace_id,)).fetchone():
                raise WorkspaceError("identity_already_bound", 409)
            db.execute("INSERT INTO identities VALUES (?, ?, ?, ?)",
                       (self.workspace_id, self.principal.member_id, issuer, subject))
            result = {"member_id": self.principal.member_id, "issuer": issuer,
                      "subject": subject}
            self._event(db, operation_id, "identity", self.principal.member_id,
                        reason, None, result, request_hash)
            return result

    def add_member(self, name: str, issuer: str, subject: str, *, operation_id: str,
                   reason: str) -> dict[str, Any]:
        issuer, subject = _identity(issuer, subject)
        name = bounded_text(name, required=True, limit=120)
        operation_id = uuid_text(operation_id)
        reason = bounded_text(reason, required=True, limit=240)
        payload = {"kind": "member", "name": name, "issuer": issuer,
                   "subject": subject, "reason": reason}
        with self.store.connect(write=True) as db:
            self._owner(db)
            request_hash, prior = self._replay(db, operation_id, payload)
            if prior is not None:
                return prior
            if db.execute("SELECT 1 FROM identities WHERE workspace_id=? AND issuer=? AND subject=?",
                          (self.workspace_id, issuer, subject)).fetchone():
                raise WorkspaceError("identity_already_bound", 409)
            member_id = str(uuid4())
            db.execute("INSERT INTO members VALUES (?, ?, ?, 'member', 1)",
                       (member_id, self.workspace_id, name))
            db.execute("INSERT INTO identities VALUES (?, ?, ?, ?)",
                       (self.workspace_id, member_id, issuer, subject))
            result = {"member_id": member_id, "name": name, "active": True,
                      "role": "member", "issuer": issuer, "subject": subject}
            self._event(db, operation_id, "member", member_id, reason, None,
                        result, request_hash)
            return result

    def set_project_role(self, project_id: str, member_id: str, role: str | None,
                         *, expected_version: int, operation_id: str,
                         reason: str) -> dict[str, Any]:
        project_id, member_id = uuid_text(project_id), uuid_text(member_id)
        operation_id = uuid_text(operation_id)
        reason = bounded_text(reason, required=True, limit=240)
        if role not in {"editor", "viewer", None} or isinstance(expected_version, bool) or (
            not isinstance(expected_version, int) or expected_version < 0
        ):
            raise WorkspaceError("invalid_grant")
        payload = {"kind": "project_role", "project_id": project_id,
                   "member_id": member_id, "role": role,
                   "expected_version": expected_version, "reason": reason}
        with self.store.connect(write=True) as db:
            self._owner(db)
            request_hash, prior = self._replay(db, operation_id, payload)
            if prior is not None:
                return prior
            project = self.store.read_entity(db, project_id, self.workspace_id)
            if project["type"] != "project" or project["archived"]:
                raise WorkspaceError("invalid_project", 404)
            member = db.execute("SELECT role,active FROM members WHERE id=? AND workspace_id=?",
                                (member_id, self.workspace_id)).fetchone()
            if member is None or not member["active"] or member["role"] == "owner":
                raise WorkspaceError("invalid_member", 403)
            current = db.execute("""SELECT role,version FROM project_memberships
                WHERE workspace_id=? AND project_id=? AND member_id=?""",
                                 (self.workspace_id, project_id, member_id)).fetchone()
            before = dict(current) if current else None
            if expected_version != (current["version"] if current else 0):
                raise WorkspaceError("version_conflict", 409)
            if role != "editor":
                for entity in db.execute("""SELECT type,data FROM entities
                    WHERE workspace_id=? AND archived=0 AND (id=? OR project_id=?)
                    AND type IN ('project','milestone','work_item')""",
                                         (self.workspace_id, project_id, project_id)):
                    data = json.loads(entity["data"])
                    key = "owner_id" if entity["type"] == "project" else "assignee_id"
                    if data.get(key) == member_id and data.get("state") not in {"完了", "終了", "取りやめ"}:
                        raise WorkspaceError("assigned_work_remaining", 409)
            if role is None:
                if current is None or current["role"] is None:
                    raise WorkspaceError("invalid_grant")
                db.execute("""UPDATE project_memberships SET role=NULL,version=?
                    WHERE workspace_id=? AND project_id=? AND member_id=?""",
                           (expected_version + 1, self.workspace_id, project_id, member_id))
                result = {"project_id": project_id, "member_id": member_id,
                          "role": None, "version": expected_version + 1}
            else:
                version = expected_version + 1
                db.execute("""INSERT INTO project_memberships VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(workspace_id,project_id,member_id)
                    DO UPDATE SET role=excluded.role,version=excluded.version""",
                           (self.workspace_id, project_id, member_id, role, version))
                result = {"project_id": project_id, "member_id": member_id,
                          "role": role, "version": version}
            self._event(db, operation_id, "project_role", project_id, reason,
                        before, result, request_hash)
            return result

    def set_source_access(self, source_id: str, member_id: str, allowed: bool,
                          *, expected_version: int, operation_id: str,
                          reason: str) -> dict[str, Any]:
        source_id, member_id = uuid_text(source_id), uuid_text(member_id)
        operation_id = uuid_text(operation_id)
        reason = bounded_text(reason, required=True, limit=240)
        if not isinstance(allowed, bool) or isinstance(expected_version, bool) or (
            not isinstance(expected_version, int) or expected_version < 0
        ):
            raise WorkspaceError("invalid_grant")
        payload = {"kind": "source_access", "source_id": source_id,
                   "member_id": member_id, "allowed": allowed,
                   "expected_version": expected_version, "reason": reason}
        with self.store.connect(write=True) as db:
            self._owner(db)
            request_hash, prior = self._replay(db, operation_id, payload)
            if prior is not None:
                return prior
            source = self.store.read_entity(db, source_id, self.workspace_id)
            if source["type"] != "source" or source["archived"]:
                raise WorkspaceError("invalid_source", 404)
            member = db.execute("SELECT role,active FROM members WHERE id=? AND workspace_id=?",
                                (member_id, self.workspace_id)).fetchone()
            if member is None or not member["active"] or member["role"] == "owner":
                raise WorkspaceError("invalid_member", 403)
            current = db.execute("""SELECT allowed,version FROM source_memberships
                WHERE workspace_id=? AND source_id=? AND member_id=?""",
                                 (self.workspace_id, source_id, member_id)).fetchone()
            before = dict(current) if current else None
            if expected_version != (current["version"] if current else 0):
                raise WorkspaceError("version_conflict", 409)
            if not allowed and current is None:
                raise WorkspaceError("invalid_grant")
            version = expected_version + 1
            db.execute("""INSERT INTO source_memberships VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id,source_id,member_id)
                DO UPDATE SET allowed=excluded.allowed,version=excluded.version""",
                       (self.workspace_id, source_id, member_id, int(allowed), version))
            result = {"source_id": source_id, "member_id": member_id,
                      "allowed": allowed, "version": version}
            self._event(db, operation_id, "source_access", source_id, reason,
                        before, result, request_hash)
            return result

    def deactivate_member(self, member_id: str, *, operation_id: str,
                          reason: str, expected_version: int | None = None) -> dict[str, Any]:
        """Revoke access and transfer unfinished assignments to the active owner."""
        member_id = uuid_text(member_id)
        operation_id = uuid_text(operation_id)
        reason = bounded_text(reason, required=True, limit=240)
        if expected_version is not None and (isinstance(expected_version, bool) or expected_version != 1):
            raise WorkspaceError("version_conflict", 409)
        payload = {"kind": "deactivate_member", "member_id": member_id, "reason": reason}
        with self.store.connect(write=True) as db:
            self._owner(db)
            request_hash, prior = self._replay(db, operation_id, payload)
            if prior is not None:
                return prior
            member = db.execute("SELECT id,name,role,active FROM members WHERE id=? AND workspace_id=?",
                                (member_id, self.workspace_id)).fetchone()
            if expected_version is not None and (member is None or not member["active"]):
                raise WorkspaceError("version_conflict", 409)
            if member is None or not member["active"]:
                raise WorkspaceError("invalid_member", 403)
            if member["role"] == "owner":
                remaining = db.execute("""SELECT id FROM members
                    WHERE workspace_id=? AND role='owner' AND active=1 AND id<>? ORDER BY id LIMIT 1""",
                                       (self.workspace_id, member_id)).fetchone()
                if remaining is None:
                    raise WorkspaceError("last_owner", 409)
                takeover_owner_id = remaining["id"]
            else:
                takeover_owner_id = self.principal.member_id
            transferred = 0
            entities = db.execute("""SELECT * FROM entities WHERE workspace_id=? AND archived=0
                AND type IN ('project','milestone','work_item')""", (self.workspace_id,)).fetchall()
            for row in entities:
                before_data = json.loads(row["data"])
                key = "owner_id" if row["type"] == "project" else "assignee_id"
                if before_data.get(key) != member_id or before_data.get("state") in {"完了", "終了", "取りやめ"}:
                    continue
                after_data = {**before_data, key: takeover_owner_id}
                version = row["version"] + 1
                changed = db.execute("UPDATE entities SET data=?,version=? WHERE id=? AND version=?",
                                     (_json(after_data), version, row["id"], row["version"]))
                if changed.rowcount != 1:
                    raise WorkspaceError("version_conflict", 409)
                before = {"id": row["id"], "workspace_id": self.workspace_id,
                          "project_id": row["project_id"], "type": row["type"],
                          "version": row["version"], "archived": False, **before_data}
                after = {**before, **after_data, "version": version}
                db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (str(uuid4()), self.workspace_id, row["id"],
                            self.principal.member_id, "workspace-access/takeover", reason,
                            utc_now(), _json(before), _json(after), request_hash))
                transferred += 1
            db.execute("UPDATE members SET active=0 WHERE id=? AND workspace_id=?",
                       (member_id, self.workspace_id))
            result = {"member_id": member_id, "active": False, "transferred": transferred}
            self._event(db, operation_id, "member", member_id, reason,
                        dict(member), result, request_hash)
            return result

    def history(self) -> list[dict[str, Any]]:
        with self.store.connect() as db:
            self._owner(db)
            events: list[dict[str, Any]] = []
            for row in db.execute("""SELECT operation_id,actor_member_id,target_type,
                target_id,route,reason,at_utc,before_json,after_json
                FROM access_events WHERE workspace_id=? ORDER BY at_utc,operation_id""",
                                  (self.workspace_id,)):
                event = dict(row)
                before, after = event.pop("before_json"), event.pop("after_json")
                events.append({**event, "before": json.loads(before) if before else None,
                               "after": json.loads(after)})
            return events
