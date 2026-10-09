"""Authenticated local CLI checks over a synthetic shared workspace only."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from deskly.shared_auth import LocalCredentialStore
from deskly.shared_cli import main
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_model import WorkspaceError
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore

ISSUER = "https://team.example.test"
PASSWORD = "synthetic-password-2026"


def _request(kind: str, data: dict[str, object], project_id: str | None = None) -> dict[str, object]:
    return {"operation_id": str(uuid4()), "action": "create", "type": kind,
            "id": None, "project_id": project_id, "version": None,
            "data": data, "reason": "synthetic CLI verification"}


def _apply(service: WorkspaceService, request: dict[str, object]) -> dict[str, object]:
    return service.apply(service.preview(request))


def _setup(home: Path) -> tuple[str, str, str, str, str]:
    home.mkdir(mode=0o700, parents=True)
    workspace_id, owner_id = WorkspaceStore.initialize(home, "合成workspace", "UTC", "合成owner")
    owner = WorkspaceService(home, workspace_id, secret=b"synthetic-owner-service-secret")
    project_one = _apply(owner, _request("project", {
        "name": "合成案件一", "purpose": "テスト", "owner_id": owner_id, "state": "進行中",
    }))
    project_two = _apply(owner, _request("project", {
        "name": "合成案件二", "purpose": "テスト", "owner_id": owner_id, "state": "進行中",
    }))
    source = _apply(owner, _request("source", {
        "label": "合成連絡台帳", "adapter": "contact", "binding": "synthetic",
    }))
    _apply(owner, _request("reference", {
        "kind": "contact", "target": "c-20260928-00000001", "label": "合成連絡",
        "linked_id": "", "source_id": source["id"],
    }, str(project_one["id"])))

    accounts = LocalCredentialStore.initialize(home / "shared-credentials.sqlite3")
    owner_subject = accounts.create_account("synthetic.owner", PASSWORD)
    access = WorkspaceAccess(owner.store, workspace_id, owner.principal())
    access.bind_owner_identity(ISSUER, owner_subject,
                               operation_id=str(uuid4()), reason="synthetic identity binding")
    member_subject = accounts.create_account("synthetic.member", PASSWORD)
    member = access.add_member("合成member", ISSUER, member_subject,
                               operation_id=str(uuid4()), reason="synthetic CLI member")
    member_id = str(member["member_id"])
    access.set_project_role(str(project_one["id"]), member_id, "viewer",
                            expected_version=0, operation_id=str(uuid4()),
                            reason="synthetic viewer grant")
    (home / "workspace.json").write_text(
        json.dumps({"workspace_id": workspace_id}), encoding="utf-8"
    )
    return workspace_id, owner_id, member_id, str(project_one["id"]), str(project_two["id"])


def _run(home: Path, command: list[str], *, login: str, confirmation: str = "n",
         capsys: pytest.CaptureFixture[str], password: str = PASSWORD) -> int:
    return main(["--home", str(home), "--origin", ISSUER, *command],
                login_reader=lambda _prompt: login,
                password_reader=lambda _prompt: password,
                confirmation_reader=lambda _prompt: confirmation,
                require_tty=False)


def test_shared_cli_auth_scope_preview_apply_and_durable_requester_route(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "shared-home"
    workspace_id, _owner, member_id, first_id, second_id = _setup(home)

    assert _run(home, ["projects"], login="synthetic.member", capsys=capsys) == 0
    visible = json.loads(capsys.readouterr().out)
    assert [row["id"] for row in visible["projects"]] == [first_id]
    assert visible["sources"] == []

    assert _run(home, ["counts"], login="synthetic.member", capsys=capsys) == 0
    assert json.loads(capsys.readouterr().out) == {
        "projects": 1, "work_items": 0, "milestones": 0, "unconfirmed_work_items": 0,
    }
    assert _run(home, ["search", "--query", "案件一"],
                login="synthetic.member", capsys=capsys) == 0
    search_results = json.loads(capsys.readouterr().out)["results"]
    assert [row["project_id"] for row in search_results] == [first_id]
    assert _run(home, ["search", "--query", "案件二"],
                login="synthetic.member", capsys=capsys) == 0
    assert json.loads(capsys.readouterr().out)["results"] == []

    assert _run(home, ["detail", "--project-id", first_id],
                login="synthetic.member", capsys=capsys) == 0
    detail = json.loads(capsys.readouterr().out)
    assert detail["references"] == []

    assert _run(home, ["detail", "--project-id", second_id],
                login="synthetic.member", capsys=capsys) == 1
    assert "not_found" in capsys.readouterr().err

    access_store = WorkspaceStore(home / "workspaces" / f"{workspace_id}.sqlite3")
    owner = WorkspaceService(home, workspace_id, secret=b"synthetic-owner-service-secret")
    access = WorkspaceAccess(access_store, workspace_id, owner.principal())
    with access_store.connect() as db:
        source_row = db.execute("SELECT id FROM entities WHERE type='source'").fetchone()
        reference_row = db.execute("SELECT id FROM entities WHERE type='reference'").fetchone()
    source_id, reference_id = str(source_row[0]), str(reference_row[0])
    access.set_source_access(source_id, member_id, True, expected_version=0,
                             operation_id=str(uuid4()), reason="synthetic source grant")
    assert _run(home, ["projects"], login="synthetic.member", capsys=capsys) == 0
    visible = json.loads(capsys.readouterr().out)
    assert [row["id"] for row in visible["sources"]] == [source_id]
    assert _run(home, ["detail", "--project-id", first_id],
                login="synthetic.member", capsys=capsys) == 0
    detail = json.loads(capsys.readouterr().out)
    assert [row["id"] for row in detail["references"]] == [reference_id]

    request = _request("work_item", {
        "kind": "開発", "title": "合成作業", "assignee_id": member_id,
        "next_action": "合成確認", "check_date": "", "waiting_reason": "",
        "state": "進行中", "milestone_id": "",
    }, first_id)
    request_file = home / "request.json"
    request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    assert _run(home, ["change", "--request-file", str(request_file)],
                login="synthetic.member", confirmation="y", capsys=capsys) == 1
    assert "not_found" in capsys.readouterr().err

    access.set_project_role(first_id, member_id, "editor", expected_version=1,
                            operation_id=str(uuid4()), reason="synthetic editor grant")
    assert _run(home, ["change", "--request-file", str(request_file)],
                login="synthetic.member", confirmation="y", capsys=capsys) == 0
    output = capsys.readouterr().out.splitlines()
    preview = json.loads(output[0])
    applied = json.loads(output[1])
    assert preview["request"]["operation_id"] == request["operation_id"]
    assert applied["type"] == "work_item"

    with access_store.connect() as db:
        event = db.execute("SELECT member_id,route FROM events WHERE operation_id=?",
                           (request["operation_id"],)).fetchone()
    assert tuple(event) == (member_id, "shared-cli")

    # Replay is idempotent and still checks current grants before returning.
    account = LocalCredentialStore(home / "shared-credentials.sqlite3").authenticate(
        "synthetic.member", PASSWORD
    )
    assert account is not None
    member_service = WorkspaceService(
        home, workspace_id, secret=b"stable-synthetic-secret",
        identity=(ISSUER, account[0]), execution_route="shared-cli",
    )
    replay_request = _request("work_item", {
        "kind": "開発", "title": "再送用合成作業", "assignee_id": member_id,
        "next_action": "再送確認", "check_date": "", "waiting_reason": "",
        "state": "進行中", "milestone_id": "",
    }, first_id)
    replay_preview = member_service.preview(replay_request)
    dashboard_service = WorkspaceService(
        home, workspace_id, secret=b"stable-synthetic-secret",
        identity=(ISSUER, account[0]), execution_route="dashboard",
    )
    with pytest.raises(WorkspaceError, match="invalid_preview"):
        dashboard_service.apply(replay_preview)
    replay_result = member_service.apply(replay_preview)
    assert member_service.apply(replay_preview) == replay_result
    with access_store.connect() as db:
        replay_events = db.execute("SELECT member_id,route FROM events WHERE operation_id=?",
                                   (replay_request["operation_id"],)).fetchall()
    assert [tuple(row) for row in replay_events] == [(member_id, "shared-cli")]

    for item in owner.detail(first_id)["work_items"]:
        owner.apply(owner.preview({
            "operation_id": str(uuid4()), "action": "update", "type": "work_item",
            "id": item["id"], "project_id": first_id, "version": item["version"],
            "data": {key: item[key] for key in (
                "kind", "title", "assignee_id", "next_action", "check_date",
                "waiting_reason", "state", "milestone_id",
            )} | {"state": "完了"},
            "reason": "synthetic test work completed",
        }))

    source_version = 1
    access.set_source_access(source_id, member_id, False, expected_version=source_version,
                             operation_id=str(uuid4()), reason="synthetic source revoked")
    access.set_project_role(first_id, member_id, None, expected_version=2,
                            operation_id=str(uuid4()), reason="synthetic grant revoked")
    assert _run(home, ["projects"], login="synthetic.member", capsys=capsys) == 0
    assert json.loads(capsys.readouterr().out)["projects"] == []
    with pytest.raises(WorkspaceError, match="not_found"):
        member_service.apply(replay_preview)


def test_shared_cli_requires_tty_and_never_accepts_password_argument_or_route_override(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "shared-home"
    _setup(home)
    assert main(["--home", str(home), "--origin", ISSUER, "projects"],
                require_tty=True) == 1
    assert "interactive_terminal_required" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main(["--home", str(home), "--origin", ISSUER, "--password", PASSWORD, "projects"],
             require_tty=False)
    with pytest.raises(WorkspaceError, match="invalid_route"):
        WorkspaceService(home, "00000000-0000-0000-0000-000000000000",
                         secret=b"synthetic", execution_route="mcp")


def test_shared_cli_requires_exact_issuer_and_rejects_bad_password_without_echo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    home = tmp_path / "shared-home"
    _setup(home)
    assert _run(home, ["projects"], login="synthetic.member", password="wrong-password",
                capsys=capsys) == 1
    captured = capsys.readouterr()
    assert "unauthorized" in captured.err
    assert PASSWORD not in captured.out + captured.err
    assert main(["--home", str(home), "--origin", "https://other.example.test", "projects"],
                login_reader=lambda _prompt: "synthetic.member",
                password_reader=lambda _prompt: PASSWORD,
                require_tty=False) == 1
    assert "unauthorized" in capsys.readouterr().err


def test_owner_link_contact_uses_exact_ids_and_records_shared_cli_route(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "shared-home"
    workspace_id, owner_id, _member_id, project_id, _other_project = _setup(home)
    with WorkspaceStore(home / "workspaces" / f"{workspace_id}.sqlite3").connect() as db:
        source_id = str(db.execute("SELECT id FROM entities WHERE type='source'").fetchone()[0])
    monkeypatch.setattr("deskly.shared_contacts._contact", lambda *_args: None)
    operation_id = str(uuid4())
    command = ["link-contact", "--workspace-id", workspace_id,
               "--project-id", project_id, "--source-id", source_id,
               "--contact-id", "c-20260928-00000002", "--label", "合成連絡",
               "--operation-id", operation_id, "--reason", "合成の明示リンク"]
    assert _run(home, command, login="synthetic.member", confirmation="y", capsys=capsys) == 1
    assert "forbidden" in capsys.readouterr().err
    assert _run(home, command, login="synthetic.owner", confirmation="y", capsys=capsys) == 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    reference = result["reference"]
    assert reference["type"] == "reference"
    assert reference["project_id"] == project_id
    with WorkspaceStore(home / "workspaces" / f"{workspace_id}.sqlite3").connect() as db:
        event = db.execute("SELECT member_id,route FROM events WHERE operation_id=?",
                           (operation_id,)).fetchone()
        linked = db.execute("SELECT COUNT(*) FROM entities WHERE id=? AND type='reference'",
                            (reference["id"],)).fetchone()[0]
    assert tuple(event) == (owner_id, "shared-cli")
    assert linked == 1
    with pytest.raises(SystemExit):
        main(["--home", str(home), "--origin", ISSUER, "link-contact",
              "--workspace-id", workspace_id, "--project-id", project_id,
              "--source-id", source_id, "--contact-id", "c-20260928-00000002",
              "--label", "合成連絡", "--operation-id", operation_id,
              "--reason", "合成", "--member-id", owner_id], require_tty=False)
