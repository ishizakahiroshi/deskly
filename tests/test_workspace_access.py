"""Synthetic C3 permission boundaries for two people and two projects."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from deskly.cli import main
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_backup import export_workspace, restore_workspace
from deskly.workspace_model import WorkspaceError
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import ACCESS_SCHEMA_V2, WorkspaceStore, workspace_path


def change(kind: str, data: dict[str, object], *, project_id: str | None = None) -> dict[str, object]:
    return {"operation_id": str(uuid4()), "action": "create", "type": kind,
            "id": None, "project_id": project_id, "version": None,
            "data": data, "reason": "合成の操作"}


def created_project(service: WorkspaceService, owner: str, name: str) -> dict[str, object]:
    request = change("project", {"name": name, "purpose": "合成目的",
                                 "owner_id": owner, "state": "進行中"})
    return service.apply(service.preview(request))


def test_two_members_two_projects_revocation_and_replay(tmp_path: Path) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成workspace", "UTC", "管理者")
    owner = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret")
    first = created_project(owner, owner_id, "案件一")
    second = created_project(owner, owner_id, "案件二")
    access = WorkspaceAccess(owner.store, wid, owner.principal())
    issuer = "https://identity.example.test"
    access.bind_owner_identity(issuer, "owner-subject", operation_id=str(uuid4()), reason="合成登録")
    member_operation = str(uuid4())
    member = access.add_member("合成参加者", issuer, "member-subject",
                               operation_id=member_operation, reason="合成参加")
    assert access.add_member("合成参加者", issuer, "member-subject",
                             operation_id=member_operation, reason="合成参加") == member
    other = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret",
                             identity=(issuer, "member-subject"))
    assert other.projects()["projects"] == []
    with pytest.raises(WorkspaceError, match="not_found"):
        other.detail(str(first["id"]))
    with pytest.raises(WorkspaceError, match="unauthorized"):
        WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret",
                         identity=(issuer, "wrong-subject")).projects()

    grant = access.set_project_role(str(first["id"]), str(member["member_id"]), "viewer",
                                    expected_version=0, operation_id=str(uuid4()), reason="合成閲覧")
    assert grant["version"] == 1
    assert [item["id"] for item in other.projects()["projects"]] == [first["id"]]
    assert other.detail(str(first["id"]))["project"]["id"] == first["id"]
    with pytest.raises(WorkspaceError, match="not_found"):
        other.detail(str(second["id"]))
    task = change("work_item", {"kind": "開発", "title": "合成作業",
                                "assignee_id": member["member_id"], "next_action": "確認",
                                "check_date": "", "waiting_reason": "", "state": "進行中",
                                "milestone_id": ""}, project_id=str(first["id"]))
    with pytest.raises(WorkspaceError, match="not_found"):
        other.preview(task)
    access.set_project_role(str(first["id"]), str(member["member_id"]), "editor",
                            expected_version=1, operation_id=str(uuid4()), reason="合成編集")
    first_edit = other.apply(other.preview(change("work_item", {
        "kind": "開発", "title": "共同編集", "assignee_id": member["member_id"],
        "next_action": "確認", "check_date": "", "waiting_reason": "",
        "state": "進行中", "milestone_id": "",
    }, project_id=str(first["id"]))))
    edit_data = {key: first_edit[key] for key in (
        "kind", "title", "assignee_id", "next_action", "check_date",
        "waiting_reason", "state", "milestone_id",
    )}
    owner_request = {"operation_id": str(uuid4()), "action": "update", "type": "work_item",
                     "id": first_edit["id"], "project_id": first["id"], "version": 1,
                     "data": {**edit_data, "next_action": "管理者が更新"}, "reason": "合成競合"}
    member_request = {**owner_request, "operation_id": str(uuid4()),
                      "data": {**edit_data, "next_action": "参加者が更新"}}
    owner_preview = owner.preview(owner_request)
    member_preview = other.preview(member_request)
    owner.apply(owner_preview)
    with pytest.raises(WorkspaceError, match="version_conflict"):
        other.apply(member_preview)
    assert owner.detail(str(first["id"]))["work_items"][0]["next_action"] == "管理者が更新"
    assert {event["member_id"] for event in owner.history(str(first["id"]))["events"]} == {
        owner_id, member["member_id"],
    }
    preview = other.preview(task)
    with pytest.raises(WorkspaceError, match="assigned_work_remaining"):
        access.set_project_role(str(first["id"]), str(member["member_id"]), "viewer",
                                expected_version=2, operation_id=str(uuid4()), reason="引継ぎ前")
    owner.apply(owner.preview({**owner_request, "operation_id": str(uuid4()),
                               "version": 2,
                               "data": {**edit_data, "assignee_id": owner_id,
                                        "next_action": "管理者が引継ぎ"}}))
    access.set_project_role(str(first["id"]), str(member["member_id"]), "viewer",
                            expected_version=2, operation_id=str(uuid4()), reason="合成縮小")
    with pytest.raises(WorkspaceError, match="not_found"):
        other.apply(preview)
    access.set_project_role(str(first["id"]), str(member["member_id"]), None,
                            expected_version=3, operation_id=str(uuid4()), reason="合成離脱")
    assert other.projects()["projects"] == []
    with pytest.raises(WorkspaceError, match="version_conflict"):
        access.set_project_role(str(first["id"]), str(member["member_id"]), "editor",
                                expected_version=0, operation_id=str(uuid4()), reason="古い許可")
    assert len(owner.projects()["projects"]) == 2

    backup = tmp_path / "shared.jsonl"
    manifest = export_workspace(tmp_path, wid, backup)
    assert manifest["counts"]["identities"] == 2
    assert manifest["counts"]["project_memberships"] == 1
    restored_home = tmp_path / "restored"
    assert restore_workspace(backup, restored_home) == manifest
    restored = WorkspaceService(restored_home, wid, secret=b"synthetic-shared-secret",
                                identity=(issuer, "member-subject"))
    assert restored.projects()["projects"] == []


def test_v1_upgrade_requires_backup_and_keeps_personal_data(tmp_path: Path) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成workspace", "UTC", "管理者")
    service = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret")
    project = created_project(service, owner_id, "既存の合成案件")
    store = WorkspaceStore(workspace_path(tmp_path, wid))
    with store.connect(write=True) as db:
        for table in ("access_events", "source_memberships", "project_memberships", "identities"):
            db.execute(f"DROP TABLE {table}")
        db.execute("ALTER TABLE events RENAME TO events_v3")
        db.execute("""CREATE TABLE events (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
            entity_id TEXT NOT NULL, member_id TEXT NOT NULL, route TEXT NOT NULL,
            reason TEXT NOT NULL, at_utc TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
            request_hash TEXT NOT NULL)""")
        db.execute("""INSERT INTO events SELECT operation_id,workspace_id,entity_id,member_id,route,
            reason,at_utc,before_json,after_json,request_hash FROM events_v3""")
        db.execute("DROP TABLE events_v3")
        db.execute("UPDATE metadata SET schema_version=1")
    backup = tmp_path / "before-upgrade.jsonl"
    store.upgrade_access(wid, backup)
    assert backup.is_file()
    assert service.detail(str(project["id"]))["project"]["id"] == project["id"]
    old_home = tmp_path / "old-restored"
    assert restore_workspace(backup, old_home)["schema_version"] == 1
    assert WorkspaceService(old_home, wid, secret=b"synthetic-shared-secret").projects()["projects"][0]["id"] == project["id"]
    with pytest.raises(WorkspaceError, match="invalid_schema_version"):
        store.upgrade_access(wid, tmp_path / "again.jsonl")


def test_v2_upgrade_keeps_v2_backup_and_marks_legacy_executor_unknown(tmp_path: Path) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成workspace", "UTC", "管理者")
    service = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret")
    project = created_project(service, owner_id, "既存の合成案件")
    store = WorkspaceStore(workspace_path(tmp_path, wid))
    with store.connect(write=True) as db:
        for table in ("access_events", "source_memberships", "project_memberships", "identities"):
            db.execute(f"DROP TABLE {table}")
        db.executescript(ACCESS_SCHEMA_V2)
        db.execute("ALTER TABLE events RENAME TO events_v3")
        db.execute("""CREATE TABLE events (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
            entity_id TEXT NOT NULL, member_id TEXT NOT NULL, route TEXT NOT NULL,
            reason TEXT NOT NULL, at_utc TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
            request_hash TEXT NOT NULL)""")
        db.execute("""INSERT INTO events SELECT operation_id,workspace_id,entity_id,member_id,route,
            reason,at_utc,before_json,after_json,request_hash FROM events_v3""")
        db.execute("DROP TABLE events_v3")
        db.execute("UPDATE metadata SET schema_version=2")
    backup = tmp_path / "before-v3.jsonl"
    store.upgrade_access(wid, backup)
    assert export_workspace(tmp_path, wid, tmp_path / "after-v3.jsonl")["schema_version"] == 3
    restored_home = tmp_path / "v2-restored"
    assert restore_workspace(backup, restored_home)["schema_version"] == 2
    with store.connect() as db:
        event = db.execute("SELECT * FROM events WHERE entity_id=?", (project["id"],)).fetchone()
        assert event["requester_member_id"] == owner_id
        assert event["executor_kind"] == "unknown"
        assert event["executor_ref"] is None
        assert event["executor_verified"] == 0


def test_source_scope_and_departure_takeover(tmp_path: Path) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成workspace", "UTC", "管理者")
    owner = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret")
    project = created_project(owner, owner_id, "合成案件")
    source = owner.apply(owner.preview(change("source", {
        "label": "合成台帳", "adapter": "contact", "binding": "synthetic",
    })))
    reference = owner.apply(owner.preview(change("reference", {
        "kind": "contact", "target": "c-20260927-00000001", "label": "合成参照",
        "linked_id": "", "source_id": source["id"],
    }, project_id=str(project["id"]))))
    access = WorkspaceAccess(owner.store, wid, owner.principal())
    issuer = "https://identity.example.test"
    member = access.add_member("合成参加者", issuer, "member-subject",
                               operation_id=str(uuid4()), reason="合成参加")
    member_id = str(member["member_id"])
    access.set_project_role(str(project["id"]), member_id, "editor",
                            expected_version=0, operation_id=str(uuid4()), reason="合成編集")
    other = WorkspaceService(tmp_path, wid, secret=b"synthetic-shared-secret",
                             identity=(issuer, "member-subject"))
    assert other.detail(str(project["id"]))["references"] == []
    assert other.projects()["sources"] == []
    assert all(event["entity_id"] != reference["id"]
               for event in other.history(str(project["id"]))["events"])
    with pytest.raises(WorkspaceError, match="forbidden"):
        WorkspaceAccess(other.store, wid, other.principal()).set_source_access(
            str(source["id"]), member_id, True, expected_version=0,
            operation_id=str(uuid4()), reason="禁止")
    access.set_source_access(str(source["id"]), member_id, True,
                             expected_version=0, operation_id=str(uuid4()), reason="合成参照許可")
    assert other.detail(str(project["id"]))["references"][0]["id"] == reference["id"]
    assert other.projects()["sources"][0]["id"] == source["id"]
    with pytest.raises(WorkspaceError, match="forbidden"):
        other.preview(change("reference", {"kind": "contact",
            "target": "c-20260927-00000002", "label": "無断共有",
            "linked_id": "", "source_id": source["id"]}, project_id=str(project["id"])))
    task = other.apply(other.preview(change("work_item", {
        "kind": "開発", "title": "合成作業", "assignee_id": member_id,
        "next_action": "確認", "check_date": "", "waiting_reason": "",
        "state": "進行中", "milestone_id": "",
    }, project_id=str(project["id"]))))
    assert other.my_work()["items"][0]["id"] == task["id"]
    access.set_source_access(str(source["id"]), member_id, False,
                             expected_version=1, operation_id=str(uuid4()), reason="合成参照取消")
    assert other.detail(str(project["id"]))["references"] == []
    assert all(event["entity_id"] != reference["id"]
               for event in other.history(str(project["id"]))["events"])
    result = access.deactivate_member(member_id, operation_id=str(uuid4()), reason="合成離脱")
    assert result["transferred"] == 1
    transferred = owner.detail(str(project["id"]))["work_items"][0]
    assert transferred["assignee_id"] == owner_id
    assert transferred["version"] == 2
    assert any(event["route"] == "workspace-access/takeover"
               for event in owner.history(str(project["id"]))["events"])
    assert any(event["target_type"] == "member" for event in access.history())
    with pytest.raises(WorkspaceError, match="member_inactive"):
        other.projects()
    with pytest.raises(WorkspaceError, match="last_owner"):
        access.deactivate_member(owner_id, operation_id=str(uuid4()), reason="禁止")


def test_cli_explicit_access_upgrade_uses_new_backup(
    isolate_deskly_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    home = isolate_deskly_home
    wid, _ = WorkspaceStore.initialize(home, "合成workspace", "UTC", "管理者")
    (home / "workspace.json").write_text(json.dumps({"workspace_id": wid}), encoding="utf-8")
    store = WorkspaceStore(workspace_path(home, wid))
    with store.connect(write=True) as db:
        for table in ("access_events", "source_memberships", "project_memberships", "identities"):
            db.execute(f"DROP TABLE {table}")
        db.execute("UPDATE metadata SET schema_version=1")
    backup = home / "before-access.jsonl"
    assert main(["workspace", "upgrade-access", "--backup", str(backup)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["workspace_id"] == wid
    assert backup.is_file()
