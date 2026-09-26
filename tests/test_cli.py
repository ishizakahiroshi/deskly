from __future__ import annotations

import os
import tomllib
from pathlib import Path

import pytest

from deskly import __version__
from deskly.cli import main


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
