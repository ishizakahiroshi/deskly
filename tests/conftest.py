"""pytest 共通 fixture。

テストを実際のホームの設定・台帳（``~/.deskly``）から切り離すのが目的。
``DESKLY_HOME`` を ``tmp_path`` に向けるので、テストは実際の連絡を読み書きしない。
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_deskly_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """全テストで ``DESKLY_HOME`` をテスト専用の tmp パスへ向ける。

    フォルダは作らない（未存在 = 設定も台帳も無い扱い）。スコープは function で、
    テスト間で台帳を共有しない。
    """
    home = tmp_path / "deskly-home"
    monkeypatch.setenv("DESKLY_HOME", str(home))
    return home
