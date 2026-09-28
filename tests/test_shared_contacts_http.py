"""Synthetic permission checks for the shared, read-only contact routes."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

from deskly import contact_read_client
from deskly.api_server import create_http_server
from deskly.dashboard_server import create_shared_dashboard_server
from deskly.model import Contact
from deskly.shared_auth import LocalCredentialStore
from deskly.store import SqliteStore
from deskly.workspace_access import WorkspaceAccess
from deskly.workspace_backup import export_workspace
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore

ORIGIN = "https://shared.example.test"
READ_TOKEN = "synthetic-single-contact-capability"
GENERAL_TOKEN = "synthetic-general-api-token"


def _create(service: WorkspaceService, kind: str, data: dict[str, object],
            project_id: str | None = None) -> dict[str, object]:
    request = {"operation_id": str(uuid4()), "action": "create", "type": kind,
               "id": None, "project_id": project_id, "version": None,
               "data": data, "reason": "合成テスト"}
    return service.apply(service.preview(request))


def test_shared_contact_list_and_detail_enforce_project_source_and_session(
    tmp_path: Path,
) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成チーム", "UTC", "管理者")
    workspace = WorkspaceService(tmp_path, wid, secret=b"synthetic-secret")
    allowed_project = _create(workspace, "project", {
        "name": "合成案件A", "purpose": "共有連絡の確認", "owner_id": owner_id,
        "state": "進行中",
    })
    denied_project = _create(workspace, "project", {
        "name": "合成案件B", "purpose": "別案件", "owner_id": owner_id,
        "state": "進行中",
    })
    company_path = tmp_path / "ledger" / "company.sqlite3"
    company_path.parent.mkdir(parents=True)
    with SqliteStore(company_path) as ledger:
        linked_data = Contact(
            id="c-20260928-00000001", project="SYN-A", recipient="Synthetic recipient",
            sent_at="2026-09-28 09:00", state="送信済み", promise="合成の約束",
            agreement="合成の合意", body="Synthetic body must only be returned by detail",
            sensitive="", source_path="private-path-must-not-escape",
            source_hash="synthetic-hash",
        ).to_dict()
        linked_data.pop("created_at")
        linked_data.pop("updated_at")
        linked = ledger.create(linked_data)
        other_data = Contact(
            id="c-20260928-00000002", project="SYN-B", recipient="Other recipient",
            state="送信済み", body="Other project body",
        ).to_dict()
        other_data.pop("created_at")
        other_data.pop("updated_at")
        other = ledger.create(other_data)
        sensitive_data = Contact(
            id="c-20260928-00000004", project="SYN-A", recipient="Sensitive recipient",
            state="送信済み", sensitive="Synthetic restricted marker",
            body="Synthetic sensitive body must never be returned",
        ).to_dict()
        sensitive_data.pop("created_at")
        sensitive_data.pop("updated_at")
        sensitive = ledger.create(sensitive_data)
    source = _create(workspace, "source", {
        "label": "合成会社台帳", "adapter": "contact", "binding": "company",
    })
    missing_source = _create(workspace, "source", {
        "label": "未接続台帳", "adapter": "contact", "binding": "unconfigured",
    })
    reference = _create(workspace, "reference", {
        "kind": "contact", "target": linked.id, "label": "合成連絡",
        "linked_id": "", "source_id": source["id"],
    }, str(allowed_project["id"]))
    _create(workspace, "reference", {
        "kind": "contact", "target": other.id, "label": "未接続の合成連絡",
        "linked_id": "", "source_id": missing_source["id"],
    }, str(allowed_project["id"]))
    _create(workspace, "reference", {
        "kind": "contact", "target": sensitive.id, "label": "別の合成連絡",
        "linked_id": "", "source_id": source["id"],
    }, str(allowed_project["id"]))

    accounts_path = tmp_path / "accounts.sqlite3"
    accounts = LocalCredentialStore.initialize(accounts_path)
    owner_subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    member_subject = accounts.create_account("member", "synthetic member passphrase 02")
    access = WorkspaceAccess(workspace.store, wid, workspace.principal())
    access.bind_owner_identity(ORIGIN, owner_subject, operation_id=str(uuid4()), reason="合成初期設定")
    member = access.add_member("合成参加者", ORIGIN, member_subject,
                               operation_id=str(uuid4()), reason="合成登録")
    access.set_project_role(str(allowed_project["id"]), str(member["member_id"]), "viewer",
                            expected_version=0, operation_id=str(uuid4()), reason="合成案件許可")
    server = create_shared_dashboard_server(
        home=tmp_path, workspace_id=wid, credential_store=accounts_path,
        public_origin=ORIGIN, host="127.0.0.1", port=0,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    def call(path: str, *, cookie: str = "", authorization: str = "",
             body: object | None = None) -> tuple[int, object, dict[str, str]]:
        headers = {"Host": "shared.example.test", "Accept": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if authorization:
            headers["Authorization"] = authorization
        data = None
        method = "GET"
        if body is not None:
            headers.update({"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin",
                            "Content-Type": "application/json"})
            data = json.dumps(body).encode()
            method = "POST"
        request = Request(url + path, headers=headers, data=data, method=method)
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, dict(response.headers)

    def login(name: str, password: str) -> str:
        request = Request(
            url + "/login",
            headers={"Host": "shared.example.test", "Origin": ORIGIN,
                     "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"},
            data=json.dumps({"login": name, "password": password}).encode(), method="POST",
        )
        with build_opener().open(request, timeout=3) as response:
            return response.headers["Set-Cookie"].split(";", 1)[0]

    try:
        base = f"/api/workspaces/{wid}/projects/{allowed_project['id']}/contacts"
        assert call(base)[0] == 401
        assert call(base, authorization="Bearer synthetic-full-ledger-token")[0] == 401
        owner_cookie = login("owner", "synthetic owner passphrase 01")
        member_cookie = login("member", "synthetic member passphrase 02")

        # Project access without source access exposes no contact or count.
        status, denied_source, _ = call(base, cookie=member_cookie)
        assert status == 200
        assert denied_source == {"project_id": allowed_project["id"],
                                 "status": "no_references", "contacts": []}
        access_path = f"/api/workspaces/{wid}/access/sources"
        source_grants_path = f"/api/workspaces/{wid}/access/source-grants"
        assert call(access_path, cookie=member_cookie)[0] == 403
        assert call(f"/api/workspaces/{wid}/projects", cookie=member_cookie)[1]["sources"] == []
        grant = {"source_id": source["id"], "member_id": member["member_id"], "allowed": True,
                 "expected_version": 0, "operation_id": str(uuid4()), "reason": "合成source許可"}
        assert call(source_grants_path, cookie=member_cookie, body=grant)[0] == 403
        status, owner_view, _ = call(access_path, cookie=owner_cookie)
        assert status == 200
        assert any(item["id"] == source["id"] for item in owner_view["sources"])
        assert "subject" not in json.dumps(owner_view) and "password" not in json.dumps(owner_view)
        status, applied, _ = call(source_grants_path, cookie=owner_cookie, body=grant)
        assert status == 200 and applied["allowed"] is True and applied["version"] == 1
        listed_grants = call(access_path, cookie=owner_cookie)[1]["grants"]
        assert any(item["source_id"] == source["id"] and item["member_id"] == member["member_id"]
                   and item["allowed"] is True and item["version"] == 1 for item in listed_grants)
        stale_grant = {**grant, "allowed": False, "operation_id": str(uuid4()),
                       "reason": "合成古い版取消"}
        assert call(source_grants_path, cookie=owner_cookie, body=stale_grant)[0] == 409
        visible_sources = call(f"/api/workspaces/{wid}/projects", cookie=member_cookie)[1]["sources"]
        assert visible_sources == [{"id": source["id"], "label": "合成会社台帳",
                                    "adapter": "contact"}]
        assert "binding" not in json.dumps(visible_sources)

        status, listing, headers = call(base, cookie=member_cookie)
        assert status == 200 and headers["Cache-Control"] == "no-store"
        assert listing["status"] == "connected"
        assert [row["id"] for row in listing["contacts"]] == [linked.id]
        assert "body" not in json.dumps(listing)
        assert other.id not in json.dumps(listing)
        assert sensitive.id not in json.dumps(listing)
        assert "Synthetic restricted marker" not in json.dumps(listing)

        detail_path = base + "/" + linked.id
        status, detail, headers = call(detail_path, cookie=member_cookie)
        assert status == 200 and headers["Cache-Control"] == "no-store"
        assert detail["contact"]["body"] == "Synthetic body must only be returned by detail"
        assert "source_path" not in json.dumps(detail)
        assert "source_hash" not in json.dumps(detail)
        assert "sensitive" not in json.dumps(detail)
        assert "extra" not in detail["contact"]
        sensitive_status, sensitive_error, _ = call(base + "/" + sensitive.id,
                                                      cookie=member_cookie)
        guessed_status, guessed_error, _ = call(base + "/c-20260928-ffffffff",
                                                  cookie=member_cookie)
        assert (sensitive_status, sensitive_error) == (guessed_status, guessed_error)
        assert sensitive_status == 404
        with workspace.store.connect() as db:
            persisted = " ".join(str(row[0]) for row in db.execute(
                "SELECT before_json FROM events WHERE workspace_id=? AND before_json IS NOT NULL "
                "UNION ALL SELECT after_json FROM events WHERE workspace_id=?",
                (wid, wid),
            ))
            assert "Synthetic body must only be returned by detail" not in persisted
        backup_path = tmp_path / "workspace-backup.jsonl"
        export_workspace(tmp_path, wid, backup_path)
        assert "Synthetic body must only be returned by detail" not in backup_path.read_text(
            encoding="utf-8",
        )

        guessed = base + "/c-20260928-ffffffff"
        assert call(guessed, cookie=owner_cookie)[0] == 404
        denied = f"/api/workspaces/{wid}/projects/{denied_project['id']}/contacts/{linked.id}"
        assert call(denied, cookie=member_cookie)[0] == 404

        revoke = {**grant, "allowed": False, "expected_version": 1,
                  "operation_id": str(uuid4()), "reason": "合成取消"}
        status, revoked, _ = call(source_grants_path, cookie=owner_cookie, body=revoke)
        assert status == 200 and revoked["allowed"] is False and revoked["version"] == 2
        assert call(detail_path, cookie=member_cookie)[0] == 404
        assert call(base, cookie=member_cookie)[1]["status"] == "no_references"
        assert call(f"/api/workspaces/{wid}/projects", cookie=member_cookie)[1]["sources"] == []
        audit = [item for item in access.history() if item["target_type"] == "source_access"
                 and item["target_id"] == source["id"]]
        assert len(audit) == 2
        revocation = next(item for item in audit if item["after"]["version"] == 2)
        assert revocation["actor_member_id"] == owner_id
        assert revocation["reason"] == "合成取消"
        assert revocation["before"]["version"] == 1
        assert revocation["after"]["allowed"] is False

        # Missing configured bindings are distinct from an absent linked ID.
        status, unconnected, _ = call(base, cookie=owner_cookie)
        assert status == 200 and unconnected["status"] == "partial"
        assert all(row["id"] != other.id for row in unconnected["contacts"])
        missing = _create(workspace, "project", {
            "name": "未接続案件", "purpose": "接続状態の確認", "owner_id": owner_id,
            "state": "進行中",
        })
        missing_ref = _create(workspace, "reference", {
            "kind": "contact", "target": "c-20260928-00000003", "label": "未接続",
            "linked_id": "", "source_id": missing_source["id"],
        }, str(missing["id"]))
        del reference, missing_ref
        status, unconnected, _ = call(
            f"/api/workspaces/{wid}/projects/{missing['id']}/contacts", cookie=owner_cookie,
        )
        assert status == 200 and unconnected["status"] == "not_connected"
        status, unavailable, _ = call(
            f"/api/workspaces/{wid}/projects/{missing['id']}/contacts/c-20260928-00000003",
            cookie=owner_cookie,
        )
        assert status == 200 and unavailable == {
            "project_id": missing["id"], "status": "not_connected", "contact": None,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_server_contact_capability_and_owner_link_flow(
    tmp_path: Path, monkeypatch,
) -> None:
    wid, owner_id = WorkspaceStore.initialize(tmp_path, "合成チーム", "UTC", "管理者")
    workspace = WorkspaceService(tmp_path, wid, secret=b"synthetic-secret")
    project = _create(workspace, "project", {
        "name": "合成案件", "purpose": "内部連絡の読取", "owner_id": owner_id,
        "state": "進行中",
    })
    denied_project = _create(workspace, "project", {
        "name": "別の合成案件", "purpose": "権限確認", "owner_id": owner_id,
        "state": "進行中",
    })
    ledger_path = tmp_path / "company-ledger.sqlite3"
    with SqliteStore(ledger_path) as ledger:
        linked_data = Contact(
            id="c-20260928-00000021", project="SYN-A", recipient="Synthetic recipient",
            state="送信済み", body="Synthetic body from server ledger",
        ).to_dict()
        linked_data.pop("created_at")
        linked_data.pop("updated_at")
        linked = ledger.create(linked_data)
        unlinked_data = Contact(
            id="c-20260928-00000022", project="SYN-B", recipient="Other synthetic recipient",
            state="送信済み", body="Unlinked body must never be returned",
        ).to_dict()
        unlinked_data.pop("created_at")
        unlinked_data.pop("updated_at")
        unlinked = ledger.create(unlinked_data)
        sensitive_data = Contact(
            id="c-20260928-00000023", project="SYN-A", recipient="Restricted synthetic recipient",
            state="送信済み", sensitive="Synthetic server restricted marker",
            body="Synthetic server sensitive body must never be returned",
        ).to_dict()
        sensitive_data.pop("created_at")
        sensitive_data.pop("updated_at")
        sensitive = ledger.create(sensitive_data)

    api = create_http_server(
        ledger_path, GENERAL_TOKEN, contact_read_token=READ_TOKEN,
        host="127.0.0.1", port=0, revision="synthetic-revision",
    )
    api_thread = threading.Thread(target=api.serve_forever, daemon=True)
    api_thread.start()
    monkeypatch.setattr(contact_read_client, "INTERNAL_CONTACT_API_URL",
                        f"http://127.0.0.1:{api.server_port}")
    monkeypatch.setenv("DESKLY_CONTACT_READ_TOKEN", READ_TOKEN)
    monkeypatch.delenv("DESKLY_API_TOKEN", raising=False)

    accounts_path = tmp_path / "accounts.sqlite3"
    accounts = LocalCredentialStore.initialize(accounts_path)
    owner_subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    member_subject = accounts.create_account("member", "synthetic member passphrase 02")
    access = WorkspaceAccess(workspace.store, wid, workspace.principal())
    access.bind_owner_identity(ORIGIN, owner_subject, operation_id=str(uuid4()), reason="合成初期設定")
    member = access.add_member("合成参加者", ORIGIN, member_subject,
                               operation_id=str(uuid4()), reason="合成登録")
    access.set_project_role(str(project["id"]), str(member["member_id"]), "viewer",
                            expected_version=0, operation_id=str(uuid4()), reason="合成案件許可")
    server = create_shared_dashboard_server(
        home=tmp_path, workspace_id=wid, credential_store=accounts_path,
        public_origin=ORIGIN, host="127.0.0.1", port=0,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    def call(path: str, *, cookie: str = "", body: object | None = None) -> tuple[int, object, dict[str, str]]:
        headers = {"Host": "shared.example.test", "Accept": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        data = None
        method = "GET"
        if body is not None:
            headers.update({"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin",
                            "Content-Type": "application/json"})
            data = json.dumps(body).encode()
            method = "POST"
        request = Request(url + path, headers=headers, data=data, method=method)
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, dict(response.headers)

    def login(name: str, password: str) -> str:
        status, _, headers = call("/login", body={"login": name, "password": password})
        assert status == 200
        return headers["Set-Cookie"].split(";", 1)[0]

    try:
        owner_cookie = login("owner", "synthetic owner passphrase 01")
        member_cookie = login("member", "synthetic member passphrase 02")
        sources_path = f"/api/workspaces/{wid}/sources/contact"
        assert call(sources_path, cookie=member_cookie)[0] == 403
        assert call(sources_path, cookie=owner_cookie)[1] == {"sources": []}

        registration = {"label": "合成会社台帳", "binding": "company",
                        "operation_id": str(uuid4()), "reason": "合成source登録"}
        member_configured = call(sources_path, cookie=member_cookie, body=registration)
        invalid_registration = {
            **registration, "binding": "synthetic-invalid-alias",
            "operation_id": str(uuid4()),
        }
        member_invalid = call(sources_path, cookie=member_cookie, body=invalid_registration)
        assert member_configured[0] == member_invalid[0] == 403
        assert member_configured[1] == member_invalid[1]
        assert call(sources_path, cookie=member_cookie)[0] == 403
        status, source_result, _ = call(sources_path, cookie=owner_cookie, body=registration)
        assert status == 200 and source_result["adapter"] == "contact"
        source_id = source_result["id"]
        source_list = call(sources_path, cookie=owner_cookie)[1]
        assert source_list["sources"] == [{"id": source_id, "label": "合成会社台帳",
                                           "binding": "company", "version": 1}]
        # Replaying an identical source registration keeps the same audited entity.
        assert call(sources_path, cookie=owner_cookie, body=registration)[1]["id"] == source_id

        link_path = f"/api/workspaces/{wid}/projects/{project['id']}/contacts/link"
        link = {"source_id": source_id, "contact_id": linked.id, "label": "合成連絡",
                "operation_id": str(uuid4()), "reason": "案件へ明示リンク"}
        assert call(link_path, cookie=member_cookie, body=link)[0] == 403
        status, result, _ = call(link_path, cookie=owner_cookie, body=link)
        assert status == 200 and result["status"] == "linked"
        sensitive_link = {
            "source_id": source_id, "contact_id": sensitive.id,
            "label": "合成制限付き連絡", "operation_id": str(uuid4()),
            "reason": "制限動作の合成確認",
        }
        assert call(link_path, cookie=owner_cookie, body=sensitive_link)[0] == 200
        reference_id = result["reference"]["id"]
        assert call(link_path, cookie=owner_cookie, body=link)[1]["reference"]["id"] == reference_id
        with workspace.store.connect() as db:
            event_entities = {row["entity_id"] for row in db.execute(
                "SELECT entity_id FROM events WHERE workspace_id=?", (wid,),
            )}
            assert source_id in event_entities and reference_id in event_entities

        # The member sees the exact link only after both grants; no candidate scan exists.
        contacts_path = f"/api/workspaces/{wid}/projects/{project['id']}/contacts"
        assert call(contacts_path, cookie=member_cookie)[1]["contacts"] == []
        access.set_source_access(source_id, str(member["member_id"]), True,
                                 expected_version=0, operation_id=str(uuid4()), reason="合成source許可")
        status, listing, _ = call(contacts_path, cookie=member_cookie)
        assert status == 200 and [item["id"] for item in listing["contacts"]] == [linked.id]
        assert sensitive.id not in json.dumps(listing)
        assert "Synthetic server restricted marker" not in json.dumps(listing)
        assert "Synthetic server sensitive body" not in json.dumps(listing)
        assert unlinked.id not in json.dumps(listing)
        detail_path = contacts_path + "/" + linked.id
        status, detail, _ = call(detail_path, cookie=member_cookie)
        assert status == 200 and detail["contact"]["body"] == "Synthetic body from server ledger"
        sensitive_status, sensitive_error, _ = call(
            contacts_path + "/" + sensitive.id, cookie=member_cookie,
        )
        unlinked_status, unlinked_error, _ = call(
            contacts_path + "/" + unlinked.id, cookie=member_cookie,
        )
        assert sensitive_status == unlinked_status == 404
        assert sensitive_error == unlinked_error
        denied_path = f"/api/workspaces/{wid}/projects/{denied_project['id']}/contacts/{linked.id}"
        assert call(denied_path, cookie=member_cookie)[0] == 404
        access.set_source_access(source_id, str(member["member_id"]), False,
                                 expected_version=1, operation_id=str(uuid4()), reason="合成取消")
        assert call(detail_path, cookie=member_cookie)[0] == 404
        assert "DESKLY_API_TOKEN" not in os.environ
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        api.shutdown()
        api.server_close()
        api_thread.join(timeout=2)
