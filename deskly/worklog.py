"""Read a bounded, aggregate-only report from an explicitly configured many-ai-time CLI."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Literal

from deskly.config import WorklogSettings, load_ledger_config

MANY_AI_TIME_EXECUTABLE = "many-ai-time"
MAX_RUNTIME_SECONDS = 15
MAX_STDOUT_BYTES = 2 * 1024 * 1024
MAX_PROJECTS = 500
MAX_DATE_BUCKETS = 15_500
MAX_PROJECT_LABEL_LENGTH = 120
PROCESS_CLEANUP_SECONDS = 0.25
STDOUT_CHUNK_BYTES = 64 * 1024

WorklogStatus = Literal[
    "not_configured",
    "connected",
    "empty",
    "execution_error",
    "timeout",
    "schema_error",
]


@dataclass(frozen=True)
class WorklogDateBucket:
    date: str
    seconds: int


@dataclass(frozen=True)
class WorklogProject:
    project: str
    total_seconds: int
    by_date: tuple[WorklogDateBucket, ...]


@dataclass(frozen=True)
class WorklogResult:
    status: WorklogStatus
    range_from: str | None = None
    range_to: str | None = None
    projects: tuple[WorklogProject, ...] = ()
    error: str | None = None


_ERROR_MESSAGES = {
    "execution_error": "工数データを取得できませんでした。",
    "timeout": "工数集計が時間内に完了しませんでした。",
    "schema_error": "工数集計の形式を確認できませんでした。",
}


def get_worklog_result() -> WorklogResult:
    """Return a safe aggregate projection; never persist or expose child details."""
    try:
        config = load_ledger_config()
    except Exception:
        return _failure("execution_error")

    settings = config.worklog
    if settings is None or (settings.claude_dir is None and settings.codex_dir is None):
        return WorklogResult(status="not_configured")

    roots = _configured_roots(settings)
    if not roots or any(not path.is_absolute() or not path.is_dir() for _, path in roots):
        return _failure("execution_error")

    range_to = _today_utc()
    range_from = range_to - timedelta(days=29)
    from_text = range_from.isoformat()
    to_text = range_to.isoformat()
    args = _build_args(settings, from_text, to_text)

    try:
        outcome, stdout = _run_child(args)
    except Exception:
        return _failure("execution_error")

    if outcome == "timeout":
        return _failure("timeout")
    if outcome == "schema_error":
        return _failure("schema_error")
    if outcome != "completed":
        return _failure("execution_error")
    try:
        projects = _parse_report(stdout, from_text, to_text)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        ValueError,
        TypeError,
    ):
        return _failure("schema_error")

    return WorklogResult(
        status="connected" if projects else "empty",
        range_from=from_text,
        range_to=to_text,
        projects=projects,
    )


def _failure(status: Literal["execution_error", "timeout", "schema_error"]) -> WorklogResult:
    return WorklogResult(status=status, error=_ERROR_MESSAGES[status])


def _today_utc() -> date:
    return datetime.now(UTC).date()


def _configured_roots(settings: WorklogSettings) -> list[tuple[str, Path]]:
    roots: list[tuple[str, Path]] = []
    if settings.claude_dir is not None:
        roots.append(("claude", settings.claude_dir))
    if settings.codex_dir is not None:
        roots.append(("codex", settings.codex_dir))
    return roots


def _build_args(settings: WorklogSettings, range_from: str, range_to: str) -> list[str]:
    roots = _configured_roots(settings)
    sources = ",".join(source for source, _ in roots)
    args = [
        MANY_AI_TIME_EXECUTABLE,
        "--format",
        "json",
        "--tz",
        "UTC",
        "--from",
        range_from,
        "--to",
        range_to,
        "--source",
        sources,
    ]
    for source, path in roots:
        args.extend((f"--{source}-dir", str(path)))
    return args


def _minimal_child_environment() -> dict[str, str]:
    env: dict[str, str] = {}
    for key in ("PATH", "SYSTEMROOT", "WINDIR", "PATHEXT"):
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    if "PATH" not in env:
        env["PATH"] = os.defpath
    return env


def _run_child(
    args: list[str],
) -> tuple[Literal["completed", "timeout", "schema_error", "error"], bytes]:
    """Run the fixed CLI with bounded captured stdout and discarded stderr."""
    output = bytearray()
    exceeded_limit = threading.Event()
    read_failed = threading.Event()
    cwd = Path(tempfile.gettempdir()).resolve()

    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            shell=False,
            cwd=cwd,
            env=_minimal_child_environment(),
        )
    except (OSError, ValueError):
        return "error", b""

    def collect_stdout() -> None:
        stream = process.stdout
        if stream is None:
            read_failed.set()
            return
        try:
            while True:
                chunk = stream.read(STDOUT_CHUNK_BYTES)
                if not chunk:
                    break
                remaining = MAX_STDOUT_BYTES + 1 - len(output)
                if remaining > 0:
                    output.extend(chunk[:remaining])
                if len(output) > MAX_STDOUT_BYTES and not exceeded_limit.is_set():
                    exceeded_limit.set()
                    try:
                        process.kill()
                    except OSError:
                        pass
        except (OSError, ValueError):
            read_failed.set()
            try:
                process.kill()
            except OSError:
                pass

    reader = threading.Thread(target=collect_stdout, name="deskly-worklog-stdout", daemon=True)
    reader.start()
    timed_out = False
    returncode: int | None = None
    try:
        returncode = process.wait(timeout=MAX_RUNTIME_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            process.kill()
        except OSError:
            pass
        try:
            returncode = process.wait(timeout=PROCESS_CLEANUP_SECONDS)
        except (subprocess.TimeoutExpired, OSError):
            returncode = None
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass
    except OSError:
        try:
            process.kill()
        except OSError:
            pass
        return "error", b""

    reader.join(timeout=PROCESS_CLEANUP_SECONDS)
    if timed_out:
        if reader.is_alive() and process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        return "timeout", b""
    if exceeded_limit.is_set():
        if reader.is_alive() and process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        return "schema_error", b""
    if reader.is_alive():
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        return "error", b""
    if read_failed.is_set():
        return "error", bytes(output)
    if returncode != 0:
        return "error", b""
    return "completed", bytes(output)


def _parse_report(stdout: bytes, range_from: str, range_to: str) -> tuple[WorklogProject, ...]:
    if len(stdout) > MAX_STDOUT_BYTES:
        raise ValueError("stdout limit")
    report = json.loads(stdout)
    if not isinstance(report, dict) or not isinstance(report.get("generated_at"), str):
        raise ValueError("invalid report")
    report_range = report.get("range")
    if not isinstance(report_range, dict):
        raise ValueError("invalid range")
    if report_range.get("from") != range_from or report_range.get("to") != range_to:
        raise ValueError("unexpected range")
    raw_projects = report.get("projects")
    if not isinstance(raw_projects, list) or len(raw_projects) > MAX_PROJECTS:
        raise ValueError("invalid projects")

    projects: list[WorklogProject] = []
    total_buckets = 0
    for raw_project in raw_projects:
        if not isinstance(raw_project, dict):
            raise ValueError("invalid project")
        raw_label = raw_project.get("project")
        if raw_label is not None and not isinstance(raw_label, str):
            raise ValueError("invalid project label")
        total_seconds = _nonnegative_integer(raw_project.get("total_seconds"))
        raw_buckets = raw_project.get("by_date")
        if not isinstance(raw_buckets, list):
            raise ValueError("invalid date buckets")
        total_buckets += len(raw_buckets)
        if total_buckets > MAX_DATE_BUCKETS:
            raise ValueError("too many date buckets")

        buckets: list[WorklogDateBucket] = []
        seen_dates: set[str] = set()
        for raw_bucket in raw_buckets:
            if not isinstance(raw_bucket, dict):
                raise ValueError("invalid date bucket")
            raw_date = raw_bucket.get("date")
            if not isinstance(raw_date, str):
                raise ValueError("invalid date")
            parsed_date = date.fromisoformat(raw_date)
            if parsed_date.isoformat() != raw_date:
                raise ValueError("noncanonical date")
            if not range_from <= raw_date <= range_to or raw_date in seen_dates:
                raise ValueError("date outside range or duplicate")
            seen_dates.add(raw_date)
            buckets.append(
                WorklogDateBucket(
                    date=raw_date,
                    seconds=_nonnegative_integer(raw_bucket.get("seconds")),
                )
            )
        if sum(bucket.seconds for bucket in buckets) != total_seconds:
            raise ValueError("inconsistent totals")
        projects.append(
            WorklogProject(
                project=_safe_project_label(raw_label),
                total_seconds=total_seconds,
                by_date=tuple(buckets),
            )
        )
    return tuple(projects)


def _nonnegative_integer(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("invalid seconds")
    return value


def _safe_project_label(value: str | None) -> str:
    if value is None:
        return "(unknown)"
    windows_path = PureWindowsPath(value)
    if windows_path.is_absolute():
        value = windows_path.name
    elif PurePosixPath(value).is_absolute():
        value = PurePosixPath(value).name
    safe = "".join(
        character
        for character in value
        if unicodedata.category(character) not in {"Cc", "Cf", "Cs", "Zl", "Zp"}
    )
    safe = safe.strip()[:MAX_PROJECT_LABEL_LENGTH]
    return safe or "(unknown)"


__all__ = [
    "WorklogDateBucket",
    "WorklogProject",
    "WorklogResult",
    "get_worklog_result",
]
