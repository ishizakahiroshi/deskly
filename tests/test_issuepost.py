"""Tests for optional issuepost configuration and its read-only HTTP boundary."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import OpenerDirector, ProxyHandler, Request

import pytest

import deskly.issuepost as issuepost_module
from deskly.config import ConfigError, IssuepostSettings, parse_config
from deskly.issuepost import (
    IssuepostAuthError,
    IssuepostClient,
    IssuepostNetworkError,
    IssuepostSchemaError,
)


def _settings(url: str) -> IssuepostSettings:
    return IssuepostSettings(url=url, token_env="ISSUEPOST_TEST_TOKEN")


def _parsed_settings(value: dict[str, Any]) -> IssuepostSettings | None:
    return parse_config({"issuepost": value}, require_exclusions=False).issuepost


@contextmanager
def _loopback_server(
    handler: type[BaseHTTPRequestHandler],
) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def _quiet_log(self: BaseHTTPRequestHandler, format_string: str, *args: object) -> None:
    del self, format_string, args


def _status_handler(status: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        log_message = _quiet_log

    return Handler


def _case_payload(index: int) -> dict[str, Any]:
    payload = {
        "number": f"synthetic-{index}",
        "source": "sample_app",
        "tenant_ref": "sample_tenant",
        "origin": "detected",
        "kind": "bug",
        "status": "unmapped_status_identifier",
        "approval_state": "unmapped_approval_identifier",
        "title": f"Synthetic title {index}",
        "body": "synthetic body must not be retained",
        "reporter_ref": "synthetic-reporter",
        "place": {
            "screen_id": "synthetic-screen",
            "feature_id": "synthetic-feature",
            "environment": "test",
            "version": "1.2.3",
            "url": "https://example.test/synthetic",
        },
        "fingerprint": "synthetic-fingerprint",
        "promised_due": "2026-10-02",
        "hold_until": None,
        "closed_at": None,
        "duplicate_of": None,
        "legacy_ref": "synthetic-legacy-ref",
        "created_at": "2026-09-25T12:00:00Z",
        "updated_at": "2026-09-25T12:30:00Z",
        "people": 2,
    }
    if index == 200:
        payload.pop("tenant_ref")
        payload.pop("people")
    return payload


def _json_handler(payload_for_request: Any) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            payload = payload_for_request(self)
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        log_message = _quiet_log

    return Handler


def _raw_handler(body: bytes) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        log_message = _quiet_log

    return Handler


def test_issuepost_settings_are_optional_and_keep_unknown_turn_ids() -> None:
    assert parse_config({}, require_exclusions=False).issuepost is None

    settings = _parsed_settings(
        {
            "url": "https://issues.example.test",
            "token_env": "ISSUEPOST_TOKEN",
            "turn_mapping": {
                "status": {"unseen_status_id": "対応中"},
                "approval_state": {"unseen_approval_id": "回答待ち"},
            },
        }
    )

    assert settings is not None
    assert settings.url == "https://issues.example.test"
    assert settings.status_turn_mapping == {"unseen_status_id": "対応中"}
    assert settings.approval_turn_mapping == {"unseen_approval_id": "回答待ち"}


@pytest.mark.parametrize(
    "url",
    [
        "https://issues.example.test",
        "http://127.0.0.1:8123",
        "http://[::1]:8123",
        "http://localhost:8123",
    ],
)
def test_issuepost_settings_allow_https_and_loopback_http(url: str) -> None:
    settings = _parsed_settings({"url": url, "token_env": "ISSUEPOST_TOKEN"})

    assert settings is not None
    assert settings.url == url


@pytest.mark.parametrize(
    "url",
    [
        "http://issues.example.test",
        "https://user:synthetic-pass@localhost",
        "https://issues.example.test/api",
        "https://issues.example.test?tenant=sample",
        "https://issues.example.test#fragment",
    ],
)
def test_issuepost_settings_reject_unsafe_or_ambiguous_urls(url: str) -> None:
    with pytest.raises(ConfigError):
        _parsed_settings({"url": url, "token_env": "ISSUEPOST_TOKEN"})


@pytest.mark.parametrize(
    "url",
    [
        "http://not-loopback.example.test",
        "ftp://127.0.0.1",
        "https://user:synthetic-pass@localhost",
        "https://example.test/api",
        "https://example.test?tenant=sample",
        "https://example.test#fragment",
        "https://example.test?",
        "https://example.test#",
        "https://example.test:invalid",
    ],
)
def test_client_revalidates_direct_issuepost_settings_urls(url: str) -> None:
    settings = IssuepostSettings(url=url, token_env="ISSUEPOST_TOKEN")

    with pytest.raises(ConfigError):
        IssuepostClient(settings, environ={"ISSUEPOST_TOKEN": "synthetic-token"})


def test_issuepost_settings_reject_invalid_token_env_and_mapping() -> None:
    with pytest.raises(ConfigError):
        _parsed_settings({"url": "https://issues.example.test", "token_env": "token"})

    with pytest.raises(ConfigError):
        _parsed_settings(
            {
                "url": "https://issues.example.test",
                "token_env": "ISSUEPOST_TOKEN",
                "turn_mapping": {"unknown_group": {"id": "完了"}},
            }
        )


def test_missing_token_fails_with_a_safe_auth_error() -> None:
    with pytest.raises(IssuepostAuthError) as caught:
        IssuepostClient(_settings("http://127.0.0.1:8123"), environ={})

    assert "ISSUEPOST_TEST_TOKEN" not in str(caught.value)


def test_client_uses_an_explicit_empty_proxy_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_proxy = "http://proxy.example.test:3128"
    monkeypatch.setenv("https_proxy", fake_proxy)
    monkeypatch.setenv("HTTPS_PROXY", fake_proxy)

    real_build_opener = issuepost_module.build_opener
    captured_proxy_configs: list[dict[str, str]] = []

    def recording_build_opener(*handlers: Any) -> OpenerDirector:
        captured_proxy_configs.extend(
            handler.proxies
            for handler in handlers
            if isinstance(handler, ProxyHandler)
        )
        return real_build_opener(*handlers)

    monkeypatch.setattr(issuepost_module, "build_opener", recording_build_opener)

    client = IssuepostClient(
        _settings("https://issues.example.test"),
        environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"},
    )

    assert captured_proxy_configs == [{}]
    assert not any(isinstance(handler, ProxyHandler) for handler in client._opener.handlers)


@pytest.mark.parametrize("status", [401, 403])
def test_auth_rejections_are_distinct_and_do_not_disclose_token(status: int) -> None:
    token = "synthetic-issuepost-token"
    with _loopback_server(_status_handler(status)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": token}
        )

        with pytest.raises(IssuepostAuthError) as caught:
            client.list_cases()

    assert token not in str(caught.value)


@pytest.mark.parametrize("control", ["\r", "\n", "\x00", "\x1f", "\x7f", "\t"])
def test_token_header_controls_are_rejected_before_request(
    monkeypatch: pytest.MonkeyPatch, control: str
) -> None:
    token = f"synthetic-token{control}injected"

    def reject_request(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        pytest.fail("unsafe token reached Request construction")

    monkeypatch.setattr(issuepost_module, "Request", reject_request)
    with pytest.raises(IssuepostAuthError) as caught:
        client = IssuepostClient(
            _settings("http://127.0.0.1:8123"),
            environ={"ISSUEPOST_TEST_TOKEN": token},
        )
        client.list_cases()

    assert str(caught.value) == "issuepost token is invalid"
    assert token not in str(caught.value)


@pytest.mark.parametrize("token", ["synthetic-tokén", "synthetic-token-🔐"])
def test_non_ascii_token_is_rejected_before_request(
    monkeypatch: pytest.MonkeyPatch, token: str
) -> None:
    def reject_request(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        pytest.fail("non-ASCII token reached Request construction")

    monkeypatch.setattr(issuepost_module, "Request", reject_request)
    with pytest.raises(IssuepostAuthError) as caught:
        IssuepostClient(
            _settings("http://127.0.0.1:8123"),
            environ={"ISSUEPOST_TEST_TOKEN": token},
        )

    assert str(caught.value) == "issuepost token is invalid"
    assert token not in str(caught.value)


def test_opener_network_failure_is_safe_and_distinct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "synthetic-issuepost-token"
    client = IssuepostClient(
        _settings("http://127.0.0.1:8123"),
        environ={"ISSUEPOST_TEST_TOKEN": token},
    )

    class FailingOpener:
        def open(self, request: Request, *, timeout: float) -> Any:
            assert request.get_method() == "GET"
            assert timeout == issuepost_module.REQUEST_TIMEOUT_SECONDS
            raise URLError("synthetic opener detail")

    monkeypatch.setattr(client, "_opener", FailingOpener())
    with pytest.raises(IssuepostNetworkError) as caught:
        client.list_cases()

    assert token not in str(caught.value)
    assert "synthetic opener detail" not in str(caught.value)


def test_request_is_get_with_bearer_auth_and_fixed_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "synthetic-issuepost-token"
    calls: list[tuple[Request, float]] = []
    real_build_opener = issuepost_module.build_opener

    class RecordingOpener:
        def __init__(self, delegate: OpenerDirector) -> None:
            self._delegate = delegate

        def open(self, request: Request, *, timeout: float) -> Any:
            calls.append((request, timeout))
            return self._delegate.open(request, timeout=timeout)

    monkeypatch.setattr(
        issuepost_module,
        "build_opener",
        lambda *handlers: RecordingOpener(real_build_opener(*handlers)),
    )

    with _loopback_server(_status_handler(401)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": token}
        )
        with pytest.raises(IssuepostAuthError):
            client.list_cases()

    assert len(calls) == 1
    request, timeout = calls[0]
    assert request.get_method() == "GET"
    assert request.data is None
    assert request.get_header("Authorization") == f"Bearer {token}"
    assert timeout == issuepost_module.REQUEST_TIMEOUT_SECONDS


def test_pagination_shares_a_total_runtime_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = IssuepostClient(
        _settings("https://issuepost.synthetic.invalid"),
        environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"},
    )
    clock = iter([100.0, 100.0, 129.5])
    monkeypatch.setattr(issuepost_module.time, "monotonic", lambda: next(clock))
    timeouts: list[float] = []
    pages = iter(
        [
            ({"cases": [], "next_cursor": "synthetic-next"}, 1),
            ({"cases": []}, 1),
        ]
    )

    def fake_get_page(
        cursor: str | None, *, remaining_bytes: int, timeout: float
    ) -> tuple[dict[str, Any], int]:
        del cursor, remaining_bytes
        timeouts.append(timeout)
        return next(pages)

    monkeypatch.setattr(client, "_get_page", fake_get_page)

    assert client.list_cases() == ()
    assert timeouts == [issuepost_module.REQUEST_TIMEOUT_SECONDS, 0.5]


def test_pagination_rejects_an_exhausted_total_runtime_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = IssuepostClient(
        _settings("https://issuepost.synthetic.invalid"),
        environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"},
    )
    clock = iter([100.0, 100.0, 130.01])
    monkeypatch.setattr(issuepost_module.time, "monotonic", lambda: next(clock))
    calls: list[float] = []

    def fake_get_page(
        cursor: str | None, *, remaining_bytes: int, timeout: float
    ) -> tuple[dict[str, Any], int]:
        del cursor, remaining_bytes
        calls.append(timeout)
        return {"cases": [], "next_cursor": "synthetic-next"}, 1

    monkeypatch.setattr(client, "_get_page", fake_get_page)

    with pytest.raises(issuepost_module.IssuepostNetworkError, match="time limit"):
        client.list_cases()
    assert calls == [issuepost_module.REQUEST_TIMEOUT_SECONDS]


def test_http_errors_are_reported_as_network_errors_without_token() -> None:
    token = "synthetic-issuepost-token"
    with _loopback_server(_status_handler(503)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": token}
        )

        with pytest.raises(IssuepostNetworkError) as caught:
            client.list_cases()

    assert token not in str(caught.value)


def test_redirect_is_rejected_without_contacting_its_target() -> None:
    target_hits: list[str] = []

    class TargetHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            target_hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        log_message = _quiet_log

    with _loopback_server(TargetHandler) as target_url:
        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", target_url)
                self.send_header("Content-Length", "0")
                self.end_headers()

            log_message = _quiet_log

        with _loopback_server(RedirectHandler) as source_url:
            client = IssuepostClient(
                _settings(source_url),
                environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"},
            )

            with pytest.raises(IssuepostNetworkError):
                client.list_cases()

    assert target_hits == []


def test_cases_are_projected_without_body_and_follow_cursor_pages() -> None:
    requests: list[tuple[str, dict[str, list[str]], str | None]] = []
    opaque_cursor = "9007199254740993"

    def payload_for_request(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        parsed_url = urlsplit(handler.path)
        query = parse_qs(parsed_url.query)
        requests.append(
            (parsed_url.path, query, handler.headers.get("Authorization"))
        )
        if "cursor" not in query:
            return {
                "cases": [_case_payload(index) for index in range(200)],
                "next_cursor": opaque_cursor,
            }
        return {"cases": [_case_payload(200)]}

    token = "synthetic-issuepost-token"
    with _loopback_server(_json_handler(payload_for_request)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": token}
        )
        cases = client.list_cases()

    assert len(cases) == 201
    assert cases[0].number == "synthetic-0"
    assert cases[-1].number == "synthetic-200"
    assert cases[0].status == "unmapped_status_identifier"
    assert cases[0].approval_state == "unmapped_approval_identifier"
    assert cases[0].promised_due == "2026-10-02"
    expected_fields = {
        "number",
        "title",
        "status",
        "approval_state",
        "promised_due",
        "hold_until",
    }
    assert set(asdict(cases[0])) == expected_fields
    assert set(asdict(cases[-1])) == expected_fields
    assert len(requests) == 2
    assert requests[0][0] == requests[1][0] == "/v1/cases"
    assert requests[0][1] == {"limit": ["200"]}
    assert requests[1][1] == {"limit": ["200"], "cursor": [opaque_cursor]}
    assert all(auth == f"Bearer {token}" for _, _, auth in requests)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"cases": "not-a-list"},
        {"cases": [], "next_cursor": ""},
        {"cases": [None]},
        {"cases": [{"number": "only-a-number"}]},
    ],
)
def test_invalid_case_list_shapes_raise_schema_errors(payload: dict[str, Any]) -> None:
    with _loopback_server(_json_handler(lambda _handler: payload)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        with pytest.raises(IssuepostSchemaError):
            client.list_cases()


def test_repeated_cursor_raises_a_schema_error() -> None:
    def payload_for_request(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        del handler
        return {"cases": [], "next_cursor": "1"}

    with _loopback_server(_json_handler(payload_for_request)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        with pytest.raises(IssuepostSchemaError):
            client.list_cases()


def test_pagination_allows_exactly_max_pages_when_the_last_page_is_terminal() -> None:
    request_count = 0

    def payload_for_request(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        del handler
        nonlocal request_count
        request_count += 1
        if request_count == issuepost_module.MAX_PAGES:
            return {"cases": []}
        return {"cases": [], "next_cursor": f"synthetic-cursor-{request_count}"}

    with _loopback_server(_json_handler(payload_for_request)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        assert client.list_cases() == ()

    assert request_count == issuepost_module.MAX_PAGES


def test_pagination_rejects_distinct_cursors_beyond_max_pages() -> None:
    request_count = 0

    def payload_for_request(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        del handler
        nonlocal request_count
        request_count += 1
        return {"cases": [], "next_cursor": f"synthetic-cursor-{request_count}"}

    token = "synthetic-issuepost-token"
    with _loopback_server(_json_handler(payload_for_request)) as url:
        client = IssuepostClient(_settings(url), environ={"ISSUEPOST_TEST_TOKEN": token})

        with pytest.raises(IssuepostSchemaError) as caught:
            client.list_cases()

    assert request_count == issuepost_module.MAX_PAGES
    assert token not in str(caught.value)


@pytest.mark.parametrize("limit_delta, rejected", [(0, False), (-1, True)])
def test_total_response_size_boundary_across_pages(
    monkeypatch: pytest.MonkeyPatch, limit_delta: int, rejected: bool
) -> None:
    payloads = [
        json.dumps({"cases": [], "next_cursor": "synthetic-cursor-1"}).encode("utf-8"),
        json.dumps({"cases": []}).encode("utf-8"),
    ]
    monkeypatch.setattr(
        issuepost_module,
        "MAX_TOTAL_RESPONSE_BYTES",
        len(payloads[0]) + len(payloads[1]) + limit_delta,
    )
    request_count = 0

    def payload_for_request(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        del handler
        nonlocal request_count
        request_count += 1
        return (
            {"cases": [], "next_cursor": "synthetic-cursor-1"}
            if request_count == 1
            else {"cases": []}
        )

    with _loopback_server(_json_handler(payload_for_request)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        if rejected:
            with pytest.raises(IssuepostSchemaError, match="response size limit"):
                client.list_cases()
        else:
            assert client.list_cases() == ()

    assert request_count == 2


@pytest.mark.parametrize("extra_byte, rejected", [(0, False), (1, True)])
def test_single_page_response_size_boundary(
    monkeypatch: pytest.MonkeyPatch, extra_byte: int, rejected: bool
) -> None:
    page_limit = 128
    valid_json = b'{"cases":[]}'
    payload = b" " * (page_limit - len(valid_json)) + valid_json + b" " * extra_byte
    monkeypatch.setattr(issuepost_module, "MAX_RESPONSE_BYTES", page_limit)

    with _loopback_server(_raw_handler(payload)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        if rejected:
            with pytest.raises(IssuepostSchemaError, match="response exceeded the size limit"):
                client.list_cases()
        else:
            assert client.list_cases() == ()


def test_invalid_json_is_a_safe_schema_error() -> None:
    response_body = b"synthetic private response that is not JSON"
    with _loopback_server(_raw_handler(response_body)) as url:
        client = IssuepostClient(
            _settings(url), environ={"ISSUEPOST_TEST_TOKEN": "synthetic-token"}
        )

        with pytest.raises(IssuepostSchemaError) as caught:
            client.list_cases()

    assert response_body.decode("utf-8") not in str(caught.value)
    assert caught.value.__cause__ is None
