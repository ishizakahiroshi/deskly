"""設定（``~/.deskly/config.toml``）と、設定・台帳の置き場。

置き場は環境変数 ``DESKLY_HOME`` で差し替えられる（テストは必ず一時フォルダへ向ける）。
台帳は ``<置き場>/ledger/<名前>.sqlite3``。台帳をクラウドの同期フォルダの中に置かない。

設定の例（値は合成）::

    default_ledger = "company"

    [[ledgers]]
    name = "company"
    label = "Work"
    storage = "local"
    path = "/path/to/deskly/company.sqlite3"

    [[ledgers]]
    name = "personal"
    label = "Personal"
    storage = "local"
    path = "/path/to/deskly/personal.sqlite3"

    [[sources]]
    path = "/path/to/repo-a/docs/local/reply"
    ledger = "company"

    [[sources]]
    path = "/path/to/repo-b/docs/local/reply"
    ledger = "personal"

    [excluded_recipients]
    csv = "/path/to/excluded.csv"
    column = "name"

- ``ledgers``: 台帳の名前・表示名・置き場。``local`` は絶対パスの SQLite ファイル、``server`` は API URL とトークンを読む環境変数名を持つ（server transport は C8）
- ``default_ledger``: 新しい連絡を作るときに使う台帳。追加ごとに選ぶこともできる
- ``sources``: 取り込み元のフォルダ（絶対パス）と、そこから取り込む台帳名
- ``excluded_recipients``: 取り込まない宛先の一覧の CSV と、宛先が入っている列の名前
  （家族の名前などを置く。取り込み時は必須）
"""

from __future__ import annotations

import ipaddress
import os
import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

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
class LedgerDefinition:
    """台帳の名前と置き場。server の通信処理は C8 で実装する。"""

    name: str
    label: str
    storage: str
    path: Path | None = None
    url: str | None = None
    token_env: str | None = None


@dataclass(frozen=True)
class IssuepostSettings:
    """Optional read-only issuepost endpoint and unmodified turn mappings."""

    url: str
    token_env: str
    status_turn_mapping: Mapping[str, str] = field(default_factory=dict)
    approval_turn_mapping: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class WorklogSettings:
    """Explicit many-ai-time scan roots. Missing roots never imply home defaults."""

    claude_dir: Path | None = None
    codex_dir: Path | None = None


@dataclass(frozen=True)
class Config:
    sources: tuple[ImportSource, ...] = ()
    excluded_recipients: ExcludedRecipients | None = None
    ledgers: tuple[LedgerDefinition, ...] = ()
    default_ledger: str | None = None
    issuepost: IssuepostSettings | None = None
    worklog: WorklogSettings | None = None

    def ledger(self, name: str) -> LedgerDefinition:
        """設定済みの台帳を返す。"""
        for item in self.ledgers:
            if item.name == name:
                return item
        raise ConfigError(f"設定に台帳 {name!r} がありません")

    def local_ledger_path(self, name: str) -> Path:
        """local 台帳のファイルを返し、server 置き場は明確に拒否する。"""
        item = self.ledger(name)
        if item.storage != "local" or item.path is None:
            raise ConfigError("server 置き場は C8 の API 実装後に使えます")
        return item.path


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


def _ledger_name(value: object, where: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]*", value):
        raise ConfigError(f"{where} は小文字英数字・ハイフン・下線の名前にしてください")
    return value


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def validate_issuepost_url(value: object) -> str:
    """Validate and normalize an issuepost origin at every configuration boundary."""
    if not isinstance(value, str) or not value.strip():
        raise ConfigError("issuepost.url は API の URL が必要です")
    raw = value.strip()
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in raw) or "?" in raw or "#" in raw:
        raise ConfigError("issuepost.url は query / fragment を含まない URL にしてください")
    try:
        parsed_url = urlsplit(raw)
        port = parsed_url.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("port out of range")
    except ValueError:
        raise ConfigError("issuepost.url は正しい https URL にしてください") from None

    scheme = parsed_url.scheme.casefold()
    if (
        scheme not in {"http", "https"}
        or not parsed_url.hostname
        or parsed_url.path not in {"", "/"}
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise ConfigError("issuepost.url は認証情報や path を含まない https URL にしてください")
    if scheme == "http" and not _is_loopback_host(parsed_url.hostname):
        raise ConfigError("issuepost.url の http は loopback だけにできます")
    return urlunsplit((scheme, parsed_url.netloc, "", "", ""))


def _turn_mapping(value: object, where: str) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ConfigError(f"{where} は識別子と表示値の表にしてください")
    result: dict[str, str] = {}
    for key, turn in value.items():
        if (
            not isinstance(key, str)
            or not key
            or not isinstance(turn, str)
            or not turn.strip()
        ):
            raise ConfigError(f"{where} は空でない文字の対応表にしてください")
        result[key] = turn.strip()
    return result


def _issuepost_settings(value: object) -> IssuepostSettings | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ConfigError("issuepost は url と token_env を持つ表にしてください")

    url_value = value.get("url")
    token_env = value.get("token_env")
    issuepost_url = validate_issuepost_url(url_value)
    if not isinstance(token_env, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", token_env):
        raise ConfigError("issuepost.token_env は環境変数名にしてください")

    raw_turns = value.get("turn_mapping", {})
    if not isinstance(raw_turns, Mapping):
        raise ConfigError("issuepost.turn_mapping は表にしてください")
    unknown_turn_keys = set(raw_turns) - {"status", "approval_state"}
    if unknown_turn_keys:
        raise ConfigError("issuepost.turn_mapping は status と approval_state の表にしてください")

    return IssuepostSettings(
        url=issuepost_url,
        token_env=token_env,
        status_turn_mapping=_turn_mapping(
            raw_turns.get("status"), "issuepost.turn_mapping.status"
        ),
        approval_turn_mapping=_turn_mapping(
            raw_turns.get("approval_state"), "issuepost.turn_mapping.approval_state"
        ),
    )


def _worklog_settings(value: object) -> WorklogSettings | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ConfigError("worklog は claude_dir / codex_dir を持つ表にしてください")
    unknown = set(value) - {"claude_dir", "codex_dir"}
    if unknown:
        raise ConfigError("worklog は claude_dir / codex_dir だけを指定できます")
    claude_dir = (
        _path_value(value["claude_dir"], "worklog.claude_dir")
        if "claude_dir" in value
        else None
    )
    codex_dir = (
        _path_value(value["codex_dir"], "worklog.codex_dir")
        if "codex_dir" in value
        else None
    )
    return WorklogSettings(claude_dir=claude_dir, codex_dir=codex_dir)


def parse_config(data: Mapping[str, Any], *, require_exclusions: bool = True) -> Config:
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
        ledger = _ledger_name(item.get("ledger"), f"{where}.ledger")
        sources.append(ImportSource(path=path, ledger=ledger))

    raw_ledgers = data.get("ledgers")
    definitions: list[LedgerDefinition] = []
    server_endpoints: set[tuple[str, str, int]] = set()
    if raw_ledgers is None:
        names = list(dict.fromkeys(source.ledger for source in sources)) or [LEDGER_COMPANY]
        unknown = set(names) - set(LEDGER_NAMES)
        if unknown:
            raise ConfigError(
                f"ledgers を明示しない設定では、台帳名は {'・'.join(LEDGER_NAMES)} だけです"
            )
        definitions = [
            LedgerDefinition(
                name=name,
                label=name,
                storage="local",
                path=deskly_home() / "ledger" / f"{name}.sqlite3",
            )
            for name in names
        ]
    else:
        if not isinstance(raw_ledgers, list) or not raw_ledgers:
            raise ConfigError("ledgers は 1 件以上の [[ledgers]] 表にしてください")
        for index, item in enumerate(raw_ledgers, start=1):
            where = f"ledgers[{index}]"
            if not isinstance(item, Mapping):
                raise ConfigError(f"{where} は表で書いてください")
            name = _ledger_name(item.get("name"), f"{where}.name")
            label_value = item.get("label", name)
            if not isinstance(label_value, str) or not label_value.strip():
                raise ConfigError(f"{where}.label は空でない文字にしてください")
            storage = item.get("storage")
            if storage == "local":
                path = _path_value(item.get("path"), f"{where}.path")
                if any(
                    existing.storage == "local"
                    and existing.path is not None
                    and os.path.normcase(str(existing.path.resolve()))
                    == os.path.normcase(str(path.resolve()))
                    for existing in definitions
                ):
                    raise ConfigError("複数の local 台帳で同じファイルを使えません")
                definitions.append(
                    LedgerDefinition(name, label_value.strip(), "local", path=path)
                )
            elif storage == "server":
                url_value = item.get("url")
                token_env = item.get("token_env")
                if not isinstance(url_value, str) or not url_value.strip():
                    raise ConfigError(f"{where}.url は API の URL が必要です")
                try:
                    parsed_url = urlsplit(url_value.strip())
                    port = parsed_url.port
                    if port is not None and not 1 <= port <= 65535:
                        raise ValueError("port out of range")
                except ValueError as exc:
                    raise ConfigError(f"{where}.url は正しい http(s) URL にしてください") from exc
                if (
                    parsed_url.scheme not in {"http", "https"}
                    or not parsed_url.hostname
                    or parsed_url.path not in {"", "/"}
                    or parsed_url.username is not None
                    or parsed_url.password is not None
                    or parsed_url.query
                    or parsed_url.fragment
                ):
                    raise ConfigError(f"{where}.url は認証情報を含まない http(s) URL にしてください")
                if parsed_url.scheme == "http" and parsed_url.hostname not in {
                    "localhost",
                    "127.0.0.1",
                    "::1",
                }:
                    raise ConfigError(f"{where}.url の http は loopback だけにできます")
                endpoint = (
                    parsed_url.scheme.casefold(),
                    parsed_url.hostname.casefold(),
                    port or (443 if parsed_url.scheme == "https" else 80),
                )
                if endpoint in server_endpoints:
                    raise ConfigError("複数の server 台帳で同じ API を使えません")
                server_endpoints.add(endpoint)
                if not isinstance(token_env, str) or not re.fullmatch(
                    r"[A-Z][A-Z0-9_]*", token_env
                ):
                    raise ConfigError(f"{where}.token_env は環境変数名にしてください")
                definitions.append(
                    LedgerDefinition(
                        name,
                        label_value.strip(),
                        "server",
                        url=url_value.strip().rstrip("/"),
                        token_env=token_env,
                    )
                )
            else:
                raise ConfigError(f"{where}.storage は local か server にしてください")

    names = [item.name for item in definitions]
    if len(names) != len(set(names)):
        raise ConfigError("台帳名が重複しています")
    missing_sources = {source.ledger for source in sources} - set(names)
    if missing_sources:
        raise ConfigError("取り込み元が未定義の台帳を指定しています")

    default_value = data.get("default_ledger")
    if default_value is None:
        default_ledger = LEDGER_COMPANY if LEDGER_COMPANY in names else names[0]
    else:
        default_ledger = _ledger_name(default_value, "default_ledger")
        if default_ledger not in names:
            raise ConfigError("default_ledger は定義済みの台帳にしてください")

    excluded: ExcludedRecipients | None = None
    raw_excluded = data.get("excluded_recipients")
    if raw_excluded is None:
        if require_exclusions:
            raise ConfigError("excluded_recipients は取り込まない宛先の CSV と列を指定してください")
    elif not isinstance(raw_excluded, Mapping):
        raise ConfigError("excluded_recipients は表（csv と column）で書いてください")
    else:
        csv_path = _path_value(raw_excluded.get("csv"), "excluded_recipients.csv")
        column = raw_excluded.get("column")
        if not isinstance(column, str) or not column.strip():
            raise ConfigError("excluded_recipients.column は列の名前（空でない文字）にしてください")
        excluded = ExcludedRecipients(csv_path=csv_path, column=column.strip())

    return Config(
        sources=tuple(sources),
        excluded_recipients=excluded,
        ledgers=tuple(definitions),
        default_ledger=default_ledger,
        issuepost=_issuepost_settings(data.get("issuepost")),
        worklog=_worklog_settings(data.get("worklog")),
    )


def load_config(path: Path | None = None, *, require_exclusions: bool = True) -> Config:
    """設定ファイルを読む。無い・読めないときは ``ConfigError``。"""
    target = path if path is not None else config_path()
    if not target.is_file():
        raise ConfigError(f"設定ファイルが見つかりません: {target}")
    try:
        data = tomllib.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"設定ファイルを読めません: {target}（{exc}）") from exc
    return parse_config(data, require_exclusions=require_exclusions)


def load_ledger_config(path: Path | None = None) -> Config:
    """読み書き用の台帳定義。設定ファイルが無ければ既定の company 1 冊を使う。"""
    if path is not None:
        return load_config(path, require_exclusions=False)
    target = config_path()
    if not target.is_file():
        return Config(
            ledgers=(
                LedgerDefinition(
                    name=LEDGER_COMPANY,
                    label=LEDGER_COMPANY,
                    storage="local",
                    path=ledger_path(LEDGER_COMPANY),
                ),
            ),
            default_ledger=LEDGER_COMPANY,
        )
    return load_config(target, require_exclusions=False)


__all__ = [
    "LEDGER_COMPANY",
    "LEDGER_NAMES",
    "LEDGER_PERSONAL",
    "Config",
    "ConfigError",
    "ExcludedRecipients",
    "ImportSource",
    "IssuepostSettings",
    "LedgerDefinition",
    "WorklogSettings",
    "config_path",
    "deskly_home",
    "ledger_path",
    "load_config",
    "load_ledger_config",
    "parse_config",
    "validate_issuepost_url",
]
