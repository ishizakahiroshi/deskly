"""deskly の CLI の入口。サブコマンドは ``build_parser`` の ``sub`` に足していく。"""

from __future__ import annotations

import argparse
import sys

from deskly import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deskly",
        description="連絡・案件・工数を 1 か所で見渡すための道具。",
    )
    parser.add_argument("--version", action="version", version=f"deskly {__version__}")
    # サブコマンドはここへ足す: sub.add_parser("<name>", help="...")
    parser.add_subparsers(dest="command", metavar="<command>")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
