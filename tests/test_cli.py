from __future__ import annotations

import json
import os
import threading
import tomllib
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from typing import Any

import pytest

from deskly import __version__
from deskly.cli import main
from deskly.store import SqliteStore


@contextmanager
def _case_server(
    *, status: int = 200, body: bytes = b'{"cases":[]}'
) -> Iterator[tuple[str, list[tuple[str, str | None]]]]:
    requests: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append((self.command, self.headers.get("Authorization")))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format_string: str, *args: Any) -> None:
            del format_string, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def _write_case_config(home: Path, *, url: str, ledger_path: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    config = "\n".join(
        (
            'default_ledger = "company"',
            "",
            "[[ledgers]]",
            'name = "company"',
            'label = "Synthetic ledger"',
            'storage = "local"',
            f"path = {json.dumps(str(ledger_path))}",
            "",
            "[issuepost]",
            f"url = {json.dumps(url)}",
            'token_env = "ISSUEPOST_TEST_TOKEN"',
            "",
            "[issuepost.turn_mapping.status]",
            '"synthetic-open" = "対応中"',
            "",
        )
    )
    (home / "config.toml").write_text(config, encoding="utf-8")


def test_version_prints_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert capsys.readouterr().out.strip() == f"deskly {__version__}"


def test_version_matches_pyproject() -> None:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
    assert declared == __version__


def test_no_subcommand_prints_help_and_succeeds(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "usage: deskly" in out


@pytest.mark.parametrize(
    "shared_setting",
    ("DESKLY_WORKSPACE_ID", "DESKLY_CREDENTIAL_STORE", "DESKLY_PUBLIC_ORIGIN"),
)
def test_shared_runtime_rejects_local_owner_cli_before_workspace_access(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    shared_setting: str,
) -> None:
    monkeypatch.setenv(shared_setting, "")

    assert main(["workspace", "init", "--name", "Synthetic", "--owner", "Owner"]) == 1
    assert "共有 workspace の CLI/MCP 認証経路は未実装" in capsys.readouterr().err
    assert not isolate_deskly_home.exists()


@pytest.mark.parametrize("shared_file", ("shared-credentials.sqlite3", "shared-admin.lock"))
def test_shared_home_rejects_local_owner_cli_without_shared_environment(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    shared_file: str,
) -> None:
    for setting in ("DESKLY_WORKSPACE_ID", "DESKLY_CREDENTIAL_STORE", "DESKLY_PUBLIC_ORIGIN"):
        monkeypatch.delenv(setting, raising=False)
    isolate_deskly_home.mkdir()
    marker = isolate_deskly_home / shared_file
    marker.touch()

    assert main(["workspace", "init", "--name", "Synthetic", "--owner", "Owner"]) == 1
    assert "共有 workspace の CLI/MCP 認証経路は未実装" in capsys.readouterr().err
    assert marker.is_file()
    assert not (isolate_deskly_home / "workspace.json").exists()


def test_add_accepts_json_from_stdin_without_putting_body_in_arguments(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    ledger_path = tmp_path / "synthetic.sqlite3"
    _write_case_config(isolate_deskly_home, url="http://127.0.0.1:1", ledger_path=ledger_path)
    payload = {
        "project": "synthetic-project",
        "recipient": "synthetic-recipient",
        "channel": "synthetic-chat",
        "due": "2026-10-01",
        "note": "synthetic-topic",
        "body": "synthetic draft body\nsecond line",
    }
    monkeypatch.setattr("sys.stdin", StringIO(json.dumps(payload)))

    assert main(["add", "--json-input"]) == 0
    contact_id = capsys.readouterr().out.strip().split()[-2]
    with SqliteStore(ledger_path) as store:
        contact = store.get(contact_id)
        assert contact.state == "下書き"
        assert contact.project == payload["project"]
        assert contact.recipient == payload["recipient"]
        assert contact.body == payload["body"]
        assert len(store.history(contact_id)) == 1


@pytest.mark.parametrize(
    ("source", "expected_error"),
    [
        ("[]", "JSON object"),
        ('{"recipient":"synthetic-recipient","body":"body","state":"完了"}', "使用できない項目"),
        ('{"recipient":1,"body":"body"}', "値は文字列"),
        ('{"recipient":"synthetic-recipient","body":""}', "本文を空にできません"),
    ],
)
def test_add_json_input_rejects_invalid_records_before_loading_a_ledger(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    source: str,
    expected_error: str,
) -> None:
    monkeypatch.setattr("sys.stdin", StringIO(source))

    assert main(["add", "--json-input"]) == 1
    assert expected_error in capsys.readouterr().err


def test_add_json_input_rejects_mixing_json_and_field_arguments(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("sys.stdin", StringIO('{"recipient":"synthetic","body":"body"}'))

    assert main(["add", "--json-input", "--body", "also-ignored"]) == 1
    assert "同時に使えません" in capsys.readouterr().err


def test_unknown_subcommand_is_rejected(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["no-such-command"])
    assert exc.value.code == 2


def test_deskly_home_is_isolated_from_real_home(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    assert os.environ["DESKLY_HOME"] == str(isolate_deskly_home)
    assert isolate_deskly_home.parent == tmp_path
    assert isolate_deskly_home != Path.home() / ".deskly"


def test_cases_cli_reports_not_connected_without_calling_issuepost(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["cases", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload == {"status": "not_connected", "view": None, "error": None}


def test_cases_cli_distinguishes_connected_empty_and_keeps_unlinked_contacts(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    token = "synthetic-issuepost-token"
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", token)
    ledger_path = tmp_path / "company.sqlite3"
    with SqliteStore(ledger_path) as store:
        contact = store.create(
            {
                "state": "回答待ち",
                "project": "synthetic-unmatched-case",
                "body": "synthetic private body",
            }
        )
        history_before = store.history(contact.id)

    with _case_server() as (url, requests):
        _write_case_config(isolate_deskly_home, url=url, ledger_path=ledger_path)
        assert main(["cases", "--json"]) == 0

    output = capsys.readouterr().out
    payload = json.loads(output)
    assert payload["status"] == "connected"
    assert payload["view"]["cases"] == []
    assert payload["view"]["unlinked_contacts"] == [
        {
            "contact_id": contact.id,
            "project": "synthetic-unmatched-case",
            "state": "回答待ち",
            "due": "",
            "ledger_name": "company",
        }
    ]
    assert "synthetic private body" not in output
    assert requests == [("GET", f"Bearer {token}")]
    with SqliteStore(ledger_path) as store:
        assert store.history(contact.id) == history_before


def test_cases_cli_escapes_terminal_controls_but_keeps_json_values(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    token = "synthetic-issuepost-token"
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", token)
    ledger_path = tmp_path / "company.sqlite3"
    case = {
        "number": "synthetic\x7f-number",
        "title": "Synthetic\nInjected \x1b[31mTitle\x1b[0m\u0085C1\u009bCSI",
        "status": "synthetic\x1b-open",
        "approval_state": "synthetic\rapproval",
        "promised_due": None,
        "hold_until": None,
    }
    body = json.dumps({"cases": [case]}).encode("utf-8")

    with _case_server(body=body) as (url, requests):
        _write_case_config(isolate_deskly_home, url=url, ledger_path=ledger_path)
        assert main(["cases", "--json"]) == 0
        json_output = capsys.readouterr().out
        assert json.loads(json_output)["view"]["cases"][0]["title"] == case["title"]

        assert main(["cases"]) == 0
        terminal_output = capsys.readouterr().out

    assert len(terminal_output.splitlines()) == 1
    assert "Synthetic\\x0aInjected" in terminal_output
    assert "\\x1b[31mTitle\\x1b[0m" in terminal_output
    assert "synthetic\\x7f-number" in terminal_output
    assert "synthetic\\x1b-open" in terminal_output
    assert "synthetic\\x0dapproval" in terminal_output
    assert "\\x85C1\\x9bCSI" in terminal_output
    assert "\x1b" not in terminal_output
    assert "\x7f" not in terminal_output
    assert "\r" not in terminal_output
    assert "\u0085" not in terminal_output
    assert "\u009b" not in terminal_output
    assert requests == [("GET", f"Bearer {token}")] * 2


@pytest.mark.parametrize(
    ("status", "body", "expected_status"),
    [
        (401, b"", "auth_error"),
        (500, b"", "network_error"),
        (200, b"synthetic schema failure body", "schema_error"),
    ],
)
def test_cases_cli_keeps_auth_network_and_schema_errors_distinct(
    isolate_deskly_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    status: int,
    body: bytes,
    expected_status: str,
) -> None:
    token = "synthetic-issuepost-token"
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", token)
    ledger_path = tmp_path / "company.sqlite3"

    with _case_server(status=status, body=body) as (url, requests):
        _write_case_config(isolate_deskly_home, url=url, ledger_path=ledger_path)
        assert main(["cases", "--json"]) == 1

    output = capsys.readouterr().out
    payload = json.loads(output)
    assert payload["status"] == expected_status
    assert payload["view"] is None
    assert payload["error"]
    assert token not in output
    if body:
        assert body.decode("utf-8", errors="ignore") not in output
    assert requests == [("GET", f"Bearer {token}")]
