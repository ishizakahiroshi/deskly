from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import textwrap
import tomllib
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "deskly" / "static"
ASSETS = ("index.html", "app.css", "app.js")
EXTERNAL_URL_RE = re.compile(
    r"(?:https?://|(?<!:)//(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/#?]|\b))",
    re.IGNORECASE,
)
UI_HARNESS = textwrap.dedent(
    r"""
    const fs = require("node:fs");
    const vm = require("node:vm");
    const fixture = JSON.parse(fs.readFileSync(0, "utf8"));

    class FakeNode {
      constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.hidden = false;
        this.value = "";
        this.listeners = {};
        this._text = null;
      }
      get textContent() {
        if (this._text !== null) return this._text;
        return this.children.map((child) => child.textContent || "").join("");
      }
      set textContent(value) {
        this._text = String(value);
        this.children = [];
      }
      addEventListener(name, handler) { this.listeners[name] = handler; }
      append(...children) { this._text = null; this.children.push(...children); }
      replaceChildren(...children) { this._text = null; this.children = [...children]; }
      focus() {}
    }

    const elements = new Map(fixture.ids.map((id) => [id, new FakeNode("div")]));
    const document = {
      getElementById(id) {
        if (!elements.has(id)) throw new Error(`missing fixture element: ${id}`);
        return elements.get(id);
      },
      createElement(tag) { return new FakeNode(tag); },
      createTextNode(text) {
        const node = new FakeNode("#text");
        node.textContent = text;
        return node;
      },
    };
    const fetch = async (url) => {
      const value = fixture.responses[url];
      return {
        ok: value.ok !== false,
        status: value.status || 200,
        json: async () => value.json,
      };
    };
    vm.runInNewContext(fixture.source, { document, fetch });

    setTimeout(() => {
      const treeTags = (node) => [node.tagName, ...node.children.flatMap(treeTags)];
      const output = {};
      for (const id of [
        "waiting-summary", "waiting-count", "cases-summary", "cases-count",
        "worklog-summary", "worklog-total", "notification-summary",
        "notification-waiting-count", "notification-overdue-count",
      ]) output[id] = document.getElementById(id).textContent;
      for (const id of ["waiting-rows", "case-rows", "worklog-rows"]) {
        const element = document.getElementById(id);
        output[id] = element.children.map((child) => child.textContent);
        output[`${id}-tags`] = element.children.flatMap(treeTags);
      }
      process.stdout.write(JSON.stringify(output));
    }, 0);
    """
)


def read_asset(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_dashboard_assets_are_present_and_referenced_from_same_origin() -> None:
    html = read_asset("index.html")
    for name in ASSETS:
        assert (STATIC / name).is_file()

    assert 'href="/static/app.css"' in html
    assert 'src="/static/app.js"' in html
    assert not EXTERNAL_URL_RE.search(html + read_asset("app.css") + read_asset("app.js"))
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html, flags=re.IGNORECASE)
    assert not re.search(r"\sstyle\s*=", html, flags=re.IGNORECASE)


def test_html_exposes_labeled_keyboard_login_and_dashboard_states() -> None:
    html = read_asset("index.html")
    assert '<html lang="ja">' in html
    assert '<label for="password-input">' in html
    assert 'autocomplete="current-password"' in html
    assert 'method="post" action="/login"' in html
    assert 'id="login-view"' in html
    assert 'id="dashboard-view" hidden' in html
    assert 'id="connection-status"' in html
    assert 'id="waiting-summary"' in html
    assert 'id="cases-summary"' in html
    assert 'id="worklog-summary"' in html
    assert "PREVIEW ONLY" in html
    assert "通知の送信はしません" in html
    assert "viewport" in html
    assert "@media (max-width:" in read_asset("app.css")
    assert ":focus-visible" in read_asset("app.css")


def test_javascript_uses_allowlisted_text_rendering_and_read_only_routes() -> None:
    source = read_asset("app.js")
    lowered = source.lower()

    assert "textcontent" in lowered
    assert "document.createelement" in lowered
    assert "replacechildren" in lowered
    for forbidden in (
        "innerhtml",
        "outerhtml",
        "insertadjacenthtml",
        "domparser",
        "localstorage",
        "sessionstorage",
        "authorization",
        "contact_id",
        "contact_ids",
        "contact_refs",
        "console.log",
        "xmlhttprequest",
        "websocket",
    ):
        assert forbidden not in lowered
    assert not re.search(r"\b(?:data|row|section)\.summaries?\b", source)
    assert ".error" not in source
    assert source.count("fetch(") == 1
    assert "setInterval(" not in source
    assert "new Notification(" not in source
    assert "section.truncated === true" in source
    assert "worklog.truncated === true" in source

    assert '"/api/dashboard", { method: "GET" }' in source
    assert '"/api/notification-preview", { method: "GET" }' in source
    assert '"/api/mode", { method: "GET" }' in source
    assert '"/api/workspace", { method: "GET" }' in source
    assert '"/login"' in source and 'method: "POST"' in source
    assert '"/logout"' in source and 'method: "POST"' in source
    assert '"same-origin"' in source
    assert "preview.preview_only !== true" in source
    for status in (
        "not_configured",
        "empty",
        "connected",
        "not_connected",
        "auth_error",
        "network_error",
        "schema_error",
        "config_error",
        "ledger_error",
        "execution_error",
        "timeout",
    ):
        assert status in source


def test_wheel_target_explicitly_includes_static_ui_assets() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    force_include = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    for name in ASSETS:
        asset_path = f"deskly/static/{name}"
        assert force_include[asset_path] == asset_path


def test_external_url_check_rejects_protocol_relative_hostnames() -> None:
    assert EXTERNAL_URL_RE.search("url(//cdn.example.invalid/font.woff2)")


def _run_synthetic_ui(
    *, waiting: dict[str, object], cases: dict[str, object], worklog: dict[str, object],
    preview: dict[str, object],
) -> dict[str, object]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for the browserless UI rendering contract")
    html = read_asset("index.html")
    fixture = {
        "source": read_asset("app.js"),
        "ids": re.findall(r'\bid="([^"]+)"', html),
        "responses": {
            "/api/dashboard": {
                "json": {
                    "generated_at_utc": "2026-09-27T00:00:00Z",
                    "waiting": waiting,
                    "cases": cases,
                    "worklog": worklog,
                }
            },
            "/api/notification-preview": preview,
        },
    }
    environment = {
        key: os.environ[key]
        for key in ("PATH", "SYSTEMROOT", "WINDIR", "PATHEXT")
        if key in os.environ
    }
    completed = subprocess.run(
        [node, "-e", UI_HARNESS],
        input=json.dumps(fixture, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
        env=environment,
    )
    return json.loads(completed.stdout)


def test_synthetic_connected_render_escapes_hostile_text_and_ignores_private_fields() -> None:
    hostile_title = '</h3><img src=x onerror="synthetic">'
    rendered = _run_synthetic_ui(
        waiting={
            "status": "connected", "count": 1, "overdue_count": 0, "total_count": 1,
            "truncated": False,
            "rows": [{"project": "Synthetic project", "turn": "unknown", "due": "2026-10-01",
                      "count": 1, "states": ["回答待ち"], "ledger_names": ["synthetic ledger"],
                      "body": "PRIVATE BODY", "contact_id": "PRIVATE ID", "summaries": ["PRIVATE SUMMARY"]}],
        },
        cases={
            "status": "connected", "count": 1, "unlinked_count": 0, "total_count": 1,
            "truncated": False,
            "rows": [{"number": "case-1", "title": hostile_title, "status": "Synthetic",
                      "approval_state": "unknown", "promised_due": None, "hold_until": None,
                      "turn": "unknown", "linked_count": 1, "contact_ids": ["PRIVATE ID"]}],
        },
        worklog={
            "status": "connected", "total_count": 1, "truncated": False,
            "range_from": "2026-08-29", "range_to": "2026-09-27",
            "projects": [{"project": r"C:\synthetic\deskly", "total_seconds": 3600,
                          "by_date": [], "session_path": "PRIVATE PATH"}],
        },
        preview={"json": {"preview_only": True, "as_of_utc": "2026-09-27T00:00:00Z",
                           "waiting_count": 1, "overdue_count": 0}},
    )

    assert rendered["waiting-count"] == "1"
    assert rendered["cases-count"] == "1"
    assert rendered["case-rows"] == [f"case-1 · {hostile_title}状態: Synthetic承認: unknown予定期限: —保留期限: —番: unknown関連連絡: 1"]
    assert "IMG" not in rendered["case-rows-tags"]
    assert "PRIVATE BODY" not in json.dumps(rendered)
    assert "PRIVATE ID" not in json.dumps(rendered)
    assert "PRIVATE SUMMARY" not in json.dumps(rendered)
    assert "PRIVATE PATH" not in json.dumps(rendered)
    assert rendered["notification-summary"].startswith("プレビューのみ")


def test_synthetic_empty_and_error_rendering_are_distinct_and_safe() -> None:
    empty = _run_synthetic_ui(
        waiting={"status": "connected", "count": 0, "overdue_count": 0, "total_count": 0,
                 "truncated": False, "rows": []},
        cases={"status": "connected", "count": 0, "unlinked_count": 0, "total_count": 0,
               "truncated": False, "rows": []},
        worklog={"status": "empty", "total_count": 0, "truncated": False, "projects": []},
        preview={"json": {"preview_only": True, "as_of_utc": "2026-09-27T00:00:00Z",
                           "waiting_count": 0, "overdue_count": 0}},
    )
    assert empty["waiting-summary"] == "表示できる項目はありません"
    assert empty["cases-summary"] == "表示できる項目はありません"
    assert empty["worklog-summary"] == "表示できる項目はありません"

    error = _run_synthetic_ui(
        waiting={"status": "ledger_error", "error": "PRIVATE ERROR", "count": 0, "rows": []},
        cases={"status": "auth_error", "error": "PRIVATE TOKEN", "count": 0, "rows": []},
        worklog={"status": "execution_error", "error": "PRIVATE PATH", "projects": []},
        preview={"ok": False, "status": 503, "json": {"error": "PRIVATE ERROR"}},
    )
    assert error["waiting-summary"] == "読み込みに失敗しました"
    assert error["cases-summary"] == "読み込みに失敗しました"
    assert error["worklog-summary"] == "読み込みに失敗しました"
    assert error["notification-summary"] == "件数を読み込めませんでした"
    assert "PRIVATE" not in json.dumps(error)


def test_built_wheel_contains_static_ui_assets(tmp_path: Path) -> None:
    hatchling_build = pytest.importorskip("hatchling.build")
    wheel_name = hatchling_build.build_wheel(str(tmp_path))
    wheel_path = tmp_path / wheel_name

    with zipfile.ZipFile(wheel_path) as wheel:
        members = set(wheel.namelist())

    for name in ASSETS:
        assert f"deskly/static/{name}" in members
