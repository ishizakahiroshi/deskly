"""deskly の CLI の入口。サブコマンドは ``build_parser`` の ``sub`` に足していく。"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

from deskly import __version__
from deskly.config import ConfigError, load_config
from deskly.importer import ImportReport, run_import
from deskly.store import LedgerError


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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
