"""deskly の CLI の入口。サブコマンドは ``build_parser`` の ``sub`` に足していく。"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from deskly import __version__
from deskly.api_server import DEFAULT_HOST, DEFAULT_PORT, serve_api
from deskly.case_service import get_case_result
from deskly.commands import (
    DEFAULT_BACKUP_KEEP,
    add_draft,
    backup_rows,
    export_text,
    record_reply,
    set_contact_state,
)
from deskly.config import ConfigError, deskly_home, load_config, workspace_settings
from deskly.dashboard_server import (
    DEFAULT_DASHBOARD_HOST,
    DEFAULT_DASHBOARD_PORT,
    DashboardConfigurationError,
    serve_dashboard,
)
from deskly.importer import ImportReport, run_import
from deskly.ledgers import load_ledgers
from deskly.model import STATES, Contact
from deskly.shared_mode import SharedModeUnavailable, require_local_mode
from deskly.store import (
    LedgerError,
    LedgerStore,
    export_rows_readonly,
)
from deskly.views import build_waiting_rows
from deskly.workspace_backup import export_workspace, restore_workspace
from deskly.workspace_model import WorkspaceError
from deskly.workspace_store import WorkspaceStore


def format_import_report(report: ImportReport) -> str:
    """``deskly import`` の人向け表示。除外した宛先の名前は出さない。"""
    mode = "確認のみ（dry-run）" if report.dry_run else "取り込み"
    lines = [f"{mode}: {len(report.folders)} フォルダ", ""]
    for folder in report.folders:
        lines.append(f"[{folder.ledger}] {folder.folder}")
        if folder.skipped:
            lines.append(f"  スキップ: {folder.skipped}")
            continue
        counts = folder.counts()
        lines.append(
            "  "
            + " / ".join(
                f"{label} {counts[key]}"
                for key, label in (
                    ("files", "ファイル"),
                    ("created", "新規"),
                    ("updated", "更新"),
                    ("unchanged", "変わらず"),
                    ("inferred", "状態推定"),
                    ("unknown_state", "未知の状態"),
                    ("excluded", "取り込まない宛先"),
                    ("unreadable", "読めない"),
                    ("conflicts", "競合"),
                )
            )
        )
        for item in folder.inferred:
            lines.append(f"  状態推定: {item.file} → {item.state}")
        for unknown in folder.unknown_state:
            lines.append(f"  未知の状態: {unknown.file} → {unknown.state}")
        for name in folder.unreadable:
            lines.append(f"  読めない: {name}")
        for name in folder.conflicts:
            lines.append(f"  競合: {name}")
    totals = report.totals()
    lines.extend(
        [
            "",
            "合計: "
            + " / ".join(
                f"{label} {totals.get(key, 0)}"
                for key, label in (
                    ("files", "ファイル"),
                    ("created", "新規"),
                    ("updated", "更新"),
                    ("unchanged", "変わらず"),
                    ("inferred", "状態推定"),
                    ("unknown_state", "未知の状態"),
                    ("excluded", "取り込まない宛先"),
                    ("unreadable", "読めない"),
                    ("conflicts", "競合"),
                )
            ),
        ]
    )
    return "\n".join(lines)


def _import_command(args: argparse.Namespace) -> int:
    try:
        report = run_import(load_config(), dry_run=bool(args.dry_run))
    except (ConfigError, LedgerError, sqlite3.Error, OSError) as exc:
        print(f"deskly import: {exc}", file=sys.stderr)
        return 1
    if args.json:
        json.dump(report.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(format_import_report(report))
    return 0


def _parse_today(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--today は YYYY-MM-DD で指定してください") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("--today は YYYY-MM-DD で指定してください")
    return parsed


def _waiting_command(args: argparse.Namespace) -> int:
    try:
        ledgers = load_ledgers()
        contacts = ledgers.list_contacts()
        rows = build_waiting_rows(
            contacts,
            today=args.today or date.today(),
            include_all=bool(args.all),
        )
    except (ConfigError, LedgerError, sqlite3.Error, OSError) as exc:
        print(f"deskly waiting: {exc}", file=sys.stderr)
        return 1

    if args.json:
        json.dump([row.to_dict() for row in rows], sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    if not rows:
        print("表示する連絡はありません")
        return 0
    for row in rows:
        project = row.project or "案件なし"
        turn = row.turn or "—"
        due = row.due or "なし"
        if row.overdue:
            due += "（期限切れ）"
        summaries = " / ".join(row.summaries) or "要約なし"
        contact_ids = ", ".join(row.contact_refs or row.contact_ids)
        ledger_names = " / ".join(row.ledger_names) or "—"
        print(
            f"台帳: {ledger_names} / 案件: {project} / 番: {turn} / 依頼期限: {due} / "
            f"件数: {row.count} / 連絡: {contact_ids} / 待ち: {summaries}"
        )
    return 0


def _terminal_safe_text(value: str) -> str:
    """Escape C0/C1 and DEL controls before terminal output."""
    return "".join(
        f"\\x{ord(character):02x}"
        if ord(character) < 0x20 or 0x7F <= ord(character) <= 0x9F
        else character
        for character in value
    )


def _contacts_command(args: argparse.Namespace) -> int:
    try:
        ledgers = load_ledgers()
        if args.contacts_action == "list":
            entries = ledgers.list_contacts()
        else:
            entries = ledgers.search_contacts(args.query)
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly contacts: {exc}", file=sys.stderr)
        return 1

    if args.json:
        json.dump(
            [entry.to_dict() for entry in entries],
            sys.stdout,
            ensure_ascii=False,
            indent=2,
        )
        print()
        return 0
    if not entries:
        message = (
            "連絡はありません"
            if args.contacts_action == "list"
            else "該当する連絡はありません"
        )
        print(message)
        return 0

    heading = "連絡" if args.contacts_action == "list" else "検索結果"
    print(f"{heading}: {len(entries)}件")
    for entry in entries:
        contact = entry.contact
        project = contact.project or "案件なし"
        recipient = contact.recipient or "なし"
        due = contact.due or "なし"
        inferred = "（推定）" if contact.state_inferred else ""
        print(
            " / ".join(
                (
                    f"台帳: {_terminal_safe_text(entry.ledger.label)}",
                    f"ID: {_terminal_safe_text(contact.id)}",
                    f"状態: {_terminal_safe_text(contact.state + inferred)}",
                    f"案件: {_terminal_safe_text(project)}",
                    f"宛先: {_terminal_safe_text(recipient)}",
                    f"依頼期限: {_terminal_safe_text(due)}",
                )
            )
        )
    return 0


def _cases_command(args: argparse.Namespace) -> int:
    try:
        result = get_case_result()
    except (ConfigError, LedgerError, sqlite3.Error, OSError) as exc:
        print(f"deskly cases: {exc}", file=sys.stderr)
        return 1

    if args.json:
        json.dump(result.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 1 if result.error else 0

    if result.status == "not_connected":
        print("案件一覧: 未接続")
        return 0
    if result.error:
        print(result.error, file=sys.stderr)
        return 1

    assert result.view is not None
    if not result.view.cases:
        print("表示する案件はありません")
    for case in result.view.cases:
        promised_due = case.promised_due or "なし"
        hold_until = case.hold_until or "なし"
        linked = ", ".join(
            f"{_terminal_safe_text(contact.ledger_name or '台帳')}/"
            f"{_terminal_safe_text(contact.contact_id)}"
            for contact in case.linked_contacts
        ) or "なし"
        print(
            f"案件: {_terminal_safe_text(case.number)} / {_terminal_safe_text(case.title)} / "
            f"状態: {_terminal_safe_text(case.status)} / "
            f"承認: {_terminal_safe_text(case.approval_state)} / "
            f"番: {_terminal_safe_text(case.turn)} / "
            f"希望期限: {_terminal_safe_text(promised_due)} / "
            f"保留期限: {_terminal_safe_text(hold_until)} / 連絡: {linked}"
        )
    if result.view.unlinked_contacts:
        print("案件にリンクされていない連絡:")
        for contact in result.view.unlinked_contacts:
            ledger = _terminal_safe_text(contact.ledger_name or "台帳")
            due = _terminal_safe_text(contact.due or "なし")
            print(
                f"台帳: {ledger} / ID: {_terminal_safe_text(contact.contact_id)} / "
                f"案件: {_terminal_safe_text(contact.project or 'なし')} / "
                f"状態: {_terminal_safe_text(contact.state)} / 依頼期限: {due}"
            )
    return 0


def _write_command(
    name: str,
    operation: Callable[[LedgerStore], Contact],
    *,
    require_existing: bool = False,
    ledger_name: str | None = None,
    contact_id: str | None = None,
) -> int:
    try:
        ledgers = load_ledgers()
        if contact_id is not None:
            definition = ledgers.find_contact(contact_id).ledger
        elif ledger_name is not None:
            definition = ledgers.definition(ledger_name)
        else:
            definition = ledgers.default
        if require_existing and contact_id is None:
            raise AssertionError("既存連絡の更新には contact_id が必要です")
        with ledgers.open_store(definition.name) as store:
            contact = operation(store)
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly {name}: {exc}", file=sys.stderr)
        return 1
    prefix = f"{definition.name}/" if len(ledgers.definitions) > 1 else ""
    print(f"{prefix}{contact.id} {contact.state}")
    return 0


def _add_command(args: argparse.Namespace) -> int:
    option_fields = (
        ("project", args.project),
        ("recipient", args.recipient),
        ("channel", args.channel),
        ("sent_at", args.sent_at),
        ("due", args.due),
        ("promise", args.promise),
        ("agreement", args.agreement),
        ("sensitive", args.sensitive),
        ("basis", args.basis),
        ("note", args.note),
        ("references", args.references),
        ("shared_url", args.shared_url),
        ("body", args.body),
    )
    if args.json_input:
        if any(value is not None for _, value in option_fields):
            print("deskly add: --json-input と個別の本文オプションは同時に使えません", file=sys.stderr)
            return 1
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("入力は JSON object にしてください")
            allowed = {name for name, _ in option_fields}
            unexpected = sorted(set(payload) - allowed)
            if unexpected:
                raise ValueError(f"使用できない項目があります: {', '.join(unexpected)}")
            if any(not isinstance(value, str) for value in payload.values()):
                raise ValueError("各項目の値は文字列にしてください")
            fields = payload
            if not fields.get("recipient", "").strip():
                raise ValueError("宛先を空にできません")
            if not fields.get("body", "").strip():
                raise ValueError("本文を空にできません")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            print(f"deskly add: JSON 入力を確認してください: {exc}", file=sys.stderr)
            return 1
    else:
        fields = {name: value for name, value in option_fields if value is not None}
    return _write_command(
        "add",
        lambda store: add_draft(store, fields),
        ledger_name=args.ledger,
    )


def _set_state_command(args: argparse.Namespace) -> int:
    return _write_command(
        "set-state",
        lambda store: set_contact_state(
            store,
            args.contact_id,
            args.state,
            expected_updated_at=args.expected_updated_at,
        ),
        require_existing=True,
        contact_id=args.contact_id,
    )


def _record_reply_command(args: argparse.Namespace) -> int:
    return _write_command(
        "record-reply",
        lambda store: record_reply(
            store,
            args.contact_id,
            args.summary,
            expected_updated_at=args.expected_updated_at,
        ),
        require_existing=True,
        contact_id=args.contact_id,
    )


def _show_command(args: argparse.Namespace) -> int:
    try:
        entry = load_ledgers().find_contact(args.contact_id)
        contact = entry.contact
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly show: {exc}", file=sys.stderr)
        return 1
    if args.json:
        json.dump(entry.to_dict(), sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0
    labels = (
        ("id", "ID"),
        ("state", "状態"),
        ("state_inferred", "状態の推定"),
        ("project", "案件"),
        ("recipient", "宛先"),
        ("channel", "経路"),
        ("sent_at", "送信日時"),
        ("due", "依頼期限"),
        ("promise", "約束"),
        ("agreement", "合意"),
        ("sensitive", "機微"),
        ("basis", "根拠"),
        ("note", "補足"),
        ("references", "参照"),
        ("shared_url", "共有 URL"),
        ("body", "本文"),
        ("source_path", "取り込み元"),
        ("source_hash", "取り込み元のハッシュ"),
        ("extra", "知らない欄"),
        ("created_at", "作成日時"),
        ("updated_at", "更新日時"),
    )
    print(f"台帳: {entry.ledger.label}")
    for name, label in labels:
        value = getattr(contact, name)
        if name == "extra":
            value = json.dumps(dict(value), ensure_ascii=False, sort_keys=True)
        print(f"{label}: {value}")
    return 0


def _export_command(args: argparse.Namespace) -> int:
    try:
        contact = load_ledgers().find_contact(args.contact_id).contact
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly export: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(export_text(contact))
    return 0


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("1 以上の整数を指定してください") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("1 以上の整数を指定してください")
    return parsed


def _backup_command(args: argparse.Namespace) -> int:
    try:
        ledgers = load_ledgers()
        exports: list[tuple[Any, list[dict[str, Any]]]] = []
        missing = []
        for definition in ledgers.definitions:
            if definition.storage == "local":
                path = ledgers.config.local_ledger_path(definition.name)
                if not path.is_file():
                    missing.append(definition.name)
                    continue
                rows = export_rows_readonly(path)
            else:
                with ledgers.open_store(definition.name) as store:
                    rows = store.export_rows()
            exports.append((definition, rows))
        if not exports:
            raise FileNotFoundError("控え対象の台帳がありません")
        backups = []
        for definition, rows in exports:
            backups.append(
                backup_rows(
                    rows,
                    ledger_name=definition.name,
                    destination=args.dest,
                    keep=args.keep,
                )
            )
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly backup: {exc}", file=sys.stderr)
        return 1
    for name in missing:
        print(f"控えをスキップしました（台帳が未作成）: {name}")
    for backup in backups:
        print(f"控えを書き出しました: {backup}")
    return 0


def _serve_api_command(args: argparse.Namespace) -> int:
    token = os.environ.get(args.token_env, "")
    if not token:
        print("deskly serve-api: API token が未設定のため起動できません", file=sys.stderr)
        return 1
    try:
        ledgers = load_ledgers()
        definition = ledgers.definition(args.ledger)
        ledger_path = ledgers.config.local_ledger_path(definition.name)
        serve_api(ledger_path, token, host=args.host, port=args.port)
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly serve-api: {exc}", file=sys.stderr)
        return 1
    return 0


def _dashboard_serve_command(args: argparse.Namespace) -> int:
    try:
        serve_dashboard(host=args.host, port=args.port)
    except DashboardConfigurationError as exc:
        print(f"deskly dashboard serve: {exc}", file=sys.stderr)
        return 1
    except OSError:
        print("deskly dashboard serve: server could not start", file=sys.stderr)
        return 1
    return 0


def _workspace_command(args: argparse.Namespace) -> int:
    home = deskly_home()
    try:
        if args.workspace_command == "init":
            if workspace_settings(home) is not None or (home / "workspace.json").exists():
                raise WorkspaceError("workspace_already_initialized", 409)
            workspace_id, member_id = WorkspaceStore.initialize(
                home, args.name, args.timezone, args.owner
            )
            with (home / "workspace.json").open("x", encoding="utf-8") as stream:
                json.dump({"workspace_id": workspace_id}, stream)
            print(json.dumps({"workspace_id": workspace_id, "member_id": member_id}))
        elif args.workspace_command == "backup":
            settings = workspace_settings(home)
            if settings is None:
                raise WorkspaceError("workspace_not_initialized", 404)
            print(json.dumps(export_workspace(home, settings["workspace_id"], args.dest)))
        elif args.workspace_command == "upgrade-access":
            settings = workspace_settings(home)
            if settings is None:
                raise WorkspaceError("workspace_not_initialized", 404)
            WorkspaceStore(home / "workspaces" / f"{settings['workspace_id']}.sqlite3").upgrade_access(
                settings["workspace_id"], args.backup
            )
            print(json.dumps({"workspace_id": settings["workspace_id"], "access_schema": 2,
                              "backup": str(args.backup)}))
        else:
            if (home / "workspace.json").exists():
                raise WorkspaceError("workspace_already_initialized", 409)
            manifest = restore_workspace(args.source, home)
            # A restore into an empty home becomes active explicitly.
            with (home / "workspace.json").open("x", encoding="utf-8") as stream:
                json.dump({"workspace_id": manifest["workspace_id"]}, stream)
            print(json.dumps(manifest))
    except (WorkspaceError, ConfigError, OSError, sqlite3.Error) as exc:
        print(f"deskly workspace: {exc}", file=sys.stderr)
        return 1
    return 0


def _move_ledger_command(args: argparse.Namespace) -> int:
    try:
        ledgers = load_ledgers()
        source_definition = ledgers.definition(args.source)
        target_definition = ledgers.definition(args.target)
        if source_definition.name == target_definition.name:
            raise ValueError("移行元と移行先は別の台帳にしてください")

        with ledgers.open_store(source_definition.name) as source:
            source_rows = source.export_rows()
            source_contacts = source.list_contacts()
        with ledgers.open_store(target_definition.name) as target:
            if target.list_contacts():
                raise ValueError("移行先の台帳が空ではありません")
            target.import_rows(source_rows)
            target_rows = target.export_rows()
            target_contacts = target.list_contacts()

        source_ids = sorted(contact.id for contact in source_contacts)
        target_ids = sorted(contact.id for contact in target_contacts)
        if source_ids != target_ids or len(source_contacts) != len(target_contacts):
            raise LedgerError("移行先の連絡件数または ID が移行元と一致しません")
        if source_rows != target_rows:
            raise LedgerError("移行先の連絡または変更の経過が移行元と一致しません")
        with ledgers.open_store(source_definition.name) as source:
            if source.export_rows() != source_rows:
                raise LedgerError("移行中に移行元の台帳が変わりました。元の台帳は保持しています")
    except (ConfigError, LedgerError, sqlite3.Error, OSError, ValueError) as exc:
        print(f"deskly move-ledger: {exc}", file=sys.stderr)
        return 1
    print(
        f"移行先を確認しました（元の台帳は保持）: "
        f"{source_definition.name} → {target_definition.name} / {len(source_ids)} 件"
    )
    return 0


def _mcp_command(_args: argparse.Namespace) -> int:
    try:
        from deskly.mcp_server import run_stdio_server

        run_stdio_server()
    except ModuleNotFoundError:
        print(
            "deskly mcp: MCP の追加依存がありません。"
            "`pip install 'deskly[mcp]'` でインストールしてください。",
            file=sys.stderr,
        )
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deskly",
        description="連絡・案件・工数を 1 か所で見渡すための道具。",
    )
    parser.add_argument("--version", action="version", version=f"deskly {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    importer = sub.add_parser("import", help="返信テキストを台帳へ取り込む")
    importer.add_argument("--dry-run", action="store_true", help="台帳へ書かずに件数を確かめる")
    importer.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    importer.set_defaults(handler=_import_command)
    waiting = sub.add_parser("waiting", help="今日、誰の番かを案件ごとに一覧する")
    waiting.add_argument("--all", action="store_true", help="完了した連絡なども含める")
    waiting.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    waiting.add_argument("--today", type=_parse_today, help="今日の日付（YYYY-MM-DD）")
    waiting.set_defaults(handler=_waiting_command)
    cases = sub.add_parser("cases", help="issuepost の案件一覧と関連する連絡を読む")
    cases.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    cases.set_defaults(handler=_cases_command)

    contacts = sub.add_parser("contacts", help="連絡を全件一覧・検索する")
    contacts_sub = contacts.add_subparsers(dest="contacts_action", required=True)
    contact_list = contacts_sub.add_parser("list", help="全台帳の連絡を一覧する")
    contact_list.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    contact_list.set_defaults(handler=_contacts_command)
    contact_search = contacts_sub.add_parser("search", help="連絡を部分一致で検索する")
    contact_search.add_argument("query", help="検索語")
    contact_search.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    contact_search.set_defaults(handler=_contacts_command)

    add = sub.add_parser("add", help="連絡の下書きを作る")
    add.add_argument("--ledger", help="作成する台帳名（既定の台帳を使う場合は省略）")
    add.add_argument(
        "--json-input",
        action="store_true",
        help="JSON object を標準入力から読む（本文をコマンドライン引数に出さない）",
    )
    for option, help_text in (
        ("project", "案件"),
        ("recipient", "宛先"),
        ("channel", "経路"),
        ("sent-at", "送信日時"),
        ("due", "依頼期限"),
        ("promise", "約束"),
        ("agreement", "合意"),
        ("sensitive", "機微"),
        ("basis", "根拠"),
        ("note", "補足"),
        ("references", "参照"),
        ("shared-url", "共有 URL"),
        ("body", "本文"),
    ):
        dest = option.replace("-", "_")
        add.add_argument(f"--{option}", dest=dest, help=help_text)
    add.set_defaults(handler=_add_command)

    set_state = sub.add_parser("set-state", help="連絡の状態を変える")
    set_state.add_argument("contact_id")
    set_state.add_argument("state", choices=STATES)
    set_state.add_argument("--expected-updated-at")
    set_state.set_defaults(handler=_set_state_command)

    reply = sub.add_parser("record-reply", help="返信の要約を記録して対応中にする")
    reply.add_argument("contact_id")
    reply.add_argument("--summary", required=True)
    reply.add_argument("--expected-updated-at")
    reply.set_defaults(handler=_record_reply_command)

    show = sub.add_parser("show", help="連絡を 1 件表示する")
    show.add_argument("contact_id")
    show.add_argument("--json", action="store_true", help="JSON 形式で結果を出す")
    show.set_defaults(handler=_show_command)

    export = sub.add_parser("export", help="コピペ用に本文だけを出す")
    export.add_argument("contact_id")
    export.set_defaults(handler=_export_command)

    backup = sub.add_parser("backup", help="台帳と変更履歴の控えを JSON Lines で書く")
    backup.add_argument("--dest", type=Path, help="控えの出力先フォルダ")
    backup.add_argument("--keep", type=_positive_int, default=DEFAULT_BACKUP_KEEP)
    backup.set_defaults(handler=_backup_command)

    serve = sub.add_parser("serve-api", help="認証付き台帳 API を起動する")
    serve.add_argument("--host", default=DEFAULT_HOST, help="待ち受け先（既定は 127.0.0.1）")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT, help="待ち受けポート")
    serve.add_argument("--ledger", required=True, help="配信する local 台帳名")
    serve.add_argument("--token-env", default="DESKLY_API_TOKEN", help="Bearer token の環境変数名")
    serve.set_defaults(handler=_serve_api_command)

    dashboard = sub.add_parser("dashboard", help="localhost の read-only dashboard")
    dashboard_sub = dashboard.add_subparsers(dest="dashboard_command", required=True)
    dashboard_serve = dashboard_sub.add_parser("serve", help="dashboard を localhost で起動する")
    dashboard_serve.add_argument(
        "--host", default=DEFAULT_DASHBOARD_HOST, help="待ち受け先（127.0.0.1 のみ）"
    )
    dashboard_serve.add_argument(
        "--port", type=int, default=DEFAULT_DASHBOARD_PORT, help="待ち受けポート"
    )
    dashboard_serve.set_defaults(handler=_dashboard_serve_command)

    workspace = sub.add_parser("workspace", help="個人用 workspace の明示初期化と控え")
    workspace_sub = workspace.add_subparsers(dest="workspace_command", required=True)
    workspace_init = workspace_sub.add_parser("init", help="個人用 workspace を作成")
    workspace_init.add_argument("--name", required=True)
    workspace_init.add_argument("--timezone", default="Asia/Tokyo")
    workspace_init.add_argument("--owner", required=True)
    workspace_init.set_defaults(handler=_workspace_command)
    workspace_backup = workspace_sub.add_parser("backup", help="版付き控えを作成")
    workspace_backup.add_argument("--dest", type=Path, required=True)
    workspace_backup.set_defaults(handler=_workspace_command)
    workspace_upgrade = workspace_sub.add_parser("upgrade-access", help="既存 workspace の共有権限スキーマを明示追加")
    workspace_upgrade.add_argument("--backup", type=Path, required=True)
    workspace_upgrade.set_defaults(handler=_workspace_command)
    workspace_restore = workspace_sub.add_parser("restore", help="空の別保存先へ復旧")
    workspace_restore.add_argument("--source", type=Path, required=True)
    workspace_restore.set_defaults(handler=_workspace_command)

    move = sub.add_parser("move-ledger", help="空の台帳へ移行し、件数と ID を確認する")
    move.add_argument("--from", dest="source", required=True, help="移行元の台帳名")
    move.add_argument("--to", dest="target", required=True, help="移行先の台帳名")
    move.set_defaults(handler=_move_ledger_command)

    mcp = sub.add_parser("mcp", help="stdio MCP サーバーを起動する（extra mcp が必要）")
    mcp.set_defaults(handler=_mcp_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        require_local_mode()
    except SharedModeUnavailable as exc:
        print(f"deskly: {exc}", file=sys.stderr)
        return 1
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
