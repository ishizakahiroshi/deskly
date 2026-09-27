"""Synthetic shared Web identity, cookie, CSRF, and authorization boundaries."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

from deskly.dashboard_server import create_shared_dashboard_server
from deskly.shared_auth import SHARED_SESSION_COOKIE_NAME, LocalCredentialStore
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore, workspace_path

ORIGIN = "https://shared.example.test"


def test_shared_web_has_individual_identity_and_revocable_access(tmp_path: Path) -> None:
    workspace_id, owner_id = WorkspaceStore.initialize(
        tmp_path, "Synthetic workspace", "UTC", "Owner"
    )
    store = WorkspaceStore(workspace_path(tmp_path, workspace_id))
    account_path = tmp_path / "accounts.sqlite3"
    accounts = LocalCredentialStore.initialize(account_path)
    owner_subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    viewer_subject = accounts.create_account("viewer", "synthetic viewer passphrase 02")
    owner_service = WorkspaceService(tmp_path, workspace_id, secret=b"synthetic-preview-secret")
    access = WorkspaceAccess(store, workspace_id, owner_service.principal())
    access.bind_owner_identity(ORIGIN, owner_subject, operation_id=str(uuid4()), reason="bootstrap")
    viewer = access.add_member("Viewer", ORIGIN, viewer_subject,
                               operation_id=str(uuid4()), reason="join")
    first = owner_service.apply(owner_service.preview({
        "operation_id": str(uuid4()), "action": "create", "type": "project",
        "id": None, "project_id": None, "version": None,
        "data": {"name": "Visible", "purpose": "synthetic", "owner_id": owner_id,
                 "state": "進行中"}, "reason": "synthetic",
    }))
    second = owner_service.apply(owner_service.preview({
        "operation_id": str(uuid4()), "action": "create", "type": "project",
        "id": None, "project_id": None, "version": None,
        "data": {"name": "Hidden", "purpose": "synthetic", "owner_id": owner_id,
                 "state": "進行中"}, "reason": "synthetic",
    }))
    access.set_project_role(first["id"], viewer["member_id"], "viewer", expected_version=0,
                            operation_id=str(uuid4()), reason="grant")
    server = create_shared_dashboard_server(
        home=tmp_path, workspace_id=workspace_id, credential_store=account_path,
        public_origin=ORIGIN, host="127.0.0.1", port=0,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    def call(path: str, *, body: object | None = None, cookie: str = "",
             origin: str | None = None, host: str = "shared.example.test") -> tuple[int, dict[str, str], object]:
        headers = {"Host": host, "Accept": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if origin is not None:
            headers["Origin"] = origin
            headers["Sec-Fetch-Site"] = "same-origin"
        raw = json.dumps(body).encode() if body is not None else None
        if raw is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url + path, data=raw, headers=headers,
                          method="POST" if raw is not None else "GET")
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            raw_response = response.read()
            result = json.loads(raw_response) if raw_response else None
            return response.status, dict(response.headers), result

    try:
        projects = f"/api/workspaces/{workspace_id}/projects"
        assert call("/healthz")[0] == 200
        assert call("/healthz", host=f"127.0.0.1:{server.server_port}")[0] == 200
        assert call("/api/mode")[2] == {"mode": "shared"}
        assert call(projects)[0] == 401
        assert call("/api/workspace")[0] == 401
        assert call("/api/dashboard")[0] == 404
        assert call(projects, host="attacker.example.test")[0] == 400
        assert call("/login", body={"login": "owner", "password": "synthetic owner passphrase 01"})[0] == 403
        assert call("/login", body={"login": "owner", "password": "wrong"}, origin=ORIGIN)[0] == 401
        status, headers, _ = call("/login", body={"login": "owner", "password": "synthetic owner passphrase 01"}, origin=ORIGIN)
        assert status == 200
        assert "Secure; HttpOnly; SameSite=Strict" in headers["Set-Cookie"]
        owner_cookie = headers["Set-Cookie"].split(";", 1)[0]
        assert owner_cookie.startswith(SHARED_SESSION_COOKIE_NAME + "=")
        assert call("/api/dashboard", cookie=owner_cookie)[0] == 404
        assert call("/api/workspace", cookie=owner_cookie)[2] == {
            "configured": True, "workspace_id": workspace_id,
            "member_id": owner_id, "role": "owner",
        }
        assert {item["id"] for item in call(projects, cookie=owner_cookie)[2]["projects"]} == {
            first["id"], second["id"]}
        create = {"operation_id": str(uuid4()), "action": "create", "type": "project",
                  "id": None, "project_id": None, "version": None,
                  "data": {"name": "HTTP created", "purpose": "synthetic", "owner_id": owner_id,
                           "state": "進行中"}, "reason": "synthetic"}
        preview = f"/api/workspaces/{workspace_id}/commands/preview"
        apply = f"/api/workspaces/{workspace_id}/commands/apply"
        assert call(preview, body=create, cookie=owner_cookie)[0] == 403
        status, _, prepared = call(preview, body=create, cookie=owner_cookie, origin=ORIGIN)
        assert status == 200
        status, _, created = call(apply, body=prepared, cookie=owner_cookie, origin=ORIGIN)
        assert status == 200 and created["owner_id"] == owner_id

        status, headers, _ = call("/login", body={"login": "viewer", "password": "synthetic viewer passphrase 02"}, origin=ORIGIN)
        assert status == 200
        viewer_cookie = headers["Set-Cookie"].split(";", 1)[0]
        assert [item["id"] for item in call(projects, cookie=viewer_cookie)[2]["projects"]] == [first["id"]]
        assert call(f"{projects}/{second['id']}", cookie=viewer_cookie)[0] == 404
        command = {"operation_id": str(uuid4()), "action": "update", "type": "project",
                   "id": first["id"], "project_id": None, "version": first["version"],
                   "data": {"name": "Changed", "purpose": "synthetic", "owner_id": owner_id,
                            "state": "進行中"}, "reason": "synthetic"}
        assert call(preview, body=command, cookie=viewer_cookie)[0] == 403
        assert call(preview, body=command, cookie=viewer_cookie, origin=ORIGIN)[0] in {403, 404}
        accounts.change_password(viewer_subject, "synthetic rotated passphrase 03")
        assert call(projects, cookie=viewer_cookie)[0] == 401
        status, headers, _ = call("/login", body={"login": "viewer", "password": "synthetic rotated passphrase 03"}, origin=ORIGIN)
        assert status == 200
        viewer_cookie = headers["Set-Cookie"].split(";", 1)[0]
        access.deactivate_member(viewer["member_id"], operation_id=str(uuid4()), reason="leave")
        assert call(projects, cookie=viewer_cookie)[0] == 403
        assert call("/login", body={"login": "viewer", "password": "synthetic rotated passphrase 03"}, origin=ORIGIN)[0] == 401
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_shared_login_throttle_and_account_revoke(tmp_path: Path) -> None:
    path = tmp_path / "credentials.sqlite3"
    store = LocalCredentialStore.initialize(path)
    subject = store.create_account("test.user", "synthetic account passphrase 01")
    from deskly.shared_auth import SharedSessions

    sessions = SharedSessions(store)
    for _ in range(5):
        assert sessions.allowed_login("127.0.0.1")
        sessions.record_failure("127.0.0.1")
    assert not sessions.allowed_login("127.0.0.1")
    authenticated = store.authenticate("test.user", "synthetic account passphrase 01")
    assert authenticated is not None
    token = sessions.create(*authenticated)
    assert sessions.subject(token) == subject
    store.deactivate(subject)
    assert sessions.subject(token) is None
    assert store.authenticate("test.user", "synthetic account passphrase 01") is None


def test_shared_health_requires_active_bound_owner(tmp_path: Path) -> None:
    wid, _owner = WorkspaceStore.initialize(tmp_path, "Synthetic", "UTC", "Owner")
    path = tmp_path / "credentials.sqlite3"
    accounts = LocalCredentialStore.initialize(path)
    subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    server = create_shared_dashboard_server(home=tmp_path, workspace_id=wid,
                                            credential_store=path, public_origin=ORIGIN,
                                            host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def health() -> int:
        request = Request(f"http://127.0.0.1:{server.server_port}/healthz")
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status

    try:
        assert health() == 503
        service = WorkspaceService(tmp_path, wid, secret=b"synthetic")
        access = WorkspaceAccess(WorkspaceStore(workspace_path(tmp_path, wid)), wid,
                                 service.principal())
        access.bind_owner_identity(ORIGIN, subject, operation_id=str(uuid4()), reason="bootstrap")
        assert health() == 200
        accounts.deactivate(subject)
        assert health() == 503
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
