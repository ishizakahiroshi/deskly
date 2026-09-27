"""Synthetic personal workspace contract: isolation, confirmation, and recovery."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from deskly.store import SqliteStore
from deskly.workspace_backup import export_workspace, restore_workspace
from deskly.workspace_model import WorkspaceError
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore, workspace_path


def request(kind: str, data: dict[str, object] | None, *, project_id: str | None = None,
            entity_id: str | None = None, version: int | None = None,
            action: str = "create", operation_id: str | None = None) -> dict[str, object]:
    return {"operation_id": operation_id or str(uuid4()), "action": action, "type": kind,
            "id": entity_id, "project_id": project_id, "version": version,
            "data": data, "reason": "合成ケースの操作"}


def setup(home: Path) -> tuple[WorkspaceService, str, str]:
    wid, member = WorkspaceStore.initialize(home, "合成 workspace", "Asia/Tokyo", "合成担当")
    return WorkspaceService(home, wid, secret=b"synthetic-preview-secret"), wid, member


def project(service: WorkspaceService, member: str) -> dict[str, object]:
    change = request("project", {"name": "合成案件", "purpose": "合成の目的",
                                 "owner_id": member, "state": "進行中"})
    preview = service.preview(change)
    assert service.projects()["projects"] == []
    return service.apply(preview)


def test_preview_apply_replay_version_and_history(tmp_path: Path) -> None:
    service, wid, member = setup(tmp_path)
    created = project(service, member)
    task = request("work_item", {"kind": "開発", "title": "合成作業",
                                 "assignee_id": member, "next_action": "確認する",
                                 "check_date": "2026-09-28", "waiting_reason": "",
                                 "state": "進行中", "milestone_id": ""}, project_id=str(created["id"]))
    task_preview = service.preview(task)
    result = service.apply(task_preview)
    assert service.apply(task_preview) == result
    assert service.detail(str(created["id"]))["work_items"][0]["id"] == result["id"]
    assert service.my_work()["items"][0]["project_name"] == "合成案件"
    assert len(service.history(str(created["id"]))["events"]) == 2
    changed = dict(task_preview)
    changed["after"] = {**task_preview["after"], "title": "不正な変更"}
    with pytest.raises(WorkspaceError, match="invalid_preview"):
        service.apply(changed)
    updated_data = {key: result[key] for key in ("kind", "title", "assignee_id", "next_action",
                   "check_date", "waiting_reason", "state", "milestone_id")}
    updated_data["next_action"] = "次を進める"
    update = request("work_item", updated_data, project_id=str(created["id"]),
                     entity_id=str(result["id"]), version=1, action="update")
    first = service.preview(update)
    second = service.preview({**update, "operation_id": str(uuid4())})
    service.apply(first)
    with pytest.raises(WorkspaceError, match="version_conflict"):
        service.apply(second)
    assert service.detail(str(created["id"]))["work_items"][0]["next_action"] == "次を進める"
    assert service.workspace_id == wid


def test_foreign_workspace_and_invalid_parent_and_member(tmp_path: Path) -> None:
    service, wid, member = setup(tmp_path / "one")
    other, _, _ = setup(tmp_path / "two")
    created = project(service, member)
    with pytest.raises(WorkspaceError, match="not_found"):
        other.detail(str(created["id"]))
    with pytest.raises(WorkspaceError, match="invalid_member"):
        service.preview(request("project", {"name": "別", "purpose": "目的",
            "owner_id": str(uuid4()), "state": "進行中"}))
    with pytest.raises(WorkspaceError, match="not_found"):
        service.preview(request("work_item", {"kind": "営業", "title": "別",
            "assignee_id": member, "next_action": "確認", "check_date": "",
            "waiting_reason": "", "state": "未確認", "milestone_id": ""},
            project_id=str(uuid4())))
    assert workspace_path(tmp_path / "one", wid).is_file()


def test_backup_restore_exact_entities_and_events(tmp_path: Path) -> None:
    original, wid, member = setup(tmp_path / "original")
    created = project(original, member)
    milestone = original.apply(original.preview(request("milestone", {
        "goal": "合成目標", "acceptance": "確認できる", "assignee_id": member,
        "check_date": "2026-09-30", "state": "進行中",
    }, project_id=str(created["id"]))))
    task = original.apply(original.preview(request("work_item", {
        "kind": "運営", "title": "合成運用", "assignee_id": member,
        "next_action": "記録する", "check_date": "2026-09-29",
        "waiting_reason": "", "state": "進行中", "milestone_id": milestone["id"],
    }, project_id=str(created["id"]))))
    original.apply(original.preview(request("reference", {
        "kind": "md", "target": "docs/plan_example.md", "label": "合成計画",
        "linked_id": task["id"],
    }, project_id=str(created["id"]))))
    task_data = {key: task[key] for key in ("kind", "title", "assignee_id", "next_action",
                 "check_date", "waiting_reason", "state", "milestone_id")}
    task_data["next_action"] = "結果を記録する"
    original.apply(original.preview(request("work_item", task_data,
        project_id=str(created["id"]), entity_id=str(task["id"]), version=1, action="update")))
    backup = tmp_path / "workspace-backup.jsonl"
    manifest = export_workspace(tmp_path / "original", wid, backup)
    restored_home = tmp_path / "restored"
    assert restore_workspace(backup, restored_home) == manifest
    restored = WorkspaceService(restored_home, wid, secret=b"synthetic-preview-secret")
    assert manifest["counts"] == {"metadata": 1, "members": 1, "entities": 4, "events": 5,
                                  "identities": 0, "project_memberships": 0,
                                  "source_memberships": 0, "access_events": 0}
    assert restored.detail(str(created["id"])) == original.detail(str(created["id"]))
    assert restored.history(str(created["id"])) == original.history(str(created["id"]))
    with pytest.raises(WorkspaceError, match="restore_target_exists"):
        restore_workspace(backup, restored_home)
    corrupt = tmp_path / "corrupt.jsonl"
    corrupt.write_bytes(backup.read_bytes() + b"x")
    with pytest.raises(WorkspaceError):
        restore_workspace(corrupt, tmp_path / "corrupt-home")
    assert not workspace_path(tmp_path / "corrupt-home", wid).exists()


def test_owner_inactive_rejected(tmp_path: Path) -> None:
    service, wid, member = setup(tmp_path)
    store = WorkspaceStore(workspace_path(tmp_path, wid))
    with store.connect(write=True) as db:
        db.execute("UPDATE members SET active=0 WHERE id=?", (member,))
    with pytest.raises(WorkspaceError, match="member_inactive"):
        service.projects()


def test_archive_restore_keeps_versions_history_and_parent_boundary(tmp_path: Path) -> None:
    service, _, member = setup(tmp_path)
    created = project(service, member)
    task = service.apply(service.preview(request("work_item", {
        "kind": "開発", "title": "合成作業", "assignee_id": member,
        "next_action": "確認する", "check_date": "", "waiting_reason": "",
        "state": "進行中", "milestone_id": "",
    }, project_id=str(created["id"]))))
    archived_task = service.apply(service.preview(request(
        "work_item", None, project_id=str(created["id"]), entity_id=str(task["id"]),
        version=1, action="archive")))
    assert archived_task["archived"] is True and archived_task["version"] == 2
    assert service.my_work()["items"] == []
    assert service.detail(str(created["id"]))["work_items"][0]["archived"] is True
    with pytest.raises(WorkspaceError, match="version_conflict"):
        service.preview(request("work_item", None, project_id=str(created["id"]),
            entity_id=str(task["id"]), version=1, action="restore"))
    archived_project = service.apply(service.preview(request(
        "project", None, entity_id=str(created["id"]), version=1, action="archive")))
    assert service.projects()["archived_projects"][0]["id"] == created["id"]
    with pytest.raises(WorkspaceError, match="invalid_project"):
        service.preview(request("work_item", None, project_id=str(created["id"]),
            entity_id=str(task["id"]), version=2, action="restore"))
    service.apply(service.preview(request("project", None, entity_id=str(created["id"]),
                                  version=int(archived_project["version"]), action="restore")))
    restored = service.apply(service.preview(request(
        "work_item", None, project_id=str(created["id"]), entity_id=str(task["id"]),
        version=2, action="restore")))
    assert restored["archived"] is False and restored["version"] == 3
    assert service.my_work()["items"][0]["id"] == task["id"]
    assert len(service.history(str(created["id"]))["events"]) == 6


def test_explicit_contact_source_fetch_and_backup(tmp_path: Path) -> None:
    service, wid, member = setup(tmp_path / "original")
    created = project(service, member)
    with SqliteStore(tmp_path / "original" / "ledger" / "company.sqlite3") as ledger:
        contact = ledger.create({"state": "回答待ち", "body": "SYNTHETIC_PRIVATE_BODY"})
    source = service.apply(service.preview(request("source", {
        "label": "合成連絡台帳", "adapter": "contact", "binding": "company"})))
    with pytest.raises(WorkspaceError, match="not_found"):
        service.preview(request("reference", {"kind": "contact", "target": contact.id,
            "label": "合成連絡", "linked_id": "", "source_id": str(uuid4())},
            project_id=str(created["id"])))
    ref = service.apply(service.preview(request("reference", {
        "kind": "contact", "target": contact.id, "label": "合成連絡",
        "linked_id": "", "source_id": source["id"],
    }, project_id=str(created["id"]))))
    assert service.detail(str(created["id"]))["external"]["status"] == "not_fetched"
    fetched = service.fetch_sources(str(created["id"]))["references"][0]
    assert fetched["reference_id"] == ref["id"]
    assert fetched["status"] == "connected" and fetched["data"]["state"] == "回答待ち"
    assert fetched["as_of_utc"]
    assert "SYNTHETIC_PRIVATE_BODY" not in str(fetched)
    observation = service.detail(str(created["id"]))["external"]["observations"][0]
    assert observation["status"] == "connected" and observation["last_success_at_utc"] == fetched["as_of_utc"]
    assert any(event["route"] == "dashboard/source-fetch"
               for event in service.history(str(created["id"]))["events"])
    service.apply(service.preview(request("source", None, entity_id=str(source["id"]),
                                  version=1, action="archive")))
    assert service.fetch_sources(str(created["id"]))["references"][0]["status"] == "not_connected"
    backup = tmp_path / "source-backup.jsonl"
    export_workspace(tmp_path / "original", wid, backup)
    restore_workspace(backup, tmp_path / "restored")
    restored = WorkspaceService(tmp_path / "restored", wid, secret=b"synthetic-preview-secret")
    assert restored.projects()["sources"][0]["id"] == source["id"]
    assert restored.detail(str(created["id"]))["references"][0]["source_id"] == source["id"]
    assert restored.detail(str(created["id"]))["external"]["observations"][0]["status"] == "not_connected"
