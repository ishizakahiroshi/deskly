"""設定（``~/.deskly/config.toml``）と、設定・台帳の置き場。

置き場は環境変数 ``DESKLY_HOME`` で差し替えられる（テストは必ず一時フォルダへ向ける）。
台帳は ``<置き場>/ledger/<名前>.sqlite3``。台帳をクラウドの同期フォルダの中に置かない。

設定の例（値は合成）::

    [[sources]]
    path = "/path/to/repo-a/docs/local/reply"
    ledger = "company"

    [[sources]]
    path = "/path/to/repo-b/docs/local/reply"
    ledger = "personal"

    [excluded_recipients]
    csv = "/path/to/excluded.csv"
    column = "name"

- ``sources``: 取り込み元のフォルダ（絶対パス）と、そこから取り込む台帳（``company`` か ``personal``）
- ``excluded_recipients``: 取り込まない宛先の一覧の CSV と、宛先が入っている列の名前
  （家族の名前などを置く。取り込み時は必須）
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LEDGER_COMPANY = "company"
LEDGER_PERSONAL = "personal"
LEDGER_NAMES: tuple[str, ...] = (LEDGER_COMPANY, LEDGER_PERSONAL)


class ConfigError(Exception):
    """設定が無い・読めない・値が正しくない。"""


@dataclass(frozen=True)
class ImportSource:
    """取り込み元のフォルダ 1 つと、取り込み先の台帳。"""

    path: Path
    ledger: str


@dataclass(frozen=True)
class ExcludedRecipients:
    """取り込まない宛先の一覧（CSV のパスと、宛先が入っている列の名前）。"""

    csv_path: Path
    column: str


@dataclass(frozen=True)
class Config:
    sources: tuple[ImportSource, ...] = ()
    excluded_recipients: ExcludedRecipients | None = None


def deskly_home() -> Path:
    """設定と台帳の置き場。``DESKLY_HOME`` があればそれ、無ければ ``~/.deskly``。"""
    raw = os.environ.get("DESKLY_HOME", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".deskly"


def config_path() -> Path:
    return deskly_home() / "config.toml"


def ledger_path(name: str) -> Path:
    """台帳の SQLite ファイルのパス（``<置き場>/ledger/<名前>.sqlite3``）。"""
    if name not in LEDGER_NAMES:
        raise ConfigError(f"台帳の名前は {'・'.join(LEDGER_NAMES)} のどちらかです")
    return deskly_home() / "ledger" / f"{name}.sqlite3"


def _path_value(value: object, where: str) -> Path:
    # 値（実際のパス）はエラー文に出さない。どの項目かだけ示す。
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{where} は空でない文字（パス）にしてください")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute():
        raise ConfigError(f"{where} は絶対パスで書いてください")
    return path


def parse_config(data: Mapping[str, Any]) -> Config:
    """読み込んだ TOML の辞書から設定を作る。値を検査する。知らないキーは無視する。"""
    raw_sources = data.get("sources", [])
    if not isinstance(raw_sources, list):
        raise ConfigError("sources は [[sources]] の並びで書いてください")
    sources: list[ImportSource] = []
    for index, item in enumerate(raw_sources, start=1):
        where = f"sources[{index}]"
        if not isinstance(item, Mapping):
            raise ConfigError(f"{where} は表（path と ledger）で書いてください")
        path = _path_value(item.get("path"), f"{where}.path")
        ledger = item.get("ledger")
        if not isinstance(ledger, str) or ledger not in LEDGER_NAMES:
            raise ConfigError(f"{where}.ledger は {'・'.join(LEDGER_NAMES)} のどちらかです")
        sources.append(ImportSource(path=path, ledger=ledger))

    excluded: ExcludedRecipients | None = None
    raw_excluded = data.get("excluded_recipients")
    if raw_excluded is None:
        raise ConfigError("excluded_recipients は取り込まない宛先の CSV と列を指定してください")
    if not isinstance(raw_excluded, Mapping):
        raise ConfigError("excluded_recipients は表（csv と column）で書いてください")
    csv_path = _path_value(raw_excluded.get("csv"), "excluded_recipients.csv")
    column = raw_excluded.get("column")
    if not isinstance(column, str) or not column.strip():
        raise ConfigError("excluded_recipients.column は列の名前（空でない文字）にしてください")
    excluded = ExcludedRecipients(csv_path=csv_path, column=column.strip())

    return Config(sources=tuple(sources), excluded_recipients=excluded)


def load_config(path: Path | None = None) -> Config:
    """設定ファイルを読む。無い・読めないときは ``ConfigError``。"""
    target = path if path is not None else config_path()
    if not target.is_file():
        raise ConfigError(f"設定ファイルが見つかりません: {target}")
    try:
        data = tomllib.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"設定ファイルを読めません: {target}（{exc}）") from exc
    return parse_config(data)


__all__ = [
    "LEDGER_COMPANY",
    "LEDGER_NAMES",
    "LEDGER_PERSONAL",
    "Config",
    "ConfigError",
    "ExcludedRecipients",
    "ImportSource",
    "config_path",
    "deskly_home",
    "ledger_path",
    "load_config",
    "parse_config",
]
