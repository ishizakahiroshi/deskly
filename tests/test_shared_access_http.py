"""Synthetic owner-only access management through the shared HTTP entry."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

import pytest

from deskly.dashboard_server import create_shared_dashboard_server
from deskly.shared_auth import CredentialStoreError, LocalCredentialStore
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore, workspace_path

ORIGIN = "https://shared.example.test"


@pytest.mark.parametrize("retry_with_new_operation", [False, True])
def test_owner_access_http_grants_and_deactivation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, retry_with_new_operation: bool,
) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "Synthetic team", "UTC", "Owner")
    store = WorkspaceStore(workspace_path(tmp_path, wid))
    credential_path = tmp_path / "accounts.sqlite3"
    accounts = LocalCredentialStore.initialize(credential_path)
    owner_subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    member_subject = accounts.create_account("member", "synthetic member passphrase 02")
    owner_service = WorkspaceService(tmp_path, wid, secret=b"synthetic-secret")
    access = WorkspaceAccess(store, wid, owner_service.principal())
    access.bind_owner_identity(ORIGIN, owner_subject, operation_id=str(uuid4()), reason="setup")
    member = access.add_member("Member", ORIGIN, member_subject,
                               operation_id=str(uuid4()), reason="enroll")
    project = owner_service.apply(owner_service.preview({
        "operation_id": str(uuid4()), "action": "create", "type": "project",
        "id": None, "project_id": None, "version": None,
        "data": {"name": "Synthetic project", "purpose": "test", "owner_id": owner_id,
                 "state": "進行中"}, "reason": "test",
    }))
    server = create_shared_dashboard_server(
        home=tmp_path, workspace_id=wid, credential_store=credential_path,
        public_origin=ORIGIN, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    def call(path: str, *, body: object | None = None, cookie: str = "") -> tuple[int, object, dict[str, str]]:
        headers = {"Host": "shared.example.test", "Accept": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if body is not None:
            headers.update({"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin",
                            "Content-Type": "application/json"})
        request = Request(url + path, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None,
                          method="POST" if body is not None else "GET")
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, dict(response.headers)

    try:
        def login(name: str, password: str) -> str:
            status, _, headers = call("/login", body={"login": name, "password": password})
            assert status == 200
            return headers["Set-Cookie"].split(";", 1)[0]

        owner_cookie = login("owner", "synthetic owner passphrase 01")
        member_cookie = login("member", "synthetic member passphrase 02")
        members_path = f"/api/workspaces/{wid}/access/members"
        grants_path = f"/api/workspaces/{wid}/access/grants"
        counts_path = f"/api/workspaces/{wid}/counts"
        search_visible_path = f"/api/workspaces/{wid}/search/Synthetic"
        search_hidden_path = f"/api/workspaces/{wid}/search/not-found"
        assert call(members_path)[0] == 401
        assert call(members_path, cookie=member_cookie)[0] == 403
        assert call(counts_path)[0] == 401
        assert call(search_visible_path, cookie=member_cookie)[0] == 200
        assert call(search_hidden_path, cookie=member_cookie)[1]["results"] == []
        assert call(counts_path, cookie=member_cookie)[1]["projects"] == 0
        status, view, _ = call(members_path, cookie=owner_cookie)
        assert status == 200
        assert {row["name"] for row in view["members"]} == {"Owner", "Member"}
        assert "subject" not in json.dumps(view) and "password" not in json.dumps(view)
        grant = {"project_id": project["id"], "member_id": member["member_id"],
                 "role": "viewer", "expected_version": 0,
                 "operation_id": str(uuid4()), "reason": "Synthetic grant"}
        assert call(grants_path, body=grant, cookie=member_cookie)[0] == 403
        assert call(grants_path, body={key: value for key, value in grant.items()
                                      if key != "expected_version"}, cookie=owner_cookie)[0] == 400
        assert call(grants_path, body=grant, cookie=owner_cookie)[1]["version"] == 1
        assert call(counts_path, cookie=member_cookie)[1]["projects"] == 1
        assert [row["project_id"] for row in
                call(search_visible_path, cookie=member_cookie)[1]["results"]] == [project["id"]]
        grant_event = next(event for event in access.history()
                           if event["operation_id"] == grant["operation_id"])
        assert grant_event["actor_member_id"] == owner_id
        assert grant_event["requester_member_id"] == owner_id
        assert grant_event["executor_kind"] == "unknown"
        assert grant_event["executor_ref"] is None
        assert grant_event["executor_verified"] == 0
        assert grant_event["route"] == "dashboard"
        assert call(grants_path, body={**grant, "operation_id": str(uuid4())},
                    cookie=owner_cookie)[0] == 409
        assert call(members_path, cookie=owner_cookie)[1]["grants"][0]["role"] == "viewer"
        edit = {**grant, "role": "editor", "expected_version": 1,
                "operation_id": str(uuid4()), "reason": "Synthetic edit access"}
        assert call(grants_path, body=edit, cookie=owner_cookie)[1]["version"] == 2
        revoke = {**grant, "role": None, "expected_version": 2,
                  "operation_id": str(uuid4()), "reason": "Synthetic revoke"}
        assert call(grants_path, body=revoke, cookie=owner_cookie)[1]["role"] is None
        assert call(members_path, cookie=member_cookie)[0] == 403
        deactivate_path = f"/api/workspaces/{wid}/access/members/{member['member_id']}/deactivate"
        request = {"expected_version": 1, "operation_id": str(uuid4()), "reason": "Synthetic leave"}
        assert call(deactivate_path, body=request, cookie=member_cookie)[0] == 403
        assert call(deactivate_path, body={**request, "expected_version": 2},
                    cookie=owner_cookie)[0] == 409
        original_deactivate = server.shared_accounts.deactivate
        failed = False

        def fail_once(subject: str) -> None:
            nonlocal failed
            if not failed:
                failed = True
                raise CredentialStoreError("synthetic credential-store interruption")
            original_deactivate(subject)

        monkeypatch.setattr(server.shared_accounts, "deactivate", fail_once)
        assert call(deactivate_path, body=request, cookie=owner_cookie)[0] == 503
        pending = call(members_path, cookie=owner_cookie)[1]["members"]
        revoked_member = next(row for row in pending if row["member_id"] == member["member_id"])
        assert revoked_member["active"] is False
        assert revoked_member["credential_revocation_pending"] is True
        retry = ({"expected_version": 2, "operation_id": str(uuid4()),
                  "reason": "Synthetic credential revocation retry"}
                 if retry_with_new_operation else request)
        repaired_status, repaired, _ = call(deactivate_path, body=retry, cookie=owner_cookie)
        assert repaired_status == 200
        assert repaired["active"] is False
        assert repaired["credential_revocation_pending"] is False
        assert member_subject not in accounts.active_subjects()
        assert call(members_path, cookie=member_cookie)[0] == 401
        assert call("/login", body={"login": "member", "password": "synthetic member passphrase 02"})[0] == 401
        assert any(row["member_id"] == member["member_id"] and row["version"] == 2
                   for row in call(members_path, cookie=owner_cookie)[1]["members"])
        events = access.history()
        credential_events = [event for event in events
                              if event["target_type"] == "member_credentials"
                              and event["target_id"] == member["member_id"]]
        assert len(credential_events) == 1
        assert credential_events[0]["route"] == "dashboard"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
