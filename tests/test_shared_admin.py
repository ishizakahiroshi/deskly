"""Synthetic, isolated operator bootstrap and recovery checks."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from deskly.shared_admin import AdminError, add_member, bootstrap, main
from deskly.shared_auth import LocalCredentialStore
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore, workspace_path

ORIGIN = "https://shared.example.test"
OWNER_PASSWORD = "synthetic owner passphrase 01"
MEMBER_PASSWORD = "synthetic member passphrase 02"


def setup(home: Path) -> dict[str, str]:
    return bootstrap(home=home, origin=ORIGIN, workspace_name="Synthetic team",
                     owner_name="Owner", owner_login="owner", timezone="UTC",
                     password=OWNER_PASSWORD)


def test_bootstrap_is_explicit_idempotent_and_member_grant_is_scoped(tmp_path: Path) -> None:
    home = tmp_path / "private-home"
    first = setup(home)
    assert first["status"] == "created"
    assert json.loads((home / "workspace.json").read_text()) == {
        "workspace_id": first["workspace_id"]}
    assert not (home / "shared-admin.lock").exists()
    assert setup(home) == {**first, "status": "already_ready"}
    accounts = LocalCredentialStore(home / "shared-credentials.sqlite3")
    assert accounts.authenticate("owner", OWNER_PASSWORD)[0] == first["owner_subject"]  # type: ignore[index]
    store = WorkspaceStore(workspace_path(home, first["workspace_id"]))
    principal = store.identity_principal(first["workspace_id"], ORIGIN, first["owner_subject"])
    assert principal.member_id == first["owner_member_id"] and principal.role == "owner"
    service = WorkspaceService(home, first["workspace_id"], secret=b"synthetic")
    project = service.apply(service.preview({
        "operation_id": str(uuid4()), "action": "create", "type": "project",
        "id": None, "project_id": None, "version": None,
        "data": {"name": "Allowed", "purpose": "synthetic", "owner_id": first["owner_member_id"],
                 "state": "進行中"}, "reason": "synthetic",
    }))
    other = service.apply(service.preview({
        "operation_id": str(uuid4()), "action": "create", "type": "project",
        "id": None, "project_id": None, "version": None,
        "data": {"name": "Excluded", "purpose": "synthetic", "owner_id": first["owner_member_id"],
                 "state": "進行中"}, "reason": "synthetic",
    }))
    second = add_member(home=home, origin=ORIGIN, login="viewer", name="Viewer",
                        project_id=project["id"], role="viewer", password=MEMBER_PASSWORD)
    assert second["status"] == "created"
    assert add_member(home=home, origin=ORIGIN, login="viewer", name="Viewer",
                      project_id=project["id"], role="viewer",
                      password=MEMBER_PASSWORD) == {**second, "status": "already_ready"}
    viewer = WorkspaceService(home, first["workspace_id"], secret=b"synthetic",
                              identity=(ORIGIN, second["subject"]))
    assert [item["id"] for item in viewer.projects()["projects"]] == [project["id"]]
    with pytest.raises(Exception) as exc:
        viewer.detail(other["id"])
    assert getattr(exc.value, "status", None) == 404


def test_partial_bootstrap_preserves_files_and_refuses_duplicate(tmp_path: Path,
                                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "private-home"

    def fail_account(_self: LocalCredentialStore, _login: str, _password: str) -> str:
        raise AdminError("synthetic_failure")

    monkeypatch.setattr(LocalCredentialStore, "create_account", fail_account)
    with pytest.raises(AdminError, match="synthetic_failure"):
        setup(home)
    assert not (home / "workspace.json").exists()
    assert (home / "shared-admin.lock").is_file()
    assert (home / "shared-credentials.sqlite3").is_file()
    assert len(list((home / "workspaces").glob("*.sqlite3"))) == 1
    with pytest.raises(AdminError, match="partial_state_requires_recovery"):
        setup(home)


def test_completed_files_with_stale_lock_require_recovery(tmp_path: Path) -> None:
    home = tmp_path / "private-home"
    setup(home)
    (home / "shared-admin.lock").write_text("interrupted finalization", encoding="utf-8")
    with pytest.raises(AdminError, match="partial_state_requires_recovery"):
        setup(home)


def test_cli_prompts_secret_and_never_echoes_it(tmp_path: Path,
                                                capsys: pytest.CaptureFixture[str]) -> None:
    home = tmp_path / "private-home"
    argv = ["bootstrap", "--home", str(home), "--origin", ORIGIN,
            "--workspace-name", "Synthetic team", "--owner-name", "Owner",
            "--owner-login", "owner", "--timezone", "UTC"]
    prompts: list[str] = []

    def read_secret(prompt: str) -> str:
        prompts.append(prompt)
        return OWNER_PASSWORD

    assert main(argv, secret_reader=read_secret, require_tty=False) == 0
    output = capsys.readouterr()
    assert OWNER_PASSWORD not in output.out + output.err
    assert len(prompts) == 2
    assert json.loads(output.out)["status"] == "created"
    assert main(argv, secret_reader=read_secret, require_tty=False) == 0
    assert len(prompts) == 2  # Matching rerun never asks for a new password.
    assert main(argv + ["--password", OWNER_PASSWORD], secret_reader=read_secret,
                require_tty=False) == 2
    output = capsys.readouterr()
    assert OWNER_PASSWORD not in output.out + output.err
