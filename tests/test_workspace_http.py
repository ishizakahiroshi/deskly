"""Synthetic HTTP boundary checks for the personal workspace."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from uuid import uuid4

from deskly.dashboard_server import (
    DASHBOARD_PASSWORD_ENV,
    SESSION_COOKIE_NAME,
    create_dashboard_server,
)
from deskly.workspace_service import WorkspaceService
from deskly.workspace_store import WorkspaceStore


def test_workspace_http_auth_origin_validation_and_confirmed_write(tmp_path: Path) -> None:
    wid, member = WorkspaceStore.initialize(tmp_path, "合成 workspace", "Asia/Tokyo", "合成担当")
    service = WorkspaceService(tmp_path, wid, secret=b"synthetic-http-secret")
    server = create_dashboard_server(port=0, environ={DASHBOARD_PASSWORD_ENV: "synthetic-dashboard-password"},
                                     workspace_service=service,
                                     dashboard_provider=lambda: {}, notification_provider=lambda: {})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def call(path: str, *, body: object | None = None, cookie: str = "",
             origin: str | None = None) -> tuple[int, dict[str, object], object]:
        headers = {"Accept": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if origin is not None:
            headers["Origin"] = origin
            headers["Sec-Fetch-Site"] = "same-origin"
        raw = json.dumps(body).encode() if body is not None else None
        if raw is not None:
            headers["Content-Type"] = "application/json"
        request = Request(base + path, data=raw, headers=headers,
                          method="POST" if raw is not None else "GET")
        try:
            response = build_opener().open(request, timeout=3)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, dict(response.headers), json.loads(response.read())

    try:
        path = f"/api/workspaces/{wid}/projects"
        assert call(path)[0] == 401
        status, headers, result = call("/login", body={"password": "synthetic-dashboard-password"}, origin=base)
        assert status == 200 and result == {"authenticated": True}
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        assert cookie.startswith(SESSION_COOKIE_NAME + "=")
        assert call(path, cookie=cookie)[0] == 200
        assert call(f"/api/workspaces/{uuid4()}/projects", cookie=cookie)[0] == 404
        command = {"operation_id": str(uuid4()), "action": "create", "type": "project",
                   "id": None, "project_id": None, "version": None,
                   "data": {"name": "合成案件", "purpose": "合成の目的", "owner_id": member,
                            "state": "進行中"}, "reason": "合成で作成"}
        preview_path = f"/api/workspaces/{wid}/commands/preview"
        apply_path = f"/api/workspaces/{wid}/commands/apply"
        assert call(preview_path, body=command, cookie=cookie)[0] == 403
        assert call(preview_path, body={**command, "actor": member}, cookie=cookie, origin=base)[0] == 400
        status, _, preview = call(preview_path, body=command, cookie=cookie, origin=base)
        assert status == 200
        assert call(path, cookie=cookie)[2]["projects"] == []
        status, _, saved = call(apply_path, body=preview, cookie=cookie, origin=base)
        assert status == 200 and saved["owner_id"] == member
        assert call(apply_path, body=preview, cookie=cookie, origin=base)[2] == saved
        assert call(path, cookie=cookie)[2]["projects"][0]["id"] == saved["id"]
        assert call(f"/api/workspaces/{wid}/projects/{saved['id']}/history", cookie=cookie)[2]["events"][0]["member_id"] == member
        source = service.apply(service.preview({"operation_id": str(uuid4()), "action": "create",
            "type": "source", "id": None, "project_id": None, "version": None,
            "data": {"label": "合成外部案件", "adapter": "external_case", "binding": "issuepost"},
            "reason": "合成で接続元を登録"}))
        service.apply(service.preview({"operation_id": str(uuid4()), "action": "create",
            "type": "reference", "id": None, "project_id": saved["id"], "version": None,
            "data": {"kind": "external_case", "target": "SYN-1", "label": "合成参照",
                     "source_id": source["id"], "linked_id": ""}, "reason": "合成で参照を追加"}))
        fetch_path = f"/api/workspaces/{wid}/sources/fetch"
        assert call(fetch_path, body={"project_id": saved["id"]}, origin=base)[0] == 401
        assert call(fetch_path, body={"project_id": saved["id"]}, cookie=cookie)[0] == 403
        assert call(fetch_path, body={"project_id": str(uuid4())}, cookie=cookie, origin=base)[0] == 404
        status, _, fetched = call(fetch_path, body={"project_id": saved["id"]}, cookie=cookie, origin=base)
        assert status == 200 and fetched["references"][0]["status"] == "not_connected"
        assert call(preview_path, body={**command, "operation_id": str(uuid4()),
               "data": {**command["data"], "purpose": "x" * 1000}}, cookie=cookie, origin=base)[0] == 400
        assert "password" not in json.dumps(call(path, cookie=cookie)[2])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
