"""Tests for the loopback-only dashboard HTTP boundary."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, build_opener

import pytest

import deskly.dashboard_server as dashboard_server
from deskly.dashboard_server import (
    DASHBOARD_PASSWORD_ENV,
    SESSION_COOKIE_NAME,
    DashboardConfigurationError,
    DashboardHTTPServer,
    create_dashboard_server,
)

SYNTHETIC_PASSWORD = "synthetic-dashboard-password"


@contextmanager
def _running_dashboard(
    *,
    dashboard_provider: Callable[[], Mapping[str, Any]] | None = None,
    notification_provider: Callable[[], Mapping[str, Any]] | None = None,
    password: str = SYNTHETIC_PASSWORD,
) -> Iterator[tuple[DashboardHTTPServer, str]]:
    server = create_dashboard_server(
        port=0,
        environ={DASHBOARD_PASSWORD_ENV: password},
        dashboard_provider=dashboard_provider,
        notification_provider=notification_provider,
    )
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def _request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, Mapping[str, str], bytes]:
    request = Request(
        f"{base_url}{path}",
        data=body,
        headers=dict(headers or {}),
        method=method,
    )
    try:
        response = build_opener().open(request, timeout=3)
    except HTTPError as response:
        return response.code, response.headers, response.read()
    with response:
        return response.status, response.headers, response.read()


def _browser_post_headers(origin: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Origin": origin,
        "Sec-Fetch-Site": "same-origin",
    }


def _login(base_url: str, password: str = SYNTHETIC_PASSWORD) -> tuple[str, Mapping[str, str]]:
    status, headers, body = _request(
        base_url,
        "/login",
        method="POST",
        headers=_browser_post_headers(base_url),
        body=json.dumps({"password": password}).encode("utf-8"),
    )
    assert status == 200
    assert json.loads(body) == {"authenticated": True}
    set_cookie = headers.get("Set-Cookie", "")
    cookie_pair = set_cookie.split(";", 1)[0]
    assert cookie_pair.startswith(f"{SESSION_COOKIE_NAME}=")
    return cookie_pair, headers


def test_dashboard_cli_defaults_to_loopback_and_does_not_accept_password_argument(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deskly import cli

    calls: list[tuple[str, int]] = []
    monkeypatch.setattr(cli, "serve_dashboard", lambda *, host, port: calls.append((host, port)))

    assert cli.main(["dashboard", "serve", "--port", "0"]) == 0
    assert calls == [("127.0.0.1", 0)]
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["dashboard", "serve", "--password", SYNTHETIC_PASSWORD])


@pytest.mark.parametrize(
    "password",
    ["", "short", "synthetic\npassword-value", "synthetic\x85password-value", "p" * 1025],
)
def test_dashboard_fails_closed_for_missing_or_invalid_password(password: str) -> None:
    with pytest.raises(DashboardConfigurationError) as caught:
        create_dashboard_server(environ={DASHBOARD_PASSWORD_ENV: password})

    assert SYNTHETIC_PASSWORD not in str(caught.value)


def test_dashboard_requires_password_environment_and_exact_loopback_bind() -> None:
    with pytest.raises(DashboardConfigurationError):
        create_dashboard_server(environ={})
    with pytest.raises(DashboardConfigurationError, match="127.0.0.1"):
        create_dashboard_server(host="0.0.0.0", environ={DASHBOARD_PASSWORD_ENV: SYNTHETIC_PASSWORD})
    with pytest.raises(DashboardConfigurationError, match="127.0.0.1"):
        create_dashboard_server(host="localhost", environ={DASHBOARD_PASSWORD_ENV: SYNTHETIC_PASSWORD})


def test_login_rejects_unpaired_surrogate_without_raising() -> None:
    with _running_dashboard() as (_server, base_url):
        status, _headers, body = _request(
            base_url,
            "/login",
            method="POST",
            headers=_browser_post_headers(base_url),
            body=b'{"password":"\\ud800"}',
        )

    assert status == 400
    assert json.loads(body) == {"error": "invalid_login_request"}


def test_static_assets_are_non_sensitive_and_allowlisted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<h1>synthetic login page</h1>", encoding="utf-8")
    (static_dir / "app.js").write_text("const safe = true;", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("synthetic secret", encoding="utf-8")
    monkeypatch.setattr(dashboard_server.resources, "files", lambda _package: tmp_path)

    with _running_dashboard() as (_server, base_url):
        status, headers, body = _request(base_url, "/")
        assert status == 200
        assert body == b"<h1>synthetic login page</h1>"
        assert headers["Cache-Control"] == "no-store"
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["X-Frame-Options"] == "DENY"
        assert headers["Referrer-Policy"] == "no-referrer"
        assert "default-src 'self'" in headers["Content-Security-Policy"]
        assert "Access-Control-Allow-Origin" not in headers

        status, headers, body = _request(base_url, "/static/app.js")
        assert status == 200
        assert headers["Content-Type"].startswith("text/javascript")
        assert body == b"const safe = true;"

        status, _headers, _body = _request(base_url, "/static/secret.txt")
        assert status == 404
        status, _headers, _body = _request(base_url, "/static/%2e%2e/secret.txt")
        assert status == 404


def test_dashboard_and_notification_require_session_and_notification_is_count_only() -> None:
    provider_calls: list[str] = []
    dashboard_payload = {
        "generated_at_utc": "2026-09-27T00:00:00Z",
        "waiting": {"status": "connected", "count": 2},
        "cases": {"status": "not_connected", "count": 0},
        "worklog": {"status": "not_configured", "count": 0},
    }

    def dashboard_provider() -> Mapping[str, Any]:
        provider_calls.append("dashboard")
        return dashboard_payload

    def notification_provider() -> Mapping[str, Any]:
        provider_calls.append("notification")
        return {
            "preview_only": True,
            "as_of_utc": "2026-09-27T00:00:00Z",
            "waiting_count": 2,
            "overdue_count": 1,
            "body": "synthetic private body must not pass through",
        }

    with _running_dashboard(
        dashboard_provider=dashboard_provider,
        notification_provider=notification_provider,
    ) as (server, base_url):
        for path in ("/api/dashboard", "/api/notification-preview"):
            status, _headers, _body = _request(base_url, path)
            assert status == 401
        assert provider_calls == []

        cookie, headers = _login(base_url)
        set_cookie = headers["Set-Cookie"]
        assert "HttpOnly" in set_cookie
        assert "SameSite=Strict" in set_cookie
        assert "Path=/" in set_cookie
        assert "Max-Age=" in set_cookie
        assert "Secure" not in set_cookie  # HTTP loopback; no HTTPS listener exists.
        assert SYNTHETIC_PASSWORD not in set_cookie

        get_headers = {"Cookie": cookie, "Sec-Fetch-Site": "same-origin"}
        status, _headers, body = _request(base_url, "/api/dashboard", headers=get_headers)
        assert status == 200
        assert json.loads(body) == dashboard_payload
        assert provider_calls == ["dashboard"]

        status, _headers, body = _request(
            base_url, "/api/notification-preview", headers=get_headers
        )
        preview = json.loads(body)
        assert status == 200
        assert preview == {
            "preview_only": True,
            "as_of_utc": "2026-09-27T00:00:00Z",
            "waiting_count": 2,
            "overdue_count": 1,
        }
        assert "body" not in preview
        assert provider_calls == ["dashboard", "notification"]

        status, headers, _body = _request(
            base_url,
            "/logout",
            method="POST",
            headers={**_browser_post_headers(base_url), "Cookie": cookie},
            body=b"",
        )
        assert status == 204
        assert f"{SESSION_COOKIE_NAME}=;" in headers["Set-Cookie"]
        status, _headers, _body = _request(base_url, "/api/dashboard", headers=get_headers)
        assert status == 401

        session_id = cookie.split("=", 1)[1]
        assert session_id not in server.sessions
        status, _headers, _body = _request(
            base_url,
            "/api/dashboard",
            headers={"Cookie": f"{SESSION_COOKIE_NAME}=synthetic-invalid-session"},
        )
        assert status == 401


def test_expired_sessions_and_provider_errors_do_not_disclose_details() -> None:
    provider_calls: list[str] = []

    def dashboard_provider() -> Mapping[str, Any]:
        provider_calls.append("dashboard")
        raise RuntimeError("synthetic secret path and body")

    with _running_dashboard(dashboard_provider=dashboard_provider) as (server, base_url):
        cookie, _headers = _login(base_url)
        session_id = cookie.split("=", 1)[1]
        server.sessions[session_id] = 0

        status, _headers, body = _request(
            base_url,
            "/api/dashboard",
            headers={"Cookie": cookie},
        )
        assert status == 401
        assert provider_calls == []
        assert b"synthetic secret" not in body

        cookie, _headers = _login(base_url)
        status, _headers, body = _request(
            base_url,
            "/api/dashboard",
            headers={"Cookie": cookie},
        )
        assert status == 503
        assert json.loads(body) == {"error": "dashboard_unavailable"}
        assert b"synthetic secret" not in body
        assert provider_calls == ["dashboard"]


def test_dashboard_response_size_is_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dashboard_server, "MAX_PROVIDER_RESPONSE_BYTES", 32)
    with _running_dashboard(
        dashboard_provider=lambda: {"synthetic": "x" * 100}
    ) as (_server, base_url):
        cookie, _headers = _login(base_url)
        status, _headers, body = _request(
            base_url,
            "/api/dashboard",
            headers={"Cookie": cookie, "Sec-Fetch-Site": "same-origin"},
        )

    assert status == 503
    assert json.loads(body) == {"error": "dashboard_unavailable"}


def test_session_count_is_capped() -> None:
    with _running_dashboard() as (server, _base_url):
        oldest = server.create_session()
        for _ in range(dashboard_server.MAX_SESSIONS + 2):
            newest = server.create_session()

        assert len(server.sessions) == dashboard_server.MAX_SESSIONS
        assert server.valid_session(newest)
        assert not server.valid_session(oldest)


def test_concurrent_requests_are_capped_and_excess_request_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dashboard_server, "MAX_ACTIVE_REQUESTS", 1)
    provider_started = threading.Event()
    release_provider = threading.Event()

    def slow_provider() -> Mapping[str, Any]:
        provider_started.set()
        release_provider.wait(timeout=2)
        return {"synthetic": "ok"}

    with _running_dashboard(dashboard_provider=slow_provider) as (_server, base_url):
        cookie, _headers = _login(base_url)
        first_response: list[tuple[int, Mapping[str, str], bytes]] = []
        first_request = threading.Thread(
            target=lambda: first_response.append(
                _request(
                    base_url,
                    "/api/dashboard",
                    headers={"Cookie": cookie, "Sec-Fetch-Site": "same-origin"},
                )
            ),
            daemon=True,
        )
        first_request.start()
        assert provider_started.wait(timeout=2)

        status, _headers, body = _request(
            base_url,
            "/api/dashboard",
            headers={"Cookie": cookie, "Sec-Fetch-Site": "same-origin"},
        )
        release_provider.set()
        first_request.join(timeout=2)

    assert status == 503
    assert json.loads(body) == {"error": "dashboard_busy"}
    assert first_response and first_response[0][0] == 200


def test_notification_preview_read_failure_returns_unavailable_not_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deskly import dashboard

    def unavailable() -> dict[str, object]:
        raise dashboard.NotificationPreviewUnavailable("synthetic private ledger path")

    monkeypatch.setattr(dashboard, "get_notification_preview_payload", unavailable)
    with _running_dashboard() as (_server, base_url):
        cookie, _headers = _login(base_url)
        status, _headers, body = _request(
            base_url,
            "/api/notification-preview",
            headers={"Cookie": cookie, "Sec-Fetch-Site": "same-origin"},
        )

    assert status == 503
    assert json.loads(body) == {"error": "dashboard_unavailable"}
    assert b"synthetic private ledger path" not in body
    assert b"waiting_count" not in body
    assert b"overdue_count" not in body


def test_host_origin_and_fetch_metadata_checks_reject_browser_cross_site_requests() -> None:
    provider_calls: list[str] = []

    def dashboard_provider() -> Mapping[str, Any]:
        provider_calls.append("dashboard")
        return {"generated_at_utc": "2026-09-27T00:00:00Z"}

    with _running_dashboard(dashboard_provider=dashboard_provider) as (_server, base_url):
        status, _headers, _body = _request(
            base_url,
            "/api/dashboard",
            headers={"Host": "attacker.example"},
        )
        assert status == 400

        body = json.dumps({"password": SYNTHETIC_PASSWORD}).encode("utf-8")
        status, _headers, _body = _request(
            base_url,
            "/login",
            method="POST",
            headers={**_browser_post_headers("http://attacker.example"), "Host": base_url.split("//", 1)[1]},
            body=body,
        )
        assert status == 403

        status, _headers, _body = _request(
            base_url,
            "/login",
            method="POST",
            headers={**_browser_post_headers(base_url), "Sec-Fetch-Site": "cross-site"},
            body=body,
        )
        assert status == 403

        status, _headers, _body = _request(
            base_url,
            "/api/dashboard",
            headers={"Origin": "http://attacker.example", "Sec-Fetch-Site": "cross-site"},
        )
        assert status == 403
        assert provider_calls == []


def test_login_body_is_bounded_and_requires_json() -> None:
    with _running_dashboard() as (_server, base_url):
        origin_headers = _browser_post_headers(base_url)
        status, _headers, _body = _request(
            base_url,
            "/login",
            method="POST",
            headers={**origin_headers, "Content-Type": "text/plain"},
            body=b"{}",
        )
        assert status == 415

        status, _headers, _body = _request(
            base_url,
            "/login",
            method="POST",
            headers=origin_headers,
            body=b" " * (dashboard_server.MAX_LOGIN_BODY_BYTES + 1),
        )
        assert status == 413


def test_unsupported_methods_are_405() -> None:
    with _running_dashboard() as (_server, base_url):
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            status, headers, body = _request(
                base_url,
                "/api/dashboard",
                method=method,
            )
            assert status == 405
            assert headers["Allow"] == "GET, POST"
            assert json.loads(body) == {"error": "method_not_allowed"}
