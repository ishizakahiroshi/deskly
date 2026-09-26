"""Tests for the bounded, read-only many-ai-time adapter using synthetic data."""

from __future__ import annotations

import io
import json
import os
import subprocess
from dataclasses import asdict
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import deskly.worklog as worklog_module
from deskly.config import Config, WorklogSettings
from deskly.worklog import WorklogDateBucket, WorklogProject, get_worklog_result


class _FakeProcess:
    def __init__(
        self,
        stdout: bytes,
        *,
        returncode: int = 0,
        timeouts_remaining: int = 0,
    ) -> None:
        self.stdout = io.BytesIO(stdout)
        self.returncode = returncode
        self.timeouts_remaining = timeouts_remaining
        self.killed = False
        self.wait_timeouts: list[float | None] = []

    def wait(self, timeout: float | None = None) -> int:
        self.wait_timeouts.append(timeout)
        if timeout is not None and self.timeouts_remaining:
            self.timeouts_remaining -= 1
            raise subprocess.TimeoutExpired("many-ai-time", timeout)
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def _install_fake_process(
    monkeypatch: pytest.MonkeyPatch,
    stdout: bytes,
    *,
    returncode: int = 0,
    timeouts_remaining: int = 0,
) -> tuple[list[tuple[list[str], dict[str, Any]]], _FakeProcess]:
    calls: list[tuple[list[str], dict[str, Any]]] = []
    process = _FakeProcess(
        stdout, returncode=returncode, timeouts_remaining=timeouts_remaining
    )

    def fake_popen(args: list[str], **kwargs: Any) -> _FakeProcess:
        calls.append((args, kwargs))
        return process

    monkeypatch.setattr(worklog_module.subprocess, "Popen", fake_popen)
    return calls, process


def _install_settings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    claude_dir: Path | None = None,
    codex_dir: Path | None = None,
) -> WorklogSettings:
    settings = WorklogSettings(claude_dir=claude_dir, codex_dir=codex_dir)
    monkeypatch.setattr(
        worklog_module,
        "load_ledger_config",
        lambda: Config(worklog=settings),
    )
    return settings


def _report(
    range_from: str,
    range_to: str,
    projects: list[dict[str, Any]] | None = None,
) -> bytes:
    return json.dumps(
        {
            "generated_at": "2030-01-02T03:04:05Z",
            "range": {"from": range_from, "to": range_to},
            "projects": projects or [],
        }
    ).encode("utf-8")


def _fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worklog_module, "_today_utc", lambda: date(2026, 9, 27))


def test_unconfigured_worklog_does_not_launch_a_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(worklog_module, "load_ledger_config", lambda: Config())

    def should_not_launch(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        pytest.fail("many-ai-time launched without an explicit scan root")

    monkeypatch.setattr(worklog_module.subprocess, "Popen", should_not_launch)

    result = get_worklog_result()

    assert result.status == "not_configured"
    assert result.error is None
    assert result.projects == ()


def test_child_environment_uses_only_direct_allowlisted_lookups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class LookupOnlyEnvironment:
        def get(self, key: str) -> str | None:
            return {
                "PATH": "synthetic-path",
                "SYSTEMROOT": "synthetic-system-root",
                "WINDIR": "synthetic-windir",
                "PATHEXT": ".EXE",
            }.get(key)

        def items(self) -> Any:
            pytest.fail("parent environment must not be enumerated")

    monkeypatch.setattr(
        worklog_module,
        "os",
        SimpleNamespace(environ=LookupOnlyEnvironment(), defpath=os.defpath),
    )

    assert worklog_module._minimal_child_environment() == {
        "PATH": "synthetic-path",
        "SYSTEMROOT": "synthetic-system-root",
        "WINDIR": "synthetic-windir",
        "PATHEXT": ".EXE",
    }


def test_adapter_uses_fixed_args_minimal_environment_and_aggregate_allowlist(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    claude_root = tmp_path / "synthetic-claude-root"
    codex_root = tmp_path / "synthetic-codex-root"
    claude_root.mkdir()
    codex_root.mkdir()
    _install_settings(monkeypatch, claude_dir=claude_root, codex_dir=codex_root)
    _fixed_today(monkeypatch)
    monkeypatch.setenv("DESKLY_API_TOKEN", "synthetic-api-secret")
    monkeypatch.setenv("DESKLY_DASHBOARD_PASSWORD", "synthetic-dashboard-secret")
    monkeypatch.setenv("ISSUEPOST_TEST_TOKEN", "synthetic-issuepost-secret")
    monkeypatch.setenv("PATH", "synthetic-path")
    payload = _report(
        "2026-08-29",
        "2026-09-27",
        [
            {
                "project": r"C:\private\synthetic-user\demo-project",
                "total_seconds": 42,
                "by_date": [{"date": "2026-09-27", "seconds": 42}],
                "session_path": r"C:\private\synthetic-user\session.jsonl",
                "body": "synthetic private session content",
                "token": "synthetic-private-token",
            }
        ],
    )
    calls, _ = _install_fake_process(monkeypatch, payload)

    result = get_worklog_result()

    assert result.status == "connected"
    assert result.range_from == "2026-08-29"
    assert result.range_to == "2026-09-27"
    assert result.error is None
    assert result.projects == (
        WorklogProject(
            project="demo-project",
            total_seconds=42,
            by_date=(WorklogDateBucket(date="2026-09-27", seconds=42),),
        ),
    )
    assert set(asdict(result.projects[0])) == {"project", "total_seconds", "by_date"}
    assert "synthetic private session content" not in repr(result)
    assert "synthetic-private-token" not in repr(result)
    assert r"C:\private\synthetic-user" not in repr(result)

    args, kwargs = calls[0]
    assert args == [
        "many-ai-time",
        "--format",
        "json",
        "--tz",
        "UTC",
        "--from",
        "2026-08-29",
        "--to",
        "2026-09-27",
        "--source",
        "claude,codex",
        "--claude-dir",
        str(claude_root),
        "--codex-dir",
        str(codex_root),
    ]
    assert kwargs["shell"] is False
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stderr"] is subprocess.DEVNULL
    assert kwargs["stdout"] is subprocess.PIPE
    assert kwargs["cwd"].is_absolute()
    assert kwargs["cwd"] != tmp_path / "deskly-home"
    assert kwargs["env"]["PATH"] == "synthetic-path"
    assert not {
        "DESKLY_API_TOKEN",
        "DESKLY_DASHBOARD_PASSWORD",
        "ISSUEPOST_TEST_TOKEN",
    }.intersection(kwargs["env"])


def test_only_configured_sources_are_passed_to_many_ai_time(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    codex_root = tmp_path / "synthetic-codex-root"
    codex_root.mkdir()
    _install_settings(monkeypatch, codex_dir=codex_root)
    _fixed_today(monkeypatch)
    calls, _ = _install_fake_process(monkeypatch, _report("2026-08-29", "2026-09-27"))

    result = get_worklog_result()

    assert result.status == "empty"
    args, _ = calls[0]
    assert "--source" in args
    assert args[args.index("--source") + 1] == "codex"
    assert args[args.index("--codex-dir") + 1] == str(codex_root)
    assert "--claude-dir" not in args


def test_empty_success_is_distinct_from_disconnected_and_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _fixed_today(monkeypatch)
    _install_fake_process(monkeypatch, _report("2026-08-29", "2026-09-27"))

    result = get_worklog_result()

    assert result.status == "empty"
    assert result.projects == ()
    assert result.range_from == "2026-08-29"
    assert result.range_to == "2026-09-27"
    assert result.error is None


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        (r"C:\private\synthetic-user\project-x", "project-x"),
        ("/private/synthetic-user/project-y", "project-y"),
        (None, "(unknown)"),
        ("  safe\nname\x1b[2J\u2028  ", "safename[2J"),
        ("visible\u202ehidden", "visiblehidden"),
        ("bad\ud800name", "badname"),
        ("x" * 200, "x" * worklog_module.MAX_PROJECT_LABEL_LENGTH),
    ],
)
def test_project_labels_are_sanitized_and_paths_are_reduced(
    label: str | None, expected: str
) -> None:
    projects = [
        {
            "project": label,
            "total_seconds": 0,
            "by_date": [],
        }
    ]

    result = worklog_module._parse_report(
        _report("2026-08-29", "2026-09-27", projects),
        "2026-08-29",
        "2026-09-27",
    )

    assert result[0].project == expected


def test_nonzero_child_exit_returns_fixed_redacted_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    calls, _ = _install_fake_process(monkeypatch, b"", returncode=7)

    result = get_worklog_result()

    assert result.status == "execution_error"
    assert result.error == "工数データを取得できませんでした。"
    assert calls[0][1]["stderr"] is subprocess.DEVNULL
    assert "synthetic-private" not in repr(result)


def test_timeout_returns_a_fixed_safe_state(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    calls, process = _install_fake_process(
        monkeypatch,
        b"synthetic output",
        timeouts_remaining=1,
    )

    result = get_worklog_result()

    assert process.killed
    assert result.status == "timeout"
    assert result.error == "工数集計が時間内に完了しませんでした。"
    assert "synthetic output" not in repr(result)
    assert process.wait_timeouts[0] == worklog_module.MAX_RUNTIME_SECONDS
    assert process.wait_timeouts[1] == worklog_module.PROCESS_CLEANUP_SECONDS
    assert calls[0][1]["shell"] is False


def test_timeout_cleanup_wait_has_its_own_bound(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _calls, process = _install_fake_process(
        monkeypatch,
        b"synthetic output",
        timeouts_remaining=2,
    )

    result = get_worklog_result()

    assert result.status == "timeout"
    assert process.killed
    assert process.wait_timeouts == [
        worklog_module.MAX_RUNTIME_SECONDS,
        worklog_module.PROCESS_CLEANUP_SECONDS,
    ]


def test_deeply_nested_json_fails_as_a_safe_schema_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _fixed_today(monkeypatch)
    malformed = b'{"projects":' + (b"[" * 1200) + b"0" + (b"]" * 1200) + b"}"
    _install_fake_process(monkeypatch, malformed)

    result = get_worklog_result()

    assert result.status == "schema_error"
    assert result.error == "工数集計の形式を確認できませんでした。"
    assert result.projects == ()


def test_stdout_over_limit_is_stopped_and_reported_as_schema_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    monkeypatch.setattr(worklog_module, "MAX_STDOUT_BYTES", 16)
    _, process = _install_fake_process(monkeypatch, b"x" * 200)

    result = get_worklog_result()

    assert process.killed
    assert result.status == "schema_error"
    assert result.error == "工数集計の形式を確認できませんでした。"


def test_child_start_exception_details_are_not_returned(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)

    def raise_private_error(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        raise OSError("synthetic-private-path-and-secret")

    monkeypatch.setattr(worklog_module.subprocess, "Popen", raise_private_error)

    result = get_worklog_result()

    assert result.status == "execution_error"
    assert result.error == "工数データを取得できませんでした。"
    assert "synthetic-private-path-and-secret" not in repr(result)


@pytest.mark.parametrize(
    "payload",
    [
        b"synthetic invalid JSON with private text",
        _report("2026-08-28", "2026-09-27"),
        _report(
            "2026-08-29",
            "2026-09-27",
            [{"project": "safe", "total_seconds": -1, "by_date": []}],
        ),
        _report(
            "2026-08-29",
            "2026-09-27",
            [
                {
                    "project": "safe",
                    "total_seconds": True,
                    "by_date": [],
                }
            ],
        ),
        _report(
            "2026-08-29",
            "2026-09-27",
            [
                {
                    "project": "safe",
                    "total_seconds": 1,
                    "by_date": [{"date": "2026-9-27", "seconds": 1}],
                }
            ],
        ),
        _report(
            "2026-08-29",
            "2026-09-27",
            [
                {
                    "project": "safe",
                    "total_seconds": 1,
                    "by_date": [{"date": "2026-09-27", "seconds": 0}],
                }
            ],
        ),
    ],
)
def test_invalid_json_or_schema_returns_no_partial_projection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: bytes
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _fixed_today(monkeypatch)
    _install_fake_process(monkeypatch, payload)

    result = get_worklog_result()

    assert result.status == "schema_error"
    assert result.projects == ()
    assert result.error == "工数集計の形式を確認できませんでした。"
    assert "private text" not in repr(result)


def test_project_and_date_bucket_count_limits_reject_whole_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _fixed_today(monkeypatch)
    monkeypatch.setattr(worklog_module, "MAX_PROJECTS", 0)
    payload = _report(
        "2026-08-29",
        "2026-09-27",
        [{"project": "safe", "total_seconds": 0, "by_date": []}],
    )
    _install_fake_process(monkeypatch, payload)

    result = get_worklog_result()

    assert result.status == "schema_error"
    assert result.projects == ()


def test_date_bucket_limit_rejects_whole_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    root = tmp_path / "synthetic-codex-root"
    root.mkdir()
    _install_settings(monkeypatch, codex_dir=root)
    _fixed_today(monkeypatch)
    monkeypatch.setattr(worklog_module, "MAX_DATE_BUCKETS", 0)
    payload = _report(
        "2026-08-29",
        "2026-09-27",
        [
            {
                "project": "safe",
                "total_seconds": 1,
                "by_date": [{"date": "2026-09-27", "seconds": 1}],
            }
        ],
    )
    _install_fake_process(monkeypatch, payload)

    result = get_worklog_result()

    assert result.status == "schema_error"
    assert result.projects == ()


def test_missing_explicit_root_fails_closed_before_launch(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _install_settings(monkeypatch, claude_dir=tmp_path / "missing-synthetic-root")

    def should_not_launch(*args: Any, **kwargs: Any) -> Any:
        del args, kwargs
        pytest.fail("many-ai-time launched with a missing scan root")

    monkeypatch.setattr(worklog_module.subprocess, "Popen", should_not_launch)

    result = get_worklog_result()

    assert result.status == "execution_error"
    assert result.error == "工数データを取得できませんでした。"
    assert str(tmp_path) not in repr(result)
