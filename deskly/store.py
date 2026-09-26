"""台帳の置き場の型（``LedgerStore``）と、SQLite の実装（``SqliteStore``）。

- 表は連絡（``contacts``）・変更の経過（``changes``）・スキーマの版（``schema_version``）
- WAL と ``busy_timeout`` で、複数の接続（複数の AI）が同時に書いても壊れにくくする
- 書き込みはすべて経過（いつ・どの欄・前の値・後の値・誰が）を残す
- 更新は ``expected_updated_at`` を受け、違えば ``ConflictError``
- 全件の書き出し（``export_rows``）と、書き出した行からの取り込み（``import_rows``）を持つ。
  台帳を別の置き場へ移すとき（C8）と控え（C5）に使う

接続はスレッドをまたいで共有しない（``sqlite3`` の既定どおり）。並行して書くときは、
スレッド・プロセスごとに ``SqliteStore`` を開く。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, fields, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, Self

from deskly.model import (
    MUTABLE_FIELDS,
    STATES,
    Contact,
    InvalidStateError,
    new_contact_id,
    normalize_field,
    validate_contact_id,
    validate_state,
)

SCHEMA_VERSION = 1
DEFAULT_BUSY_TIMEOUT_MS = 5000
DEFAULT_ACTOR = "unknown"

# 作成を経過に残すときの欄の名前。新しい値は作成時の状態。
CREATED_FIELD = "_created"


class LedgerError(Exception):
    """台帳の操作の失敗の基底。"""


class NotFoundError(LedgerError):
    """指定した ID の連絡が無い。"""


class DuplicateIdError(LedgerError):
    """同じ ID の連絡が既にある。"""


class ConflictError(LedgerError):
    """``expected_updated_at`` が台帳の ``updated_at`` と違う（読んだあとに誰かが更新した）。"""

    def __init__(self, contact_id: str, expected: str, actual: str) -> None:
        super().__init__(
            f"{contact_id} は読んだあとに更新されています"
            f"（読んだ時点: {expected}、今: {actual}）。読み直してからやり直してください"
        )
        self.contact_id = contact_id
        self.expected = expected
        self.actual = actual


@dataclass(frozen=True)
class Change:
    """変更の経過 1 行。``old_value`` / ``new_value`` は文字（bool は true/false、辞書は JSON）。"""

    contact_id: str
    changed_at: str
    field: str
    old_value: str | None
    new_value: str | None
    actor: str

    def to_dict(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}


@dataclass(frozen=True)
class ImportCounts:
    contacts: int
    changes: int


class LedgerStore(Protocol):
    """台帳の置き場。``local``（SQLite のファイル）も、別の機械の deskly（C8）も、これを満たす。"""

    def create(self, fields: Mapping[str, Any] | None = None, *, actor: str = ...) -> Contact: ...

    def get(self, contact_id: str) -> Contact: ...

    def find_by_source_path(self, source_path: str) -> Contact | None: ...

    def list_contacts(self, *, states: Collection[str] | None = None) -> list[Contact]: ...

    def update(
        self,
        contact_id: str,
        changes: Mapping[str, Any],
        *,
        expected_updated_at: str | None = None,
        actor: str = ...,
    ) -> Contact: ...

    def history(self, contact_id: str) -> list[Change]: ...

    def export_rows(self) -> list[dict[str, Any]]: ...

    def import_rows(self, rows: Iterable[Mapping[str, Any]]) -> ImportCounts: ...

    def close(self) -> None: ...

    def __enter__(self) -> Self: ...

    def __exit__(self, *_exc_info: object) -> None: ...


_CONTACT_COLUMNS: tuple[str, ...] = ("id", *MUTABLE_FIELDS, "created_at", "updated_at")
_CONTACT_FIELD_NAMES = frozenset(_CONTACT_COLUMNS)


def _quote_identifier(name: str) -> str:
    """SQLite の識別子を引用する（``references`` など予約語の欄名も扱う）。"""
    return '"' + name.replace('"', '""') + '"'


def _create_contacts_sql() -> str:
    states = ", ".join("'" + s + "'" for s in STATES)
    columns = [f"{_quote_identifier('id')} TEXT PRIMARY KEY"]
    for name in MUTABLE_FIELDS:
        if name == "state":
            quoted = _quote_identifier(name)
            columns.append(f"{quoted} TEXT NOT NULL CHECK ({quoted} IN ({states}))")
        elif name == "state_inferred":
            columns.append(f"{_quote_identifier(name)} INTEGER NOT NULL DEFAULT 0")
        elif name == "extra":
            columns.append(f"{_quote_identifier(name)} TEXT NOT NULL DEFAULT '{{}}'")
        else:
            columns.append(f"{_quote_identifier(name)} TEXT NOT NULL DEFAULT ''")
    columns += [
        f"{_quote_identifier('created_at')} TEXT NOT NULL",
        f"{_quote_identifier('updated_at')} TEXT NOT NULL",
    ]
    return "CREATE TABLE IF NOT EXISTS contacts (\n  " + ",\n  ".join(columns) + "\n)"


_SCHEMA_STATEMENTS: tuple[str, ...] = (
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
    _create_contacts_sql(),
    "CREATE INDEX IF NOT EXISTS contacts_source_path ON contacts (source_path)",
    """CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  changed_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT NOT NULL
)""",
    "CREATE INDEX IF NOT EXISTS changes_contact ON changes (contact_id, seq)",
)


def _iso(moment: datetime) -> str:
    """固定幅の UTC 表記（文字列の比較が時刻の比較になる）。"""
    return moment.astimezone(UTC).isoformat(timespec="microseconds")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _to_db(name: str, value: Any) -> Any:
    if name == "extra":
        return json.dumps(dict(value), ensure_ascii=False, sort_keys=True)
    if name == "state_inferred":
        return 1 if value else 0
    return value


def _log_value(value: Any) -> str | None:
    """経過に残す値の文字表記。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Mapping):
        return json.dumps(dict(value), ensure_ascii=False, sort_keys=True)
    return str(value)


def _row_to_contact(row: sqlite3.Row) -> Contact:
    data = {name: row[name] for name in _CONTACT_COLUMNS}
    data["state_inferred"] = bool(data["state_inferred"])
    data["extra"] = json.loads(data["extra"])
    return Contact(**data)


def _open_readonly(path: str | Path) -> sqlite3.Connection:
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError("台帳がありません")
    connection = sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _export_rows_from_connection(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    contacts = [
        _row_to_contact(row)
        for row in connection.execute("SELECT * FROM contacts ORDER BY created_at, id").fetchall()
    ]
    changes = connection.execute(
        "SELECT contact_id, changed_at, field, old_value, new_value, actor "
        "FROM changes ORDER BY seq"
    ).fetchall()
    rows: list[dict[str, Any]] = [{"type": "schema", "version": SCHEMA_VERSION}]
    rows += [{"type": "contact", **contact.to_dict()} for contact in contacts]
    rows += [{"type": "change", **_change_from_row(dict(row)).to_dict()} for row in changes]
    return rows


def list_contacts_readonly(path: str | Path) -> list[Contact]:
    """既存台帳をスキーマ初期化せず読み、無ければ空の一覧を返す。"""
    if not Path(path).is_file():
        return []
    connection = _open_readonly(path)
    try:
        rows = connection.execute("SELECT * FROM contacts ORDER BY created_at, id").fetchall()
        return [_row_to_contact(row) for row in rows]
    finally:
        connection.close()


def get_contact_readonly(path: str | Path, contact_id: str) -> Contact:
    """既存台帳の 1 件をスキーマ初期化なしで読む。"""
    valid_id = validate_contact_id(contact_id)
    connection = _open_readonly(path)
    try:
        row = connection.execute("SELECT * FROM contacts WHERE id = ?", (valid_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"連絡が見つかりません: {valid_id}")
        return _row_to_contact(row)
    finally:
        connection.close()


def export_rows_readonly(path: str | Path) -> list[dict[str, Any]]:
    """既存台帳と変更履歴を、スキーマ初期化せず同じ時点で JSON 行へ書き出す。"""
    connection = _open_readonly(path)
    connection.execute("BEGIN")
    try:
        return _export_rows_from_connection(connection)
    finally:
        connection.execute("ROLLBACK")


def _contact_from_row(row: Mapping[str, Any]) -> Contact:
    """書き出した行（``type`` 付き）から連絡を作る。欄と値を検査する。"""
    data = {k: v for k, v in row.items() if k != "type"}
    unknown = set(data) - _CONTACT_FIELD_NAMES
    if unknown:
        raise ValueError(f"知らない欄があります: {', '.join(sorted(unknown))}")
    for name in ("id", "created_at", "updated_at"):
        if not isinstance(data.get(name), str) or not data[name]:
            raise ValueError(f"連絡の行に {name} がありません")
    values = {n: normalize_field(n, v) for n, v in data.items() if n in MUTABLE_FIELDS}
    return Contact(
        id=validate_contact_id(data["id"]),
        created_at=data["created_at"],
        updated_at=data["updated_at"],
        **values,
    )


def _change_from_row(row: Mapping[str, Any]) -> Change:
    for name in ("contact_id", "changed_at", "field", "actor"):
        if not isinstance(row.get(name), str):
            raise ValueError(f"経過の行の {name} が文字ではありません")
    for name in ("old_value", "new_value"):
        value = row.get(name)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"経過の行の {name} が文字でも null でもありません")
    return Change(
        contact_id=row["contact_id"],
        changed_at=row["changed_at"],
        field=row["field"],
        old_value=row.get("old_value"),
        new_value=row.get("new_value"),
        actor=row["actor"],
    )


class SqliteStore:
    """SQLite の台帳（``local`` の置き場）。"""

    def __init__(
        self,
        path: str | Path,
        *,
        busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.path = Path(path)
        self._clock = clock
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None: 暗黙の BEGIN をやめ、トランザクションは _write_tx / _read_tx で明示する
        self._conn = sqlite3.connect(
            str(self.path), timeout=busy_timeout_ms / 1000, isolation_level=None
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.execute("PRAGMA foreign_keys = ON")
        try:
            self._init_schema()
        except BaseException:
            self._conn.close()
            raise

    # --- 接続まわり ---

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def _write_tx(self) -> Iterator[None]:
        # IMMEDIATE: 最初に書き込みの錠を取る。読んでから書く間に、ほかの接続が割り込めない。
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        self._conn.execute("COMMIT")

    @contextmanager
    def _read_tx(self) -> Iterator[None]:
        # 複数の SELECT を同じ時点の内容で読む
        self._conn.execute("BEGIN")
        try:
            yield
        finally:
            self._conn.execute("ROLLBACK")

    def _init_schema(self) -> None:
        with self._write_tx():
            for statement in _SCHEMA_STATEMENTS:
                self._conn.execute(statement)
            row = self._conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
            if row["v"] is None:
                self._conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,)
                )
            elif row["v"] != SCHEMA_VERSION:
                raise LedgerError(
                    f"台帳のスキーマの版が違います（台帳: {row['v']}、この deskly: {SCHEMA_VERSION}）"
                )

    # --- 読む ---

    def get(self, contact_id: str) -> Contact:
        row = self._conn.execute(
            "SELECT * FROM contacts WHERE id = ?", (contact_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"連絡が見つかりません: {contact_id}")
        return _row_to_contact(row)

    def find_by_source_path(self, source_path: str) -> Contact | None:
        if not source_path:
            return None
        row = self._conn.execute(
            "SELECT * FROM contacts WHERE source_path = ? ORDER BY created_at, id LIMIT 1",
            (source_path,),
        ).fetchone()
        return None if row is None else _row_to_contact(row)

    def list_contacts(self, *, states: Collection[str] | None = None) -> list[Contact]:
        sql = "SELECT * FROM contacts"
        params: tuple[str, ...] = ()
        if states is not None:
            wanted = sorted({validate_state(s) for s in states})
            if not wanted:
                return []
            sql += f" WHERE state IN ({', '.join('?' for _ in wanted)})"
            params = tuple(wanted)
        sql += " ORDER BY created_at, id"
        return [_row_to_contact(r) for r in self._conn.execute(sql, params).fetchall()]

    def history(self, contact_id: str) -> list[Change]:
        with self._read_tx():
            self.get(contact_id)  # 無い ID は NotFoundError
            return [
                _change_from_row(dict(r))
                for r in self._conn.execute(
                    "SELECT contact_id, changed_at, field, old_value, new_value, actor "
                    "FROM changes WHERE contact_id = ? ORDER BY seq",
                    (contact_id,),
                ).fetchall()
            ]

    # --- 書く ---

    def _next_stamp(self, previous: str = "") -> str:
        """今の時刻。同じ連絡の ``updated_at`` が必ず前より進むよう、前と同じか前なら 1µs 進める。"""
        now = _iso(self._clock())
        if previous and now <= previous:
            now = _iso(datetime.fromisoformat(previous) + timedelta(microseconds=1))
        return now

    def _insert_contact(self, contact: Contact) -> None:
        columns = ", ".join(_quote_identifier(name) for name in _CONTACT_COLUMNS)
        marks = ", ".join("?" for _ in _CONTACT_COLUMNS)
        values = [_to_db(name, getattr(contact, name)) for name in _CONTACT_COLUMNS]
        try:
            self._conn.execute(f"INSERT INTO contacts ({columns}) VALUES ({marks})", values)
        except sqlite3.IntegrityError as exc:
            if "contacts.id" in str(exc) or "UNIQUE" in str(exc):
                raise DuplicateIdError(f"同じ ID の連絡が既にあります: {contact.id}") from exc
            raise

    def _insert_change(self, change: Change) -> None:
        self._conn.execute(
            "INSERT INTO changes (contact_id, changed_at, field, old_value, new_value, actor) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                change.contact_id,
                change.changed_at,
                change.field,
                change.old_value,
                change.new_value,
                change.actor,
            ),
        )

    def create(self, fields: Mapping[str, Any] | None = None, *, actor: str = DEFAULT_ACTOR) -> Contact:
        """連絡を作る。``id`` を渡さなければ採番する。状態を渡さなければ ``下書き``。

        経過に 1 行（``_created``・新しい値は最初の状態）を残す。
        """
        data = dict(fields or {})
        given_id = data.pop("id", None)
        for reserved in ("created_at", "updated_at"):
            if reserved in data:
                raise ValueError(f"{reserved} は台帳が決めます")
        values = {name: normalize_field(name, value) for name, value in data.items()}
        now = self._next_stamp()
        contact_id = (
            validate_contact_id(given_id)
            if given_id is not None
            else new_contact_id(self._clock().astimezone().date())
        )
        contact = Contact(id=contact_id, created_at=now, updated_at=now, **values)
        with self._write_tx():
            self._insert_contact(contact)
            self._insert_change(Change(contact.id, now, CREATED_FIELD, None, contact.state, actor))
        return contact

    def update(
        self,
        contact_id: str,
        changes: Mapping[str, Any],
        *,
        expected_updated_at: str | None = None,
        actor: str = DEFAULT_ACTOR,
    ) -> Contact:
        """欄を更新し、変わった欄ごとに経過を 1 行ずつ残す。

        ``expected_updated_at`` を渡すと、台帳の ``updated_at`` と違うとき ``ConflictError``。
        変わる欄が無ければ何も書かない（``updated_at`` も進めない）。状態を変えたのに
        ``state_inferred`` を渡さなかったときは、推定の印を外す（人が決めた状態になるため）。
        """
        new_values = {name: normalize_field(name, value) for name, value in changes.items()}
        with self._write_tx():
            current = self.get(contact_id)
            if expected_updated_at is not None and expected_updated_at != current.updated_at:
                raise ConflictError(contact_id, expected_updated_at, current.updated_at)
            if (
                "state" in new_values
                and "state_inferred" not in new_values
                and new_values["state"] != current.state
            ):
                new_values["state_inferred"] = False
            diffs = {
                name: value
                for name, value in new_values.items()
                if getattr(current, name) != value
            }
            if not diffs:
                return current
            stamp = self._next_stamp(current.updated_at)
            assignments = ", ".join(
                f"{_quote_identifier(name)} = ?" for name in (*diffs, "updated_at")
            )
            params = [_to_db(name, value) for name, value in diffs.items()]
            self._conn.execute(
                f"UPDATE contacts SET {assignments} WHERE id = ?", (*params, stamp, contact_id)
            )
            for name, value in diffs.items():
                self._insert_change(
                    Change(
                        contact_id,
                        stamp,
                        name,
                        _log_value(getattr(current, name)),
                        _log_value(value),
                        actor,
                    )
                )
            return replace(current, updated_at=stamp, **diffs)

    # --- 書き出しと取り込み ---

    def export_rows(self) -> list[dict[str, Any]]:
        """全件を JSON にできる行の並びで返す（先頭が ``schema``、次に全連絡、次に全経過）。"""
        with self._read_tx():
            return _export_rows_from_connection(self._conn)

    def import_rows(self, rows: Iterable[Mapping[str, Any]]) -> ImportCounts:
        """``export_rows`` の行を取り込む。ID・欄・作成日時・更新日時・経過をそのまま写す。

        1 つのトランザクションで行う。1 行でも不正か、同じ ID の連絡が既にあれば、
        何も取り込まない。
        """
        contacts: list[Contact] = []
        changes: list[Change] = []
        for row in rows:
            kind = row.get("type")
            if kind == "schema":
                if row.get("version") != SCHEMA_VERSION:
                    raise LedgerError(
                        f"書き出しのスキーマの版が違います"
                        f"（行: {row.get('version')!r}、この deskly: {SCHEMA_VERSION}）"
                    )
            elif kind == "contact":
                contacts.append(_contact_from_row(row))
            elif kind == "change":
                changes.append(_change_from_row(row))
            else:
                raise ValueError(f"知らない行の種類です: {kind!r}")
        with self._write_tx():
            for contact in contacts:
                self._insert_contact(contact)
            for change in changes:
                try:
                    self._insert_change(change)
                except sqlite3.IntegrityError as exc:
                    raise LedgerError(
                        f"経過の行の連絡が見つかりません: {change.contact_id}"
                    ) from exc
        return ImportCounts(contacts=len(contacts), changes=len(changes))


__all__ = [
    "CREATED_FIELD",
    "DEFAULT_ACTOR",
    "Change",
    "ConflictError",
    "DuplicateIdError",
    "ImportCounts",
    "InvalidStateError",
    "LedgerError",
    "LedgerStore",
    "NotFoundError",
    "SqliteStore",
    "export_rows_readonly",
    "get_contact_readonly",
    "list_contacts_readonly",
]
