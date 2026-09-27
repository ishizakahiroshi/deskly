"""Personal workspace reads and confirmed, versioned changes."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid4, uuid5

from deskly.workspace_model import (
    ENTITY_TYPES,
    ITEM_STATES,
    KINDS,
    PROJECT_STATES,
    Principal,
    WorkspaceError,
    bounded_text,
    optional_date,
    reference_target,
    uuid_text,
)
from deskly.workspace_store import WorkspaceStore, utc_now, workspace_path

FIELDS = {
    "source": {"label", "adapter", "binding"},
    "project": {"name", "purpose", "owner_id", "state"},
    "milestone": {"goal", "acceptance", "assignee_id", "check_date", "state"},
    "work_item": {"kind", "title", "assignee_id", "next_action", "check_date",
                  "waiting_reason", "state", "milestone_id"},
    "reference": {"kind", "target", "label", "linked_id", "source_id"},
}
REQUIRED = {
    "source": {"label", "adapter", "binding"},
    "project": {"name", "purpose", "owner_id", "state"},
    "milestone": {"goal", "acceptance", "assignee_id", "state"},
    "work_item": {"kind", "title", "assignee_id", "next_action", "state"},
    "reference": {"kind", "target", "label"},
}


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class WorkspaceService:
    def __init__(self, home: Path, workspace_id: str, *, secret: bytes,
                 identity: tuple[str, str] | None = None):
        self.home = home
        self.workspace_id = uuid_text(workspace_id)
        self.store = WorkspaceStore(workspace_path(home, workspace_id))
        self.secret = secret
        self.identity = identity

    def principal(self) -> Principal:
        if self.identity is not None:
            return self.store.identity_principal(self.workspace_id, *self.identity)
        return self.store.principal(self.workspace_id)

    def _project_access(self, db: sqlite3.Connection, principal: Principal,
                        project_id: str, *, write: bool = False) -> None:
        member = self._active_member(db, principal)
        if member["role"] == "owner":
            return
        grant = db.execute("""SELECT role FROM project_memberships
            WHERE workspace_id=? AND project_id=? AND member_id=?""",
                           (self.workspace_id, project_id, principal.member_id)).fetchone()
        if grant is None or grant["role"] is None or (write and grant["role"] != "editor"):
            raise WorkspaceError("not_found", 404)

    def _active_member(self, db: sqlite3.Connection, principal: Principal) -> sqlite3.Row:
        member = db.execute("SELECT role, active FROM members WHERE id=? AND workspace_id=?",
                            (principal.member_id, self.workspace_id)).fetchone()
        if member is None or not member["active"]:
            raise WorkspaceError("member_inactive", 403)
        return member

    def _owner_access(self, db: sqlite3.Connection, principal: Principal) -> None:
        member = db.execute("SELECT role, active FROM members WHERE id=? AND workspace_id=?",
                            (principal.member_id, self.workspace_id)).fetchone()
        if member is None or not member["active"] or member["role"] != "owner":
            raise WorkspaceError("forbidden", 403)

    def _source_access(self, db: sqlite3.Connection, principal: Principal,
                       source_id: str) -> bool:
        if principal.role == "owner":
            return True
        return db.execute("""SELECT 1 FROM source_memberships
            WHERE workspace_id=? AND source_id=? AND member_id=? AND allowed=1""",
                          (self.workspace_id, source_id, principal.member_id)).fetchone() is not None

    def _member(self, db: sqlite3.Connection, member_id: str) -> None:
        row = db.execute("SELECT active FROM members WHERE id=? AND workspace_id=?",
                         (uuid_text(member_id), self.workspace_id)).fetchone()
        if row is None or not row["active"]:
            raise WorkspaceError("invalid_member", 403)

    def _validated_data(self, db: sqlite3.Connection, kind: str, data: object,
                        project_id: str | None) -> dict[str, object]:
        if kind not in ENTITY_TYPES or not isinstance(data, dict):
            raise WorkspaceError("invalid_fields")
        if kind == "reference" and set(data) == FIELDS[kind] - {"source_id"}:
            data = {**data, "source_id": ""}
        if set(data) != FIELDS[kind]:
            raise WorkspaceError("invalid_fields")
        if kind not in {"project", "source"}:
            if project_id is None:
                raise WorkspaceError("invalid_project")
            parent = self.store.read_entity(db, project_id, self.workspace_id)
            if parent["type"] != "project" or parent["archived"]:
                raise WorkspaceError("invalid_project")
        result: dict[str, object] = {}
        for key, value in data.items():
            if key.endswith("_id") and value:
                result[key] = uuid_text(value)
            elif key in {"check_date"}:
                result[key] = optional_date(value)
            else:
                result[key] = bounded_text(value, required=key in REQUIRED[kind],
                                           limit=500 if key in {"purpose", "acceptance", "next_action", "waiting_reason", "target"} else 120)
        if kind == "source":
            if result["adapter"] not in {"contact", "external_case"}:
                raise WorkspaceError("invalid_source")
            if not re.fullmatch(r"[a-z][a-z0-9_-]*", str(result["binding"])):
                raise WorkspaceError("invalid_source")
            if result["adapter"] == "external_case" and result["binding"] != "issuepost":
                raise WorkspaceError("invalid_source")
        elif kind == "project":
            if result["state"] not in PROJECT_STATES:
                raise WorkspaceError("invalid_state")
            self._member(db, str(result["owner_id"]))
        elif kind in {"milestone", "work_item"}:
            if result["state"] not in ITEM_STATES:
                raise WorkspaceError("invalid_state")
            self._member(db, str(result["assignee_id"]))
            assignee = db.execute("SELECT role FROM members WHERE id=?",
                                  (result["assignee_id"],)).fetchone()
            if assignee["role"] != "owner" and db.execute(
                "SELECT 1 FROM project_memberships WHERE workspace_id=? AND project_id=? AND member_id=? AND role IS NOT NULL",
                (self.workspace_id, project_id, result["assignee_id"])).fetchone() is None:
                raise WorkspaceError("invalid_member", 403)
            if kind == "work_item":
                if result["kind"] not in KINDS:
                    raise WorkspaceError("invalid_kind")
                milestone = result["milestone_id"]
                if milestone:
                    linked = self.store.read_entity(db, str(milestone), self.workspace_id)
                    if linked["type"] != "milestone" or linked["project_id"] != project_id or linked["archived"]:
                        raise WorkspaceError("invalid_reference")
        else:
            reference_kind = str(result["kind"])
            if reference_kind in {"md", "https"}:
                if result["source_id"]:
                    raise WorkspaceError("invalid_source")
                result["target"] = reference_target(result["target"], reference_kind)
            elif reference_kind in {"contact", "external_case"}:
                source_id = result["source_id"]
                if not source_id:
                    raise WorkspaceError("invalid_source")
                source = self.store.read_entity(db, str(source_id), self.workspace_id)
                if source["type"] != "source" or source["archived"] or source["adapter"] != reference_kind:
                    raise WorkspaceError("invalid_source")
                if reference_kind == "contact":
                    from deskly.model import validate_contact_id

                    try:
                        validate_contact_id(result["target"])
                    except ValueError as exc:
                        raise WorkspaceError("invalid_reference") from exc
                else:
                    result["target"] = bounded_text(result["target"], required=True, limit=120)
            else:
                raise WorkspaceError("invalid_reference")
            linked_id = result["linked_id"]
            if linked_id:
                linked = self.store.read_entity(db, str(linked_id), self.workspace_id)
                if linked["project_id"] != project_id or linked["type"] not in {"milestone", "work_item"}:
                    raise WorkspaceError("invalid_reference")
        return result

    def _prepare(self, db: sqlite3.Connection, request: object, principal: Principal,
                 *, allow_generated_id: bool) -> tuple[dict[str, Any], dict[str, object] | None, dict[str, object]]:
        if not isinstance(request, dict) or set(request) != {
            "operation_id", "action", "type", "id", "project_id", "version", "data", "reason"
        }:
            raise WorkspaceError("invalid_request")
        operation_id = uuid_text(request["operation_id"])
        action = request["action"]
        kind = request["type"]
        if (not isinstance(action, str) or not isinstance(kind, str)
            or action not in {"create", "update", "archive", "restore"} or kind not in ENTITY_TYPES):
            raise WorkspaceError("invalid_action")
        entity_id = str(uuid4()) if request["id"] is None and action == "create" and allow_generated_id else uuid_text(request["id"])
        project_id = None if kind in {"project", "source"} else uuid_text(request["project_id"])
        if kind in {"project", "source"} and request["project_id"] is not None:
            raise WorkspaceError("invalid_project")
        if kind == "source" or (kind == "project" and action == "create"):
            self._owner_access(db, principal)
        elif kind == "project":
            self._project_access(db, principal, entity_id, write=True)
        elif project_id is not None:
            self._project_access(db, principal, project_id, write=True)
        reason = bounded_text(request["reason"], required=True, limit=240)
        before = None
        if action == "create":
            if request["version"] is not None:
                raise WorkspaceError("invalid_version")
            if db.execute("SELECT 1 FROM entities WHERE id=?", (entity_id,)).fetchone():
                raise WorkspaceError("duplicate_id", 409)
            data = self._validated_data(db, kind, request["data"], project_id)
            after = {"id": entity_id, "workspace_id": self.workspace_id,
                     "project_id": project_id, "type": kind, "version": 1,
                     "archived": False, **data}
        else:
            before = self.store.read_entity(db, entity_id, self.workspace_id)
            if before["type"] != kind or before["project_id"] != project_id:
                raise WorkspaceError("invalid_target", 404)
            version = request["version"]
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                raise WorkspaceError("invalid_version")
            if before["version"] != version:
                raise WorkspaceError("version_conflict", 409)
            if before["archived"] != (action == "restore"):
                raise WorkspaceError("archived", 409)
            if action == "restore" and kind not in {"project", "source"}:
                if project_id is None:
                    raise WorkspaceError("invalid_project")
                parent = self.store.read_entity(db, project_id, self.workspace_id)
                if parent["type"] != "project" or parent["archived"]:
                    raise WorkspaceError("invalid_project", 409)
            data = ({key: before[key] for key in FIELDS[kind]}
                    if action == "archive"
                    else self._validated_data(db, kind,
                                              {key: before[key] for key in FIELDS[kind]}
                                              if action == "restore" else request["data"],
                                              project_id))
            if kind == "project":
                assigned = db.execute("SELECT role FROM members WHERE id=?",
                                      (data["owner_id"],)).fetchone()
                if assigned["role"] != "owner" and db.execute(
                    "SELECT 1 FROM project_memberships WHERE workspace_id=? AND project_id=? AND member_id=? AND role IS NOT NULL",
                    (self.workspace_id, entity_id, data["owner_id"])).fetchone() is None:
                    raise WorkspaceError("invalid_member", 403)
            if action in {"archive", "restore"} and request["data"] is not None:
                raise WorkspaceError("invalid_fields")
            after = {**before, **data, "version": version + 1,
                     "archived": action == "archive"}
        if kind == "reference" and (
            (before is not None and before.get("kind") in {"contact", "external_case"})
            or after.get("kind") in {"contact", "external_case"}
        ):
            self._owner_access(db, principal)
        normalized = {"operation_id": operation_id, "action": action, "type": kind,
                      "id": entity_id, "project_id": project_id,
                      "version": request["version"], "data": request["data"], "reason": reason}
        return normalized, before, after

    def _token(self, request: dict[str, Any], before: dict[str, object] | None,
               after: dict[str, object], principal: Principal) -> str:
        payload = _canonical({"request": request, "before": before, "after": after,
                              "member_id": principal.member_id})
        return hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()

    def preview(self, request: object) -> dict[str, object]:
        principal = self.principal()
        with self.store.connect() as db:
            normalized, before, after = self._prepare(db, request, principal,
                                                      allow_generated_id=True)
        return {"request": normalized, "before": before, "after": after,
                "preview_token": self._token(normalized, before, after, principal)}

    def apply(self, preview: object) -> dict[str, object]:
        principal = self.principal()
        if not isinstance(preview, dict) or set(preview) != {"request", "before", "after", "preview_token"}:
            raise WorkspaceError("invalid_preview")
        request = preview["request"]
        if not isinstance(request, dict) or not isinstance(preview["preview_token"], str):
            raise WorkspaceError("invalid_preview")
        if not hmac.compare_digest(preview["preview_token"], self._token(request, preview["before"], preview["after"], principal)):
            raise WorkspaceError("invalid_preview", 403)
        request_hash = hashlib.sha256(_canonical(request).encode()).hexdigest()
        with self.store.connect(write=True) as db:
            prior = db.execute("SELECT request_hash, after_json, member_id FROM events WHERE operation_id=?",
                               (request["operation_id"],)).fetchone()
            if prior:
                if prior["request_hash"] != request_hash or prior["member_id"] != principal.member_id:
                    raise WorkspaceError("operation_conflict", 409)
                previous_result = json.loads(prior["after_json"])
                if previous_result["type"] == "source" or (
                    previous_result["type"] == "project" and request["action"] == "create"
                ):
                    self._owner_access(db, principal)
                else:
                    self._project_access(db, principal,
                                         str(previous_result["project_id"] or previous_result["id"]),
                                         write=True)
                return previous_result
            normalized, before, after = self._prepare(db, request, principal, allow_generated_id=False)
            if preview["before"] != before or preview["after"] != after:
                raise WorkspaceError("stale_preview", 409)
            kind = normalized["type"]
            fields = {key: after[key] for key in FIELDS[kind]}
            if normalized["action"] == "create":
                db.execute("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (after["id"], self.workspace_id, after["project_id"], kind,
                            1, _canonical(fields), 0))
            else:
                changed = db.execute("UPDATE entities SET version=?, data=?, archived=? WHERE id=? AND workspace_id=? AND version=?",
                                     (after["version"], _canonical(fields), 1 if after["archived"] else 0,
                                      after["id"], self.workspace_id, before["version"] if before else 0))
                if changed.rowcount != 1:
                    raise WorkspaceError("version_conflict", 409)
            db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (normalized["operation_id"], self.workspace_id, after["id"],
                        principal.member_id, "dashboard", normalized["reason"], utc_now(),
                        _canonical(before) if before else None, _canonical(after), request_hash))
        return after

    def projects(self) -> dict[str, object]:
        principal = self.principal()
        with self.store.connect() as db:
            self._active_member(db, principal)
            meta = db.execute("SELECT name, timezone FROM metadata").fetchone()
            owner = db.execute("SELECT name FROM members WHERE id=?", (principal.member_id,)).fetchone()
            rows = db.execute("SELECT * FROM entities WHERE workspace_id=? AND type='project' AND archived=0 ORDER BY id",
                              (self.workspace_id,)).fetchall()
            projects = [self.store.entity(row) for row in rows]
            if principal.role != "owner":
                visible = {row["project_id"] for row in db.execute(
                    "SELECT project_id FROM project_memberships WHERE workspace_id=? AND member_id=? AND role IS NOT NULL",
                    (self.workspace_id, principal.member_id))}
                projects = [project for project in projects if project["id"] in visible]
            archived_projects = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND type='project' AND archived=1 ORDER BY id",
                (self.workspace_id,))]
            if principal.role != "owner":
                archived_projects = [project for project in archived_projects if project["id"] in visible]
            sources = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND type='source' ORDER BY id",
                (self.workspace_id,))]
            sources = [source for source in sources if self._source_access(db, principal, str(source["id"]))]
            for project in projects:
                items = [self.store.entity(row) for row in db.execute(
                    "SELECT * FROM entities WHERE project_id=? AND archived=0 ORDER BY id", (project["id"],))]
                pending = [item for item in items if item["type"] == "work_item" and item["state"] != "完了"]
                milestones = [item for item in items if item["type"] == "milestone" and item["state"] != "完了"]
                project["next_milestone"] = milestones[0]["goal"] if milestones else ""
                project["next_action"] = pending[0]["next_action"] if pending else ""
                project["check_date"] = pending[0]["check_date"] if pending else ""
                project["waiting_reason"] = pending[0]["waiting_reason"] if pending else ""
                project["unconfirmed_count"] = sum(item.get("state") == "未確認" for item in items)
        return {"workspace_id": self.workspace_id, "workspace_name": meta["name"],
                "timezone": meta["timezone"], "member_id": principal.member_id,
                "member_name": owner["name"], "projects": projects,
                "archived_projects": archived_projects,
                "sources": sources}

    def detail(self, project_id: str) -> dict[str, object]:
        principal = self.principal()
        with self.store.connect() as db:
            self._project_access(db, principal, project_id)
            project = self.store.read_entity(db, project_id, self.workspace_id)
            if project["type"] != "project" or project["archived"]:
                raise WorkspaceError("not_found", 404)
            rows = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND project_id=? ORDER BY type,id",
                (self.workspace_id, project_id))]
            rows = [row for row in rows if row["type"] != "reference" or
                    row["kind"] not in {"contact", "external_case"} or
                    self._source_access(db, principal, str(row["source_id"]))]
            visible_reference_ids = {row["id"] for row in rows if row["type"] == "reference"}
            rows = [row for row in rows if row["type"] != "observation" or
                    row["reference_id"] in visible_reference_ids]
        observations = [x for x in rows if x["type"] == "observation"]
        linked = [x for x in rows if x["type"] == "reference" and
                  x["kind"] in {"contact", "external_case"} and not x["archived"]]
        return {"project": project, "milestones": [x for x in rows if x["type"] == "milestone"],
                "work_items": [x for x in rows if x["type"] == "work_item"],
                "references": [x for x in rows if x["type"] == "reference"],
                "external": {"status": "not_fetched" if linked else "not_connected",
                             "observations": [x for x in observations if x["reference_id"] in
                                              {ref["id"] for ref in linked}]}}

    def my_work(self) -> dict[str, object]:
        principal = self.principal()
        with self.store.connect() as db:
            self._active_member(db, principal)
            rows = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND type='work_item' AND archived=0 ORDER BY id",
                (self.workspace_id,))]
            names = {row["id"]: json.loads(row["data"])["name"] for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND type='project' AND archived=0",
                (self.workspace_id,))}
            if principal.role != "owner":
                allowed = {row["project_id"] for row in db.execute(
                    "SELECT project_id FROM project_memberships WHERE workspace_id=? AND member_id=? AND role IS NOT NULL",
                    (self.workspace_id, principal.member_id))}
                names = {key: value for key, value in names.items() if key in allowed}
            timezone_name = db.execute("SELECT timezone FROM metadata").fetchone()[0]
        items = [{**row, "project_name": names[row["project_id"]]} for row in rows
                 if row["assignee_id"] == principal.member_id and row["state"] != "完了" and row["project_id"] in names]
        try:
            from zoneinfo import ZoneInfo

            zone: tzinfo = ZoneInfo(timezone_name)
        except Exception:
            zone = timezone(timedelta(hours=9)) if timezone_name == "Asia/Tokyo" else UTC
        today = datetime.now(zone).date().isoformat()
        items.sort(key=lambda row: (0 if row["check_date"] and row["check_date"] < today else 1,
                                    row["check_date"] or "9999-12-31", 1 if row["waiting_reason"] else 0))
        return {"workspace_id": self.workspace_id, "items": items}

    def fetch_sources(self, project_id: str) -> dict[str, object]:
        from deskly.workspace_sources import fetch_linked_references

        principal = self.principal()
        self.detail(project_id)
        with self.store.connect() as db:
            sources = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND type='source'",
                (self.workspace_id,))]
            references = [self.store.entity(row) for row in db.execute(
                "SELECT * FROM entities WHERE workspace_id=? AND project_id=? AND type='reference' AND archived=0",
                (self.workspace_id, project_id))]
            sources = [source for source in sources if self._source_access(db, principal, str(source["id"]))]
        source_ids = {source["id"] for source in sources}
        linked = [ref for ref in references if ref["kind"] in {"contact", "external_case"}
                  and ref["source_id"] in source_ids]
        results = fetch_linked_references(self.home, sources, linked)
        linked_by_id = {ref["id"]: ref for ref in linked}
        sources_by_id = {source["id"]: source for source in sources}
        with self.store.connect(write=True) as db:
            self._project_access(db, principal, project_id)
            for result in results:
                reference = self.store.read_entity(db, str(result["reference_id"]), self.workspace_id)
                if reference != linked_by_id[result["reference_id"]]:
                    raise WorkspaceError("stale_reference", 409)
                source_id = str(result["source_id"])
                if not self._source_access(db, principal, source_id):
                    raise WorkspaceError("not_found", 404)
                if source_id in sources_by_id:
                    current_source = self.store.read_entity(db, source_id, self.workspace_id)
                    if current_source != sources_by_id[source_id]:
                        raise WorkspaceError("stale_source", 409)
                observation_id = str(uuid5(NAMESPACE_URL,
                                           f"deskly:{self.workspace_id}:{result['reference_id']}:observation"))
                previous_row = db.execute("SELECT * FROM entities WHERE id=? AND workspace_id=?",
                                          (observation_id, self.workspace_id)).fetchone()
                before = self.store.entity(previous_row) if previous_row else None
                version = cast(int, before["version"]) + 1 if before else 1
                fields = {"reference_id": result["reference_id"], "status": result["status"],
                          "last_attempt_at_utc": result["attempted_at_utc"],
                          "last_success_at_utc": result["as_of_utc"] or
                          (before["last_success_at_utc"] if before else None)}
                after = {"id": observation_id, "workspace_id": self.workspace_id,
                         "project_id": project_id, "type": "observation", "version": version,
                         "archived": False, **fields}
                if before:
                    db.execute("UPDATE entities SET version=?, data=? WHERE id=? AND version=?",
                               (version, _canonical(fields), observation_id, before["version"]))
                else:
                    db.execute("INSERT INTO entities VALUES (?, ?, ?, 'observation', 1, ?, 0)",
                               (observation_id, self.workspace_id, project_id, _canonical(fields)))
                operation_id = str(uuid4())
                db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (operation_id, self.workspace_id, observation_id,
                            principal.member_id, "dashboard/source-fetch", "明示参照の取得結果",
                            utc_now(), _canonical(before) if before else None,
                            _canonical(after), hashlib.sha256(_canonical(fields).encode()).hexdigest()))
        return {"project_id": project_id, "references": results}

    def history(self, project_id: str) -> dict[str, object]:
        principal = self.principal()
        detail = cast(dict[str, Any], self.detail(project_id))
        visible_ids = {detail["project"]["id"]}
        for key in ("milestones", "work_items", "references"):
            visible_ids.update(row["id"] for row in detail[key])
        visible_ids.update(row["id"] for row in detail["external"]["observations"])
        with self.store.connect() as db:
            self._project_access(db, principal, project_id)
            for ref in detail["references"]:
                if ref["kind"] in {"contact", "external_case"} and not self._source_access(
                    db, principal, str(ref["source_id"])
                ):
                    visible_ids.discard(ref["id"])
            rows = [dict(row) for row in db.execute(
                "SELECT operation_id, entity_id, member_id, route, reason, at_utc, before_json, after_json FROM events WHERE workspace_id=? ORDER BY at_utc, operation_id",
                (self.workspace_id,)) if row["entity_id"] in visible_ids]
            if principal.role != "owner":
                for observation in detail["external"]["observations"]:
                    reference = self.store.read_entity(db, str(observation["reference_id"]),
                                                       self.workspace_id)
                    if not self._source_access(db, principal, str(reference.get("source_id", ""))):
                        visible_ids.discard(observation["id"])
                safe_rows = []
                for row in rows:
                    snapshots = [json.loads(value) for value in
                                 (row["before_json"], row["after_json"]) if value]
                    if any(snapshot.get("type") == "reference" and
                           snapshot.get("kind") in {"contact", "external_case"} and
                           not self._source_access(db, principal, str(snapshot.get("source_id", "")))
                           for snapshot in snapshots):
                        continue
                    safe_rows.append(row)
                rows = safe_rows
        events = []
        for row in rows:
            before = row.pop("before_json")
            after = row.pop("after_json")
            events.append({**row, "before": json.loads(before) if before else None,
                           "after": json.loads(after)})
        return {"project_id": project_id, "events": events}
