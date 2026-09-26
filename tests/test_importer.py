from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from deskly.cli import main
from deskly.config import (
    LEDGER_COMPANY,
    LEDGER_PERSONAL,
    Config,
    ConfigError,
    ExcludedRecipients,
    ImportSource,
    ledger_path,
    load_config,
    parse_config,
)
from deskly.importer import (
    Exclusions,
    folder_skip_reason,
    import_folder,
    parse_reply,
    resolve_state,
    run_import,
    state_word,
)
from deskly.model import (
    STATE_DRAFT,
    STATE_SENT,
    STATES,
)
from deskly.store import SqliteStore


def _reply(**overrides: str) -> str:
    fields = {
        "状態": "回答待ち（相手の返答待ち）",
        "送信日時": "2026-01-02 09:30",
        "宛先": "合成の宛先",
        "経路": "合成経路",
        "補足": "補足文",
        "参照": "https://example.invalid/reference",
        "共有URL": "https://example.invalid/share",
        "案件": "合成案件",
        "依頼期限": "2026-01-10",
        "約束": "期限までに返す",
        "合意": "合意した内容",
        "機微": "機微なし",
        "根拠": "合成資料",
        "知らない欄": "追加値",
    }
    fields.update(overrides)
    return "\n".join(f"{key}: {value}" for key, value in fields.items()) + "\n\n本文 1 行目\n本文 2 行目\n"


def _source(tmp_path: Path, *, ledger: str = LEDGER_COMPANY) -> ImportSource:
    folder = tmp_path / "synthetic-replies"
    folder.mkdir(parents=True, exist_ok=True)
    return ImportSource(path=folder, ledger=ledger)


def _write_config(
    home: Path,
    sources: list[tuple[Path, str]],
    excluded: tuple[Path, str] | None = None,
) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    if excluded is None:
        csv_path = home / "excluded.csv"
        csv_path.write_text("name\nSynthetic Excluded Recipient\n", encoding="utf-8")
        excluded = (csv_path, "name")
    parts: list[str] = []
    for folder, ledger in sources:
        parts.extend(
            [
                "[[sources]]",
                f"path = {json.dumps(str(folder))}",
                f"ledger = {json.dumps(ledger)}",
                "",
            ]
        )
    if excluded is not None:
        csv_path, column = excluded
        parts.extend(
            [
                "[excluded_recipients]",
                f"csv = {json.dumps(str(csv_path))}",
                f"column = {json.dumps(column)}",
                "",
            ]
        )
    config = home / "config.toml"
    config.write_text("\n".join(parts), encoding="utf-8")
    return config


def test_parse_config_requires_absolute_paths_and_known_ledgers(tmp_path: Path) -> None:
    folder = tmp_path / "source"
    config = parse_config(
        {
            "sources": [{"path": str(folder), "ledger": LEDGER_COMPANY}],
            "excluded_recipients": {"csv": str(tmp_path / "excluded.csv"), "column": "name"},
        }
    )
    assert config.sources == (ImportSource(path=folder, ledger=LEDGER_COMPANY),)

    with pytest.raises(ConfigError, match="excluded_recipients"):
        parse_config({"sources": [{"path": str(folder), "ledger": LEDGER_COMPANY}]})
    with pytest.raises(ConfigError, match="絶対パス"):
        parse_config(
            {
                "sources": [{"path": "relative", "ledger": LEDGER_COMPANY}],
                "excluded_recipients": {
                    "csv": str(tmp_path / "excluded.csv"),
                    "column": "name",
                },
            }
        )
    with pytest.raises(ConfigError, match="ledger"):
        parse_config({"sources": [{"path": str(folder), "ledger": "other"}]})


def test_parse_config_checks_excluded_recipient_settings(tmp_path: Path) -> None:
    folder = tmp_path / "source"
    csv_path = tmp_path / "excluded.csv"
    config = parse_config(
        {
            "sources": [{"path": str(folder), "ledger": LEDGER_PERSONAL}],
            "excluded_recipients": {"csv": str(csv_path), "column": "name"},
        }
    )
    assert config.excluded_recipients == ExcludedRecipients(csv_path, "name")

    with pytest.raises(ConfigError):
        parse_config({"excluded_recipients": {"csv": "relative.csv", "column": "name"}})
    with pytest.raises(ConfigError):
        parse_config(
            {"excluded_recipients": {"csv": str(csv_path), "column": "  "}}
        )
    with pytest.raises(ConfigError, match="excluded_recipients"):
        parse_config({"sources": [{"path": str(folder), "ledger": LEDGER_COMPANY}]})


def test_load_config_uses_deskly_home_and_ledger_path(
    isolate_deskly_home: Path, tmp_path: Path
) -> None:
    folder = tmp_path / "synthetic-replies"
    config_path = _write_config(isolate_deskly_home, [(folder, LEDGER_COMPANY)])

    assert load_config() == parse_config(
        {
            "sources": [{"path": str(folder), "ledger": "company"}],
            "excluded_recipients": {
                "csv": str(isolate_deskly_home / "excluded.csv"),
                "column": "name",
            },
        }
    )
    assert config_path == isolate_deskly_home / "config.toml"
    assert ledger_path(LEDGER_COMPANY) == isolate_deskly_home / "ledger" / "company.sqlite3"
    with pytest.raises(ConfigError):
        ledger_path("other")


def test_load_config_reports_missing_or_invalid_toml(isolate_deskly_home: Path) -> None:
    with pytest.raises(ConfigError, match="見つかりません"):
        load_config()
    isolate_deskly_home.mkdir()
    (isolate_deskly_home / "config.toml").write_text("not = [toml", encoding="utf-8")
    with pytest.raises(ConfigError, match="読めません"):
        load_config()


def test_parse_reply_maps_all_headers_body_and_unknown_fields() -> None:
    parsed = parse_reply(
        _reply(**{"状態": "回答待ち（返答待ち）", "知らない欄": "1 行目\n  続き"})
    )

    assert parsed.fields == {
        "sent_at": "2026-01-02 09:30",
        "recipient": "合成の宛先",
        "channel": "合成経路",
        "note": "補足文",
        "references": "https://example.invalid/reference",
        "shared_url": "https://example.invalid/share",
        "project": "合成案件",
        "due": "2026-01-10",
        "promise": "期限までに返す",
        "agreement": "合意した内容",
        "sensitive": "機微なし",
        "basis": "合成資料",
        "body": "本文 1 行目\n本文 2 行目",
    }
    assert parsed.state_line == "回答待ち（返答待ち）"
    assert parsed.extra == {"知らない欄": "1 行目\n続き"}


def test_parse_reply_keeps_duplicate_and_unheaded_lines_in_extra() -> None:
    parsed = parse_reply("先頭の孤立行\n宛先: 合成A\n宛先: 合成B\n\n本文")

    assert parsed.fields["recipient"] == "合成A"
    assert parsed.extra == {"宛先": "合成B", "_行1": "先頭の孤立行"}
    assert parsed.fields["body"] == "本文"


def test_no_project_marker_becomes_empty() -> None:
    assert parse_reply("案件: なし\n\n本文").fields["project"] == ""


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("送信済み（相手の返答待ち）", STATE_SENT),
        ("回答待ち(相手)", "回答待ち"),
        ("対応中。補足", "対応中"),
        ("完了、補足", "完了"),
        ("下書き 続き", "下書き"),
    ],
)
def test_state_word_uses_first_word(value: str, expected: str) -> None:
    assert state_word(value) == expected


@pytest.mark.parametrize("word", STATES)
def test_resolve_state_accepts_exact_six_states(word: str) -> None:
    parsed = parse_reply(f"状態: {word}\n\n本文")
    assert resolve_state(parsed) == (word, False, word)


@pytest.mark.parametrize("sent_at, expected", [("2026-01-02", STATE_SENT), ("", STATE_DRAFT)])
def test_resolve_state_infers_only_when_state_header_is_absent(
    sent_at: str, expected: str
) -> None:
    parsed = parse_reply(f"送信日時: {sent_at}\n\n本文")
    assert resolve_state(parsed) == (expected, True, "")


def test_unknown_state_is_not_normalized_into_a_valid_state() -> None:
    parsed = parse_reply("状態: 保留（別の語）\n\n本文")
    state, inferred, word = resolve_state(parsed)
    assert state is None
    assert inferred is False
    assert word == "保留"


def test_exclusions_normalize_width_case_and_whitespace() -> None:
    exclusions = Exclusions(["Ａｌｉｃｅ Smith", "", "   "])
    assert exclusions.matches("Recipient: alice   smith さん")
    assert not exclusions.matches("別の合成宛先")
    assert len(exclusions) == 1


def test_load_exclusions_fails_closed_if_csv_or_column_is_missing(tmp_path: Path) -> None:
    from deskly.importer import load_exclusions

    with pytest.raises(ConfigError):
        load_exclusions(ExcludedRecipients(tmp_path / "missing.csv", "name"))
    csv_path = tmp_path / "wrong-column.csv"
    csv_path.write_text("recipient\n合成宛先\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="列"):
        load_exclusions(ExcludedRecipients(csv_path, "name"))
    empty_path = tmp_path / "empty.csv"
    empty_path.write_text("name\n\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="有効な値"):
        load_exclusions(ExcludedRecipients(empty_path, "name"))


def test_import_creates_contact_and_preserves_all_fields(tmp_path: Path) -> None:
    source = _source(tmp_path)
    path = source.path / "synthetic-a.txt"
    text = _reply()
    path.write_text(text, encoding="utf-8")

    with SqliteStore(tmp_path / "company.sqlite3") as store:
        report = import_folder(source, lambda _: store, Exclusions(()))
        contacts = store.list_contacts()

        assert report.counts() == {
            "files": 1,
            "created": 1,
            "updated": 0,
            "unchanged": 0,
            "inferred": 0,
            "unknown_state": 0,
            "excluded": 0,
            "unreadable": 0,
            "conflicts": 0,
        }
        assert len(contacts) == 1
        contact = contacts[0]
        assert contact.state == "回答待ち"
        assert contact.state_inferred is False
        assert contact.sent_at == "2026-01-02 09:30"
        assert contact.recipient == "合成の宛先"
        assert contact.channel == "合成経路"
        assert contact.note == "補足文"
        assert contact.references == "https://example.invalid/reference"
        assert contact.shared_url == "https://example.invalid/share"
        assert contact.project == "合成案件"
        assert contact.due == "2026-01-10"
        assert contact.promise == "期限までに返す"
        assert contact.agreement == "合意した内容"
        assert contact.sensitive == "機微なし"
        assert contact.basis == "合成資料"
        assert contact.body == "本文 1 行目\n本文 2 行目"
        assert contact.source_path == str(path.absolute())
        assert contact.source_hash == hashlib.sha256(path.read_bytes()).hexdigest()
        assert dict(contact.extra) == {"知らない欄": "追加値"}
        assert len(store.history(contact.id)) == 1


def test_unknown_state_is_reported_without_creating_contact(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source.path / "unknown.txt").write_text("状態: 保留\n\n本文", encoding="utf-8")
    with SqliteStore(tmp_path / "company.sqlite3") as store:
        report = import_folder(source, lambda _: store, Exclusions(()))
        assert report.counts()["unknown_state"] == 1
        assert report.unknown_state[0].file == "unknown.txt"
        assert report.unknown_state[0].state == "保留"
        assert store.list_contacts() == []


@pytest.mark.parametrize(
    ("content", "expected_state"),
    [("宛先: 合成A\n\n本文", STATE_DRAFT), ("送信日時: 今日\n\n本文", STATE_SENT)],
)
def test_import_marks_inferred_states(
    tmp_path: Path, content: str, expected_state: str
) -> None:
    source = _source(tmp_path)
    (source.path / "inferred.txt").write_text(content, encoding="utf-8")
    with SqliteStore(tmp_path / "company.sqlite3") as store:
        report = import_folder(source, lambda _: store, Exclusions(()))
        contact = store.list_contacts()[0]
        assert contact.state == expected_state
        assert contact.state_inferred is True
        assert [(item.file, item.state) for item in report.inferred] == [
            ("inferred.txt", expected_state)
        ]


def test_excluded_recipient_is_count_only_and_never_created(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source.path / "private-synthetic.txt").write_text(
        "宛先: Synthetic Family Member\n\n本文", encoding="utf-8"
    )
    with SqliteStore(tmp_path / "company.sqlite3") as store:
        report = import_folder(
            source,
            lambda _: store,
            Exclusions(["synthetic family"]),
        )
        encoded = json.dumps(report.to_dict(), ensure_ascii=False)
        assert report.counts()["excluded"] == 1
        assert store.list_contacts() == []
        assert "Synthetic Family Member" not in encoded
        assert "private-synthetic.txt" not in encoded


@pytest.mark.parametrize("part", ["worktrees", "archive", ".claude", ".many-ai-cli"])
def test_skips_forbidden_path_parts_without_opening_store(tmp_path: Path, part: str) -> None:
    folder = tmp_path / part / "synthetic-replies"
    folder.mkdir(parents=True)
    (folder / "a.txt").write_text(_reply(), encoding="utf-8")
    source = ImportSource(folder, LEDGER_COMPANY)
    called = False

    def open_store(_: str) -> SqliteStore:
        nonlocal called
        called = True
        raise AssertionError("skipped source must not open a ledger")

    report = import_folder(source, open_store, Exclusions(()))
    assert report.skipped
    assert report.files == 0
    assert called is False


def test_skips_git_worktree_when_git_marker_is_a_file(tmp_path: Path) -> None:
    worktree = tmp_path / "linked-checkout"
    replies = worktree / "docs" / "local" / "reply"
    replies.mkdir(parents=True)
    (worktree / ".git").write_text("gitdir: synthetic\n", encoding="utf-8")
    (replies / "a.txt").write_text(_reply(), encoding="utf-8")

    reason = folder_skip_reason(replies)
    assert "worktree" in reason
    assert "ファイル" in reason


def test_nonexistent_source_is_reported_as_skipped(tmp_path: Path) -> None:
    source = ImportSource(tmp_path / "missing", LEDGER_COMPANY)
    report = import_folder(source, lambda _: None, Exclusions(()))
    assert report.skipped == "フォルダが無い"
    assert report.files == 0


def test_unreadable_utf8_file_is_counted_without_stopping_other_files(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source.path / "bad.txt").write_bytes(b"\xff\xfe")
    (source.path / "good.txt").write_text(_reply(), encoding="utf-8")
    with SqliteStore(tmp_path / "company.sqlite3") as store:
        report = import_folder(source, lambda _: store, Exclusions(()))
        assert report.counts()["files"] == 2
        assert report.unreadable == ["bad.txt"]
        assert report.created == 1
        assert len(store.list_contacts()) == 1


def test_import_is_idempotent_and_changed_file_logs_each_changed_field(tmp_path: Path) -> None:
    source = _source(tmp_path)
    path = source.path / "same.txt"
    path.write_text(_reply(), encoding="utf-8")
    with SqliteStore(tmp_path / "company.sqlite3") as store:
        import_folder(source, lambda _: store, Exclusions(()))
        contact = store.find_by_source_path(str(path.absolute()))
        assert contact is not None
        first_history_count = len(store.history(contact.id))

        second = import_folder(source, lambda _: store, Exclusions(()))
        assert second.unchanged == 1
        assert len(store.list_contacts()) == 1
        assert len(store.history(contact.id)) == first_history_count

        path.write_text(_reply(**{"補足": "更新された補足"}), encoding="utf-8")
        third = import_folder(source, lambda _: store, Exclusions(()))
        assert third.updated == 1
        assert len(store.list_contacts()) == 1
        assert store.get(contact.id).note == "更新された補足"
        changes = store.history(contact.id)[first_history_count:]
        assert {change.field for change in changes} == {"note", "source_hash"}
        assert len(changes) == 2


def test_dry_run_does_not_create_missing_ledger(tmp_path: Path, isolate_deskly_home: Path) -> None:
    source = _source(tmp_path)
    (source.path / "a.txt").write_text(_reply(), encoding="utf-8")
    _write_config(isolate_deskly_home, [(source.path, LEDGER_COMPANY)])

    report = run_import(load_config(), dry_run=True)

    assert report.dry_run is True
    assert report.totals()["created"] == 1
    assert not ledger_path(LEDGER_COMPANY).exists()


def test_dry_run_reads_existing_ledger_without_writing(
    tmp_path: Path, isolate_deskly_home: Path
) -> None:
    source = _source(tmp_path)
    (source.path / "a.txt").write_text(_reply(), encoding="utf-8")
    _write_config(isolate_deskly_home, [(source.path, LEDGER_COMPANY)])
    ledger = ledger_path(LEDGER_COMPANY)
    ledger.parent.mkdir(parents=True)
    with SqliteStore(ledger) as store:
        first = import_folder(source, lambda _: store, Exclusions(()))
        assert first.created == 1
        before_rows = store.export_rows()
        before_database = hashlib.sha256(ledger.read_bytes()).digest()
        report = run_import(load_config(), dry_run=True)
        assert report.totals()["unchanged"] == 1
        assert store.export_rows() == before_rows
        assert hashlib.sha256(ledger.read_bytes()).digest() == before_database


def test_run_import_writes_to_separate_company_and_personal_ledgers(
    tmp_path: Path, isolate_deskly_home: Path, capsys
) -> None:
    company = _source(tmp_path / "company", ledger=LEDGER_COMPANY)
    personal = _source(tmp_path / "personal", ledger=LEDGER_PERSONAL)
    (company.path / "company.txt").write_text(_reply(), encoding="utf-8")
    (personal.path / "personal.txt").write_text(_reply(), encoding="utf-8")
    _write_config(
        isolate_deskly_home,
        [(company.path, LEDGER_COMPANY), (personal.path, LEDGER_PERSONAL)],
    )

    report = run_import(load_config())

    assert report.totals()["created"] == 2
    with SqliteStore(ledger_path(LEDGER_COMPANY)) as company_store:
        assert len(company_store.list_contacts()) == 1
    with SqliteStore(ledger_path(LEDGER_PERSONAL)) as personal_store:
        assert len(personal_store.list_contacts()) == 1

    assert main(["waiting", "--json", "--today", "2026-01-03"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert len(rows) == 1
    assert rows[0]["count"] == 2
    assert rows[0]["ledger_names"] == [LEDGER_COMPANY, LEDGER_PERSONAL]
    assert [ref.split("/", maxsplit=1)[0] for ref in rows[0]["contact_refs"]] == [
        LEDGER_COMPANY,
        LEDGER_PERSONAL,
    ]


def test_run_import_uses_configured_local_ledger_paths(
    tmp_path: Path, isolate_deskly_home: Path
) -> None:
    source = _source(tmp_path, ledger="work")
    (source.path / "message.txt").write_text(_reply(), encoding="utf-8")
    custom_path = tmp_path / "configured" / "work-ledger.sqlite3"
    excluded_csv = tmp_path / "excluded.csv"
    excluded_csv.write_text("name\nSynthetic Excluded Recipient\n", encoding="utf-8")
    config = parse_config(
        {
            "default_ledger": "work",
            "ledgers": [
                {
                    "name": "work",
                    "label": "Work",
                    "storage": "local",
                    "path": str(custom_path),
                }
            ],
            "sources": [{"path": str(source.path), "ledger": "work"}],
            "excluded_recipients": {"csv": str(excluded_csv), "column": "name"},
        }
    )

    report = run_import(config)

    assert report.totals()["created"] == 1
    with SqliteStore(custom_path) as store:
        assert len(store.list_contacts()) == 1
    assert not ledger_path(LEDGER_COMPANY).exists()


def test_run_import_requires_at_least_one_source() -> None:
    with pytest.raises(ConfigError, match="取り込み元"):
        run_import(Config())


def test_import_cli_supports_dry_run_text_and_json(
    tmp_path: Path,
    isolate_deskly_home: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = _source(tmp_path)
    (source.path / "a.txt").write_text(_reply(), encoding="utf-8")
    _write_config(isolate_deskly_home, [(source.path, LEDGER_COMPANY)])

    assert main(["import", "--dry-run"]) == 0
    text = capsys.readouterr().out
    assert "確認のみ（dry-run）" in text
    assert "新規 1" in text
    assert "取り込まない宛先 0" in text
    assert not ledger_path(LEDGER_COMPANY).exists()

    assert main(["import", "--dry-run", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["totals"]["created"] == 1
    assert not ledger_path(LEDGER_COMPANY).exists()


def test_import_cli_returns_one_for_bad_config(
    isolate_deskly_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    isolate_deskly_home.mkdir()
    (isolate_deskly_home / "config.toml").write_text("bad = [toml", encoding="utf-8")

    assert main(["import", "--json"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "deskly import:" in captured.err
