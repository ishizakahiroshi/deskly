"""Synthetic shared Web identity, cookie, CSRF, and authorization boundaries."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

import pytest

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


def _login_server(tmp_path: Path, trusted_proxies: str = "") -> tuple[Any, threading.Thread]:
    wid, _owner = WorkspaceStore.initialize(tmp_path, "Synthetic", "UTC", "Owner")
    path = tmp_path / "credentials.sqlite3"
    accounts = LocalCredentialStore.initialize(path)
    subject = accounts.create_account("owner", "synthetic owner passphrase 01")
    service = WorkspaceService(tmp_path, wid, secret=b"synthetic")
    WorkspaceAccess(WorkspaceStore(workspace_path(tmp_path, wid)), wid,
                    service.principal()).bind_owner_identity(
        ORIGIN, subject, operation_id=str(uuid4()), reason="bootstrap")
    server = create_shared_dashboard_server(home=tmp_path, workspace_id=wid,
                                            credential_store=path, public_origin=ORIGIN,
                                            host="127.0.0.1", port=0,
                                            trusted_proxies=trusted_proxies)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _login(server: Any, password: str, *, real_ip: str | None = None,
           forwarded_for: str | None = None) -> int:
    headers = {"Host": "shared.example.test", "Origin": ORIGIN,
               "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"}
    if real_ip is not None:
        headers["X-Real-IP"] = real_ip
    if forwarded_for is not None:
        headers["X-Forwarded-For"] = forwarded_for
    request = Request(f"http://127.0.0.1:{server.server_port}/login",
                      data=json.dumps({"login": "owner", "password": password}).encode(),
                      headers=headers, method="POST")
    try:
        response = build_opener().open(request, timeout=5)
    except HTTPError as exc:
        response = exc
    with response:
        return int(response.status)


GOOD = "synthetic owner passphrase 01"
BAD = "synthetic wrong passphrase 99"


def test_untrusted_peer_cannot_change_throttle_address_with_headers(tmp_path: Path) -> None:
    server, thread = _login_server(tmp_path)
    try:
        for index in range(5):
            spoofed = f"203.0.113.{index + 1}"
            assert _login(server, BAD, real_ip=spoofed, forwarded_for=spoofed) == 401
        # Headers from an untrusted peer are ignored, so the peer stays throttled.
        assert _login(server, GOOD, real_ip="198.51.100.7",
                      forwarded_for="198.51.100.7") == 429
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_trusted_proxy_counts_failures_per_real_client(tmp_path: Path) -> None:
    server, thread = _login_server(tmp_path, trusted_proxies="127.0.0.0/8")
    try:
        for _ in range(5):
            assert _login(server, BAD, real_ip="203.0.113.9",
                          forwarded_for="203.0.113.9") == 401
        # The guessing client remains throttled, even with the right passphrase.
        assert _login(server, GOOD, real_ip="203.0.113.9") == 429
        # Another person's failures do not lock the owner out from their own address.
        assert _login(server, GOOD, real_ip="198.51.100.7",
                      forwarded_for="198.51.100.7") == 200
        # Without X-Real-IP, the right-most untrusted X-Forwarded-For hop is used;
        # a client-supplied left-most value cannot move the guesser elsewhere.
        assert _login(server, GOOD, forwarded_for="198.51.100.7, 203.0.113.9") == 429
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_resolve_client_address_and_trusted_proxy_config(tmp_path: Path) -> None:
    from deskly.dashboard_server import DashboardConfigurationError, create_dashboard_server
    from deskly.shared_auth import parse_trusted_proxies, resolve_client_address

    proxies = parse_trusted_proxies("192.0.2.10, 192.0.2.0/28 2001:db8::/32")
    assert len(proxies) == 3
    assert parse_trusted_proxies("") == ()
    for invalid in ("0.0.0.0/0", "::/0", "not-an-address", "192.0.2.1:80"):
        with pytest.raises(ValueError):
            parse_trusted_proxies(invalid)
    assert resolve_client_address("192.0.2.10", ["203.0.113.5"], [], ()) == "192.0.2.10"
    assert resolve_client_address("198.51.100.1", ["203.0.113.5"], [], proxies) == "198.51.100.1"
    assert resolve_client_address("192.0.2.10", ["203.0.113.5"], [], proxies) == "203.0.113.5"
    assert resolve_client_address("192.0.2.10", [], ["203.0.113.1, 203.0.113.5, 192.0.2.3"],
                                  proxies) == "203.0.113.5"
    assert resolve_client_address("192.0.2.10", ["bogus"], ["bogus"], proxies) == "192.0.2.10"
    assert resolve_client_address("192.0.2.10", ["203.0.113.5", "203.0.113.6"], [],
                                  proxies) == "192.0.2.10"

    wid, _owner = WorkspaceStore.initialize(tmp_path, "Synthetic", "UTC", "Owner")
    path = tmp_path / "credentials.sqlite3"
    LocalCredentialStore.initialize(path)
    with pytest.raises(DashboardConfigurationError):
        create_shared_dashboard_server(home=tmp_path, workspace_id=wid, credential_store=path,
                                       public_origin=ORIGIN, host="127.0.0.1", port=0,
                                       trusted_proxies="0.0.0.0/0")
    personal = create_dashboard_server(port=0, environ={
        "DESKLY_DASHBOARD_PASSWORD": "synthetic personal passphrase"},
        workspace_service=object())
    try:
        assert personal.trusted_proxies == ()
    finally:
        personal.server_close()
