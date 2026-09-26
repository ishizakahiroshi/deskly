"""Tests for explicit, optional worklog scan roots."""

from __future__ import annotations

from pathlib import Path

import pytest

from deskly.config import ConfigError, WorklogSettings, parse_config


def test_worklog_is_optional() -> None:
    assert parse_config({}, require_exclusions=False).worklog is None


def test_worklog_roots_are_explicit_and_preserved(tmp_path: Path) -> None:
    claude_dir = tmp_path / "synthetic-claude-root"
    codex_dir = tmp_path / "synthetic-codex-root"
    config = parse_config(
        {
            "worklog": {
                "claude_dir": str(claude_dir),
                "codex_dir": str(codex_dir),
            }
        },
        require_exclusions=False,
    )

    assert config.worklog == WorklogSettings(
        claude_dir=claude_dir,
        codex_dir=codex_dir,
    )


def test_worklog_can_enable_only_one_source(tmp_path: Path) -> None:
    codex_dir = tmp_path / "synthetic-codex-root"
    config = parse_config(
        {"worklog": {"codex_dir": str(codex_dir)}},
        require_exclusions=False,
    )

    assert config.worklog == WorklogSettings(codex_dir=codex_dir)


@pytest.mark.parametrize("value", ["not-a-table", [], 42])
def test_worklog_rejects_non_table_values(value: object) -> None:
    with pytest.raises(ConfigError, match="worklog"):
        parse_config({"worklog": value}, require_exclusions=False)


@pytest.mark.parametrize(
    "worklog",
    [
        {"claude_dir": "relative/path"},
        {"codex_dir": ""},
        {"unknown_source_dir": "/tmp/synthetic"},
    ],
)
def test_worklog_rejects_invalid_or_unknown_roots(worklog: dict[str, str]) -> None:
    with pytest.raises(ConfigError, match="worklog"):
        parse_config({"worklog": worklog}, require_exclusions=False)
