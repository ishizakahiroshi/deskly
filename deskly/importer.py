"""返信テキスト（``docs/local/reply/*.txt``）を台帳へ取り込む。

- 取り込み元のフォルダの直下の ``*.txt`` だけを読む（元のファイルは書き換えない・消さない）
- **git worktree（``.git`` がファイルの場所）と、パスに ``worktrees`` / ``archive`` /
  ``.claude`` / ``.many-ai-cli`` を含む場所は飛ばす**
- 形式: 最初の空行までがヘッダ（``名前: 値`` の行）、空行のあとが本文。知らない欄は ``extra`` に持つ
- 状態は値の先頭の語で読む（``（`` ``(`` ``。`` ``、`` 空白の手前まで。今の reply-status.ps1 と同じ）。
  6 つの言葉に無いものは取り込まずに一覧で返す。状態の行が無いものは推定して埋め、印を付ける
  （送信日時が入っていれば ``送信済み``、無ければ ``下書き``）
- 取り込まない宛先に当たったものは取り込まず、件数だけ返す（名前は出さない）
- 取り込み元のパスで同じ連絡を見分け、内容のハッシュが変わっていれば更新して経過を残す。
  変わっていなければ何もしない。何度流しても連絡は重ならない
- ``dry_run`` は台帳に何も書かない（台帳のファイルが無ければ作らない）
"""

from __future__ import annotations

import csv
import hashlib
import os
import re
import sqlite3
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from deskly.config import Config, ConfigError, ExcludedRecipients, ImportSource
from deskly.model import STATE_DRAFT, STATE_SENT, STATES
from deskly.remote_store import RemoteStore
from deskly.store import ConflictError, LedgerStore, SqliteStore

IMPORT_ACTOR = "import"

# パスにこの名前の部品があるフォルダは飛ばす（大文字小文字は区別しない）
SKIP_PATH_PARTS: tuple[str, ...] = ("worktrees", "archive", ".claude", ".many-ai-cli")

STATE_HEADER = "状態"
# ヘッダの名前 → 連絡の欄（状態は別扱い。13 の欄のうち残りの 12）
HEADER_FIELDS: dict[str, str] = {
    "送信日時": "sent_at",
    "宛先": "recipient",
    "経路": "channel",
    "補足": "note",
    "参照": "references",
    "共有URL": "shared_url",
    "案件": "project",
    "依頼期限": "due",
    "約束": "promise",
    "合意": "agreement",
    "機微": "sensitive",
    "根拠": "basis",
}
NO_PROJECT = "なし"

_HEADER_RE = re.compile(r"^([^\s:][^:]{0,39}?)\s*:[ \t]*(.*)$")
_STATE_CUT_RE = re.compile(r"[（(。、\s]")


@dataclass(frozen=True)
class ParsedReply:
    """返信テキスト 1 通を読んだ結果。"""

    fields: dict[str, str]  # 連絡の欄の名前 → 値（本文は ``body``）
    extra: dict[str, str]  # 知らないヘッダの欄
    state_line: str | None  # 状態の行の値。行が無ければ None


def _put_extra(extra: dict[str, str], key: str, value: str) -> None:
    name = key
    number = 2
    while name in extra:
        name = f"{key}#{number}"
        number += 1
    extra[name] = value


def parse_reply(text: str) -> ParsedReply:
    """返信テキストを、ヘッダ（最初の空行まで）と本文（空行のあと）に分けて読む。

    ヘッダの行が ``名前: 値`` の形でなければ、直前の欄の続きの行として足す（直前が無ければ
    ``extra`` に持つ）。同じ名前が 2 回あれば、最初の値を使い、あとのものは ``名前#2`` として
    ``extra`` に持つ。
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    header_lines: list[str] = []
    index = 0
    while index < len(lines) and lines[index].strip() != "":
        header_lines.append(lines[index])
        index += 1
    body = "\n".join(lines[index + 1 :]).strip("\n") if index < len(lines) else ""

    entries: list[tuple[str, str]] = []
    orphans: list[tuple[int, str]] = []
    for number, line in enumerate(header_lines, start=1):
        match = _HEADER_RE.match(line)
        if match:
            entries.append((match.group(1), match.group(2).strip()))
        elif entries:
            key, value = entries[-1]
            entries[-1] = (key, f"{value}\n{line.strip()}")
        else:
            orphans.append((number, line.strip()))

    fields: dict[str, str] = {}
    extra: dict[str, str] = {}
    state_line: str | None = None
    for key, value in entries:
        if key == STATE_HEADER:
            if state_line is None:
                state_line = value
            else:
                _put_extra(extra, key, value)
        elif key in HEADER_FIELDS:
            name = HEADER_FIELDS[key]
            if name in fields:
                _put_extra(extra, key, value)
            else:
                fields[name] = value
        else:
            _put_extra(extra, key, value)
    for number, value in orphans:
        _put_extra(extra, f"_行{number}", value)

    if fields.get("project") == NO_PROJECT:
        fields["project"] = ""
    fields["body"] = body
    return ParsedReply(fields=fields, extra=extra, state_line=state_line)


def state_word(value: str) -> str:
    """状態の値の先頭の語（``（`` ``(`` ``。`` ``、`` 空白の手前まで）。"""
    return _STATE_CUT_RE.split(value.strip(), maxsplit=1)[0]


def resolve_state(parsed: ParsedReply) -> tuple[str | None, bool, str]:
    """（状態, 推定かどうか, 読んだ語）を返す。6 つの言葉に無ければ状態は None。

    状態の行が無いときは推定する: 送信日時が入っていれば ``送信済み``、無ければ ``下書き``。
    """
    if parsed.state_line is None:
        sent = parsed.fields.get("sent_at", "").strip()
        return (STATE_SENT if sent else STATE_DRAFT), True, ""
    word = state_word(parsed.state_line)
    if word in STATES:
        return word, False, word
    return None, False, word


def _normalize(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


class Exclusions:
    """取り込まない宛先の一覧。宛先に、一覧の名前が含まれていれば当たる（空白・全角半角・大文字小文字は無視）。"""

    def __init__(self, names: Iterable[str]) -> None:
        self._names = tuple(sorted({n for n in map(_normalize, names) if n}))

    def __len__(self) -> int:
        return len(self._names)

    def matches(self, text: str) -> bool:
        target = _normalize(text)
        return bool(target) and any(name in target for name in self._names)


def load_exclusions(spec: ExcludedRecipients | None) -> Exclusions:
    """設定の CSV から取り込まない宛先を読む。CSV や列、有効な値が無ければ停止する。"""
    if spec is None:
        raise ConfigError("取り込まない宛先の CSV 設定がありません")
    try:
        with spec.csv_path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None or spec.column not in reader.fieldnames:
                raise ConfigError(
                    f"取り込まない宛先の CSV に、設定した列 {spec.column!r} がありません"
                )
            names = [str(row.get(spec.column) or "") for row in reader]
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ConfigError(
            "取り込まない宛先の CSV を読めません（設定の excluded_recipients.csv を確かめてください）"
        ) from exc
    exclusions = Exclusions(names)
    if not exclusions:
        raise ConfigError("取り込まない宛先の CSV に有効な値がありません")
    return exclusions


@dataclass(frozen=True)
class InferredState:
    file: str
    state: str


@dataclass(frozen=True)
class UnknownState:
    file: str
    state: str  # 読んだ先頭の語（空なら状態の値が空）


@dataclass(frozen=True)
class ExistingSource:
    """取り込み元照合に必要な連絡の欄だけを持つ。"""

    id: str
    source_hash: str
    updated_at: str


class ReadOnlyLedgerIndex:
    """dry-run 用の SQLite 読み取り接続。スキーマ初期化や WAL 設定を行わない。"""

    def __init__(self, path: Path) -> None:
        self._conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        self._conn.row_factory = sqlite3.Row

    def find_by_source_path(self, source_path: str) -> ExistingSource | None:
        row = self._conn.execute(
            "SELECT id, source_hash, updated_at FROM contacts "
            "WHERE source_path = ? ORDER BY created_at, id LIMIT 1",
            (source_path,),
        ).fetchone()
        if row is None:
            return None
        return ExistingSource(
            id=row["id"], source_hash=row["source_hash"], updated_at=row["updated_at"]
        )

    def close(self) -> None:
        self._conn.close()


@dataclass
class FolderReport:
    """取り込み元のフォルダ 1 つの結果。``files`` は直下の ``*.txt`` の数で、
    ``created + updated + unchanged + excluded + 語彙に無い + 読めない + 競合`` に等しい。"""

    folder: str
    ledger: str
    skipped: str = ""  # フォルダごと飛ばした理由。空なら飛ばしていない
    files: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    excluded: int = 0  # 取り込まない宛先。件数だけ（名前もファイル名も持たない）
    inferred: list[InferredState] = field(default_factory=list)
    unknown_state: list[UnknownState] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {
            "files": self.files,
            "created": self.created,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "inferred": len(self.inferred),
            "unknown_state": len(self.unknown_state),
            "excluded": self.excluded,
            "unreadable": len(self.unreadable),
            "conflicts": len(self.conflicts),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "folder": self.folder,
            "ledger": self.ledger,
            "skipped": self.skipped,
            "counts": self.counts(),
            "inferred": [asdict(item) for item in self.inferred],
            "unknown_state": [asdict(item) for item in self.unknown_state],
            "unreadable": list(self.unreadable),
            "conflicts": list(self.conflicts),
        }


@dataclass
class ImportReport:
    dry_run: bool
    exclusion_entries: int = 0  # 取り込まない宛先の一覧から読んだ件数（名前は持たない）
    folders: list[FolderReport] = field(default_factory=list)

    def totals(self) -> dict[str, int]:
        total: dict[str, int] = {}
        for folder in self.folders:
            for key, value in folder.counts().items():
                total[key] = total.get(key, 0) + value
        return total

    def to_dict(self) -> dict[str, Any]:
        return {
            "dry_run": self.dry_run,
            "exclusion_entries": self.exclusion_entries,
            "folders": [folder.to_dict() for folder in self.folders],
            "totals": self.totals(),
        }


def _is_git_worktree(folder: Path) -> bool:
    """いちばん近い ``.git`` がファイルなら git worktree。ディレクトリなら通常のリポジトリ。"""
    for parent in (folder, *folder.parents):
        git = parent / ".git"
        if git.is_file():
            return True
        if git.exists():
            return False
    return False


def folder_skip_reason(folder: Path) -> str:
    """フォルダごと飛ばす理由。飛ばさないなら空文字。"""
    for part in folder.parts:
        if part.lower() in SKIP_PATH_PARTS:
            return f"パスに {part} を含む"
    if not folder.is_dir():
        return "フォルダが無い"
    if _is_git_worktree(folder):
        return "git worktree（.git がファイル）"
    return ""


def _reply_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() == ".txt" and p.is_file())


def _import_file(
    path: Path,
    ledger: str,
    store: LedgerStore | ReadOnlyLedgerIndex | None,
    exclusions: Exclusions,
    dry_run: bool,
    report: FolderReport,
) -> None:
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        report.unreadable.append(path.name)
        return
    parsed = parse_reply(text)

    # 取り込まない宛先を最初に見る（名前もファイル名も報告に出さない）。宛先の欄が無ければファイル名で見る
    recipient = parsed.fields.get("recipient", "")
    if exclusions.matches(recipient if recipient else path.stem):
        report.excluded += 1
        return

    state, inferred, word = resolve_state(parsed)
    if state is None:
        report.unknown_state.append(UnknownState(file=path.name, state=word))
        return

    source_path = str(path)
    source_hash = hashlib.sha256(raw).hexdigest()
    data: dict[str, Any] = {name: parsed.fields.get(name, "") for name in HEADER_FIELDS.values()}
    data.update(
        body=parsed.fields["body"],
        state=state,
        state_inferred=inferred,
        source_path=source_path,
        source_hash=source_hash,
        extra=dict(parsed.extra),
    )

    existing = store.find_by_source_path(source_path) if store is not None else None
    if existing is None:
        if store is not None and not dry_run:
            if isinstance(store, ReadOnlyLedgerIndex):
                raise AssertionError("dry-run 用の読み取り接続では書き込めません")
            store.create(data, actor=IMPORT_ACTOR)
        report.created += 1
    elif existing.source_hash == source_hash:
        report.unchanged += 1
    else:
        if store is not None and not dry_run:
            if isinstance(store, ReadOnlyLedgerIndex):
                raise AssertionError("dry-run 用の読み取り接続では書き込めません")
            try:
                store.update(
                    existing.id, data, expected_updated_at=existing.updated_at, actor=IMPORT_ACTOR
                )
            except ConflictError:
                report.conflicts.append(path.name)
                return
        report.updated += 1
    if inferred:
        report.inferred.append(InferredState(file=path.name, state=state))


def import_folder(
    source: ImportSource,
    open_store: Callable[[str], LedgerStore | ReadOnlyLedgerIndex | None],
    exclusions: Exclusions,
    *,
    dry_run: bool = False,
) -> FolderReport:
    """取り込み元のフォルダ 1 つを取り込む。``open_store`` は台帳の名前から置き場を返す
    （飛ばすフォルダでは呼ばない。``None`` は「台帳がまだ無い」＝全部新規として数える）。"""
    folder = source.path.absolute()
    report = FolderReport(folder=str(folder), ledger=source.ledger)
    reason = folder_skip_reason(folder)
    if reason:
        report.skipped = reason
        return report
    store = open_store(source.ledger)
    for path in _reply_files(folder):
        report.files += 1
        _import_file(path, source.ledger, store, exclusions, dry_run, report)
    return report


def run_import(config: Config, *, dry_run: bool = False) -> ImportReport:
    """設定のすべての取り込み元を取り込む。台帳は ``<置き場>/ledger/<名前>.sqlite3``。"""
    if not config.sources:
        raise ConfigError("設定に取り込み元（[[sources]]）がありません")
    exclusions = load_exclusions(config.excluded_recipients)
    opened: dict[str, LedgerStore | ReadOnlyLedgerIndex | None] = {}

    def open_store(name: str) -> LedgerStore | ReadOnlyLedgerIndex | None:
        if name not in opened:
            definition = config.ledger(name)
            if definition.storage == "server":
                if not definition.url or not definition.token_env:
                    raise ConfigError("server 台帳の設定が正しくありません")
                token = os.environ.get(definition.token_env, "")
                if not token:
                    raise ConfigError("server 台帳の認証トークンが未設定です")
                # dry-run でも remote の既存データを読む必要があるが、_import_file は書かない。
                opened[name] = RemoteStore(definition.url, token)
            else:
                path = config.local_ledger_path(name)
                if dry_run:
                    # 読み取り接続だけを使い、既存台帳も初期化しない。無ければ作らない。
                    opened[name] = ReadOnlyLedgerIndex(path) if path.exists() else None
                else:
                    opened[name] = SqliteStore(path)
        return opened[name]

    report = ImportReport(dry_run=dry_run, exclusion_entries=len(exclusions))
    try:
        for source in config.sources:
            report.folders.append(import_folder(source, open_store, exclusions, dry_run=dry_run))
    finally:
        for store in opened.values():
            if store is not None:
                store.close()
    return report


__all__ = [
    "HEADER_FIELDS",
    "IMPORT_ACTOR",
    "SKIP_PATH_PARTS",
    "Exclusions",
    "FolderReport",
    "ImportReport",
    "InferredState",
    "ParsedReply",
    "UnknownState",
    "folder_skip_reason",
    "import_folder",
    "load_exclusions",
    "parse_reply",
    "resolve_state",
    "run_import",
    "state_word",
]
