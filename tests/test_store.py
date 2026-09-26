from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from deskly.model import (
    STATE_DRAFT,
    STATE_IN_PROGRESS,
    STATE_WAITING,
    STATES,
    Contact,
    InvalidStateError,
    new_contact_id,
)
from deskly.store import (
    CREATED_FIELD,
    ConflictError,
    DuplicateIdError,
    LedgerError,
    LedgerStore,
    NotFoundError,
    SqliteStore,
)

ID_RE = re.compile(r"c-\d{8}-[0-9a-f]{8}")


class FakeClock:
    """毎回同じ時刻を返す（``updated_at`` を進める処理を試すため）。"""

    def __init__(self) -> None:
        self.now = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs: float) -> None:
        self.now += timedelta(**kwargs)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def store(tmp_path: Path, clock: FakeClock) -> Iterator[SqliteStore]:
    with SqliteStore(tmp_path / "ledger" / "sample.sqlite3", clock=clock) as s:
        yield s


def _sample_fields(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "project": "案件A",
        "recipient": "相手先X",
        "channel": "チャット",
        "sent_at": "2026-01-01 10:00",
        "due": "2026-01-10",
        "promise": "来週までに返す",
        "agreement": "合意済み",
        "sensitive": "なし",
        "basis": "見積書",
        "note": "補足の文",
        "references": "https://example.invalid/ref",
        "shared_url": "https://example.invalid/share",
        "body": "本文の 1 行目\n2 行目",
        "source_path": "/synthetic/reply/a.txt",
        "source_hash": "0123abcd",
        "extra": {"未知の欄": "値", "もう 1 つ": "値2"},
    }
    base.update(overrides)
    return base


# --- 作る・読む・状態を変える ---


def test_create_assigns_id_default_state_and_one_history_row(store: SqliteStore) -> None:
    contact = store.create()
    assert ID_RE.fullmatch(contact.id)
    assert contact.state == STATE_DRAFT
    assert contact.state_inferred is False
    assert contact.created_at == contact.updated_at
    rows = store.history(contact.id)
    assert len(rows) == 1
    assert (rows[0].field, rows[0].old_value, rows[0].new_value) == (
        CREATED_FIELD,
        None,
        STATE_DRAFT,
    )


def test_create_and_get_keep_every_field(store: SqliteStore) -> None:
    created = store.create(_sample_fields(state=STATE_WAITING, state_inferred=True), actor="tester")
    loaded = store.get(created.id)
    assert loaded == created
    assert loaded.project == "案件A"
    assert loaded.body == "本文の 1 行目\n2 行目"
    assert loaded.state == STATE_WAITING
    assert loaded.state_inferred is True
    assert dict(loaded.extra) == {"未知の欄": "値", "もう 1 つ": "値2"}
    assert store.history(created.id)[0].actor == "tester"


def test_create_with_given_id_and_duplicate_id(store: SqliteStore) -> None:
    contact_id = new_contact_id()
    store.create({"id": contact_id})
    assert store.get(contact_id).id == contact_id
    with pytest.raises(DuplicateIdError):
        store.create({"id": contact_id})
    assert len(store.history(contact_id)) == 1  # 失敗した作成は経過を残さない


@pytest.mark.parametrize("bad", ["", "c-2026-abc", "x-20260101-0123abcd", "c-20260101-0123ABCD"])
def test_create_rejects_malformed_id(store: SqliteStore, bad: str) -> None:
    with pytest.raises(ValueError):
        store.create({"id": bad})


def test_create_rejects_reserved_and_unknown_fields(store: SqliteStore) -> None:
    with pytest.raises(ValueError):
        store.create({"created_at": "2026-01-01T00:00:00.000000+00:00"})
    with pytest.raises(ValueError):
        store.create({"no_such_field": "x"})
    assert store.list_contacts() == []


def test_get_missing_raises_not_found(store: SqliteStore) -> None:
    with pytest.raises(NotFoundError):
        store.get("c-20260101-00000000")
    with pytest.raises(NotFoundError):
        store.history("c-20260101-00000000")
    with pytest.raises(NotFoundError):
        store.update("c-20260101-00000000", {"note": "x"})


def test_state_changes_leave_one_history_row_each(store: SqliteStore, clock: FakeClock) -> None:
    contact = store.create({"project": "案件A"}, actor="a")
    clock.advance(seconds=1)
    waiting = store.update(contact.id, {"state": STATE_WAITING}, actor="b")
    clock.advance(seconds=1)
    working = store.update(contact.id, {"state": STATE_IN_PROGRESS}, actor="c")

    assert working.state == STATE_IN_PROGRESS
    assert working.updated_at > waiting.updated_at > contact.updated_at
    assert working.created_at == contact.created_at
    rows = store.history(contact.id)
    assert [(r.field, r.old_value, r.new_value, r.actor) for r in rows] == [
        (CREATED_FIELD, None, STATE_DRAFT, "a"),
        ("state", STATE_DRAFT, STATE_WAITING, "b"),
        ("state", STATE_WAITING, STATE_IN_PROGRESS, "c"),
    ]
    assert [r.changed_at for r in rows] == [
        contact.updated_at,
        waiting.updated_at,
        working.updated_at,
    ]


def test_update_logs_one_row_per_changed_field_only(store: SqliteStore) -> None:
    contact = store.create({"note": "前", "project": "案件A"})
    updated = store.update(
        contact.id,
        {"note": "後", "project": "案件A", "extra": {"k": "v"}, "state_inferred": True},
    )
    rows = store.history(contact.id)[1:]  # 作成の行を除く
    assert {(r.field, r.old_value, r.new_value) for r in rows} == {
        ("note", "前", "後"),
        ("extra", "{}", '{"k": "v"}'),
        ("state_inferred", "false", "true"),
    }
    assert {r.changed_at for r in rows} == {updated.updated_at}  # 同じ更新は同じ時刻


def test_reserved_keyword_field_can_be_updated(store: SqliteStore) -> None:
    contact = store.create({"references": "https://example.invalid/old"})

    updated = store.update(
        contact.id,
        {"references": "https://example.invalid/new"},
        expected_updated_at=contact.updated_at,
    )

    assert updated.references == "https://example.invalid/new"
    assert store.history(contact.id)[-1].field == "references"


def test_update_without_effective_change_writes_nothing(
    store: SqliteStore, clock: FakeClock
) -> None:
    contact = store.create({"note": "同じ"})
    clock.advance(seconds=5)
    same = store.update(contact.id, {"note": "同じ"})
    assert same == contact
    assert store.get(contact.id).updated_at == contact.updated_at
    assert len(store.history(contact.id)) == 1


def test_updated_at_advances_even_when_clock_does_not(store: SqliteStore) -> None:
    contact = store.create()
    first = store.update(contact.id, {"note": "1"})
    second = store.update(contact.id, {"note": "2"})  # 時計は止まったまま
    assert contact.updated_at < first.updated_at < second.updated_at


def test_changing_state_clears_inferred_mark_unless_told_otherwise(store: SqliteStore) -> None:
    contact = store.create({"state": STATE_DRAFT, "state_inferred": True})
    same_state = store.update(contact.id, {"state": STATE_DRAFT})
    assert same_state.state_inferred is True  # 状態が変わらなければ印は残る
    moved = store.update(contact.id, {"state": STATE_WAITING})
    assert moved.state_inferred is False
    assert store.get(contact.id).state_inferred is False
    kept = store.update(contact.id, {"state": STATE_IN_PROGRESS, "state_inferred": True})
    assert kept.state_inferred is True


def test_immutable_fields_cannot_be_updated(store: SqliteStore) -> None:
    contact = store.create()
    for name in ("id", "created_at", "updated_at"):
        with pytest.raises(ValueError):
            store.update(contact.id, {name: "x"})


def test_field_types_are_checked(store: SqliteStore) -> None:
    contact = store.create()
    with pytest.raises(TypeError):
        store.update(contact.id, {"note": 1})
    with pytest.raises(TypeError):
        store.update(contact.id, {"state_inferred": "yes"})
    with pytest.raises(TypeError):
        store.update(contact.id, {"extra": {"k": 1}})
    assert store.history(contact.id) and len(store.history(contact.id)) == 1


# --- 状態の言葉 ---


def test_states_are_exactly_the_six_words() -> None:
    assert set(STATES) == {"下書き", "送信済み", "回答待ち", "対応中", "完了", "送らない"}
    assert len(STATES) == 6


@pytest.mark.parametrize("word", STATES)
def test_all_six_states_are_accepted(store: SqliteStore, word: str) -> None:
    assert store.create({"state": word}).state == word


@pytest.mark.parametrize("bad", ["", "保留", "回答待ち（相手）", "draft", " 下書き"])
def test_other_states_are_rejected(store: SqliteStore, bad: str) -> None:
    with pytest.raises(InvalidStateError):
        store.create({"state": bad})
    contact = store.create()
    with pytest.raises(InvalidStateError):
        store.update(contact.id, {"state": bad})
    with pytest.raises(InvalidStateError):
        store.list_contacts(states=[bad])
    assert store.get(contact.id).state == STATE_DRAFT
    assert len(store.history(contact.id)) == 1
    assert len(store.list_contacts()) == 1  # 拒否した作成は何も残さない


def test_database_itself_rejects_other_states(store: SqliteStore) -> None:
    contact = store.create()
    raw = sqlite3.connect(str(store.path))
    try:
        with pytest.raises(sqlite3.IntegrityError):
            raw.execute("UPDATE contacts SET state = '保留' WHERE id = ?", (contact.id,))
    finally:
        raw.close()


def test_import_rejects_other_states(store: SqliteStore, tmp_path: Path) -> None:
    store.create({"state": STATE_WAITING})
    rows = store.export_rows()
    rows[1]["state"] = "保留"
    with SqliteStore(tmp_path / "other.sqlite3") as target:
        with pytest.raises(InvalidStateError):
            target.import_rows(rows)
        assert target.list_contacts() == []


# --- 一覧・取り込み元のパス ---


def test_list_contacts_filters_by_state_and_orders_by_creation(
    store: SqliteStore, clock: FakeClock
) -> None:
    first = store.create({"state": STATE_WAITING})
    clock.advance(seconds=1)
    second = store.create({"state": STATE_DRAFT})
    clock.advance(seconds=1)
    third = store.create({"state": STATE_WAITING})
    assert [c.id for c in store.list_contacts()] == [first.id, second.id, third.id]
    assert [c.id for c in store.list_contacts(states=[STATE_WAITING])] == [first.id, third.id]
    assert store.list_contacts(states=[]) == []


def test_find_by_source_path(store: SqliteStore) -> None:
    contact = store.create({"source_path": "/synthetic/reply/a.txt"})
    store.create({"source_path": "/synthetic/reply/b.txt"})
    store.create()  # 取り込み元の無い連絡
    found = store.find_by_source_path("/synthetic/reply/a.txt")
    assert found is not None and found.id == contact.id
    assert store.find_by_source_path("/synthetic/reply/none.txt") is None
    assert store.find_by_source_path("") is None


# --- 楽観的な排他 ---


def test_stale_expected_updated_at_raises_conflict_and_changes_nothing(
    store: SqliteStore, clock: FakeClock
) -> None:
    contact = store.create({"note": "最初"})
    clock.advance(seconds=1)
    theirs = store.update(contact.id, {"note": "他の人"}, expected_updated_at=contact.updated_at)

    with pytest.raises(ConflictError) as exc:
        store.update(contact.id, {"note": "自分"}, expected_updated_at=contact.updated_at)
    assert exc.value.contact_id == contact.id
    assert exc.value.expected == contact.updated_at
    assert exc.value.actual == theirs.updated_at
    assert store.get(contact.id).note == "他の人"
    assert len(store.history(contact.id)) == 2  # 作成 + 他の人の 1 行だけ

    mine = store.update(contact.id, {"note": "自分"}, expected_updated_at=theirs.updated_at)
    assert mine.note == "自分"


def test_conflict_is_checked_even_when_nothing_would_change(store: SqliteStore) -> None:
    contact = store.create({"note": "x"})
    with pytest.raises(ConflictError):
        store.update(contact.id, {"note": "x"}, expected_updated_at="2000-01-01T00:00:00.000000+00:00")


# --- 同時に書く ---


def _run_threads(workers: list[threading.Thread]) -> None:
    for w in workers:
        w.start()
    for w in workers:
        w.join(timeout=60)
        assert not w.is_alive()


def test_concurrent_writers_keep_the_ledger_intact(tmp_path: Path) -> None:
    path = tmp_path / "shared.sqlite3"
    with SqliteStore(path) as seed:
        shared = seed.create({"note": "0"})

    per_thread = 25
    thread_count = 4
    errors: list[BaseException] = []
    barrier = threading.Barrier(thread_count)

    def worker(index: int) -> None:
        try:
            with SqliteStore(path) as mine:  # 接続はスレッドごと
                barrier.wait(timeout=30)
                for n in range(per_thread):
                    mine.create({"note": f"t{index}-{n}"}, actor=f"t{index}")
                    mine.update(shared.id, {"note": f"t{index}-{n}"}, actor=f"t{index}")
        except BaseException as exc:  # スレッドの失敗を集めて、主スレッドで確かめる
            errors.append(exc)

    _run_threads([threading.Thread(target=worker, args=(i,)) for i in range(thread_count)])
    assert errors == []

    with SqliteStore(path) as check:
        contacts = check.list_contacts()
        assert len(contacts) == 1 + per_thread * thread_count
        assert len({c.id for c in contacts}) == len(contacts)
        # 共有の連絡への更新は 1 回ごとに 1 行の経過が残り、取りこぼしが無い
        rows = check.history(shared.id)
        assert len(rows) == 1 + per_thread * thread_count
        assert check._conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_only_one_of_racing_updates_with_the_same_expected_value_wins(tmp_path: Path) -> None:
    path = tmp_path / "race.sqlite3"
    with SqliteStore(path) as seed:
        contact = seed.create({"note": "start"})

    racers = 4
    barrier = threading.Barrier(racers)
    outcomes: list[str] = []
    lock = threading.Lock()

    def racer(index: int) -> None:
        with SqliteStore(path) as mine:
            barrier.wait(timeout=30)
            try:
                mine.update(
                    contact.id,
                    {"note": f"racer-{index}"},
                    expected_updated_at=contact.updated_at,
                    actor=f"racer-{index}",
                )
                result = "won"
            except ConflictError:
                result = "conflict"
            with lock:
                outcomes.append(result)

    _run_threads([threading.Thread(target=racer, args=(i,)) for i in range(racers)])
    assert sorted(outcomes) == ["conflict"] * (racers - 1) + ["won"]

    with SqliteStore(path) as check:
        rows = check.history(contact.id)
        assert len(rows) == 2  # 作成 + 勝った 1 回だけ
        assert check.get(contact.id).note == rows[1].new_value


def test_wal_and_busy_timeout_are_set(tmp_path: Path) -> None:
    with SqliteStore(tmp_path / "wal.sqlite3", busy_timeout_ms=1234) as s:
        assert s._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert s._conn.execute("PRAGMA busy_timeout").fetchone()[0] == 1234


# --- 書き出しと取り込み ---


def _snapshot(s: LedgerStore) -> list[tuple[Contact, list[tuple[str, str, str | None, str | None, str]]]]:
    return [
        (
            c,
            [(h.changed_at, h.field, h.old_value, h.new_value, h.actor) for h in s.history(c.id)],
        )
        for c in s.list_contacts()
    ]


def test_export_then_import_reproduces_ids_fields_and_history(
    store: SqliteStore, clock: FakeClock, tmp_path: Path
) -> None:
    a = store.create(_sample_fields(), actor="a")
    b = store.create({"project": "案件B", "state": STATE_WAITING}, actor="b")
    clock.advance(seconds=1)
    store.update(a.id, {"state": STATE_WAITING, "note": "追記"}, actor="c")
    store.update(b.id, {"state": STATE_IN_PROGRESS}, actor="d")

    rows = store.export_rows()
    assert rows[0] == {"type": "schema", "version": 1}
    assert sum(1 for r in rows if r["type"] == "contact") == 2
    # JSON Lines に書いて読み戻した行でも同じになる（控え・移し替えは JSON を通る）
    rows_via_json = [json.loads(json.dumps(r, ensure_ascii=False)) for r in rows]

    with SqliteStore(tmp_path / "restored" / "copy.sqlite3") as target:
        counts = target.import_rows(rows_via_json)
        # a: 作成・state・note の 3 行、b: 作成・state の 2 行
        assert (counts.contacts, counts.changes) == (2, 5)
        assert _snapshot(target) == _snapshot(store)
        assert target.export_rows() == rows
        # 取り込んだあとも、元の updated_at で排他が効く
        with pytest.raises(ConflictError):
            target.update(a.id, {"note": "x"}, expected_updated_at=a.updated_at)
        latest = target.get(a.id)
        assert target.update(
            a.id, {"note": "x"}, expected_updated_at=latest.updated_at
        ).note == "x"


def test_import_into_ledger_with_same_id_imports_nothing(
    store: SqliteStore, tmp_path: Path
) -> None:
    store.create({"project": "案件A"})
    rows = store.export_rows()
    with SqliteStore(tmp_path / "other.sqlite3") as target:
        extra = target.create({"project": "別の連絡"})
        # 取り込む行の 2 件目を、既にある ID にする
        clash = dict(rows[1], id=extra.id)
        with pytest.raises(DuplicateIdError):
            target.import_rows([rows[0], rows[1], clash])
        assert [c.id for c in target.list_contacts()] == [extra.id]  # 何も増えていない
        assert len(target.history(extra.id)) == 1


def test_import_rejects_bad_rows_atomically(store: SqliteStore, tmp_path: Path) -> None:
    store.create()
    rows = store.export_rows()
    with SqliteStore(tmp_path / "other.sqlite3") as target:
        with pytest.raises(ValueError):
            target.import_rows([*rows, {"type": "mystery"}])
        with pytest.raises(LedgerError):
            target.import_rows([{"type": "schema", "version": 99}])
        orphan = {
            "type": "change",
            "contact_id": "c-20260101-00000000",
            "changed_at": "2026-01-01T00:00:00.000000+00:00",
            "field": "note",
            "old_value": None,
            "new_value": "x",
            "actor": "t",
        }
        with pytest.raises(LedgerError):
            target.import_rows([*rows, orphan])
        assert target.list_contacts() == []


def test_export_of_empty_ledger_is_only_schema_row(store: SqliteStore) -> None:
    assert store.export_rows() == [{"type": "schema", "version": 1}]


def test_sqlite_store_satisfies_ledger_store_protocol(store: SqliteStore) -> None:
    as_protocol: LedgerStore = store
    assert as_protocol.create().state == STATE_DRAFT


def test_reopening_keeps_data_and_does_not_duplicate_schema_version(tmp_path: Path) -> None:
    path = tmp_path / "again.sqlite3"
    with SqliteStore(path) as first:
        contact = first.create({"note": "残る"})
    with SqliteStore(path) as second:
        assert second.get(contact.id).note == "残る"
        rows = second._conn.execute("SELECT COUNT(*) FROM schema_version").fetchone()
        assert rows[0] == 1
