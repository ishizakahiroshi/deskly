"""CLI から使う連絡の操作と、世代を残す JSON Lines の控え。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from deskly.config import deskly_home
from deskly.model import STATE_DRAFT, STATE_IN_PROGRESS, Contact
from deskly.store import LedgerStore

DEFAULT_BACKUP_KEEP = 7
CLI_ACTOR = "cli"
_LEDGER_NAME_RE = re.compile(r"[a-z][a-z0-9_-]*")
_BACKUP_SUBDIRECTORY = "deskly-backups"
_BACKUP_OWNER_SUFFIX = ".deskly-owner"


def _backup_owner_marker_path(path: Path) -> Path:
    return path.with_name(f"{path.name}{_BACKUP_OWNER_SUFFIX}")


def _backup_owner_marker(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "owner": "deskly",
        "version": 1,
        "file": path.name,
        "sha256": digest,
    }


def _has_valid_backup_owner(path: Path) -> bool:
    marker = _backup_owner_marker_path(path)
    try:
        if path.is_symlink() or marker.is_symlink() or not marker.is_file():
            return False
        if marker.stat().st_size > 512:
            return False
        recorded = json.loads(marker.read_text(encoding="utf-8"))
        return recorded == _backup_owner_marker(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def add_draft(
    store: LedgerStore, fields: Mapping[str, Any], *, actor: str = CLI_ACTOR
) -> Contact:
    """下書きを 1 件作り、作成の経過を台帳に残す。"""
    values = dict(fields)
    if "state" in values:
        raise ValueError("add は下書きだけを作ります")
    return store.create({"state": STATE_DRAFT, **values}, actor=actor)


def set_contact_state(
    store: LedgerStore,
    contact_id: str,
    state: str,
    *,
    expected_updated_at: str | None = None,
    actor: str = CLI_ACTOR,
) -> Contact:
    """状態を変え、台帳の排他と変更履歴に従う。"""
    expected = expected_updated_at
    if expected is None:
        expected = store.get(contact_id).updated_at
    return store.update(
        contact_id,
        {"state": state},
        expected_updated_at=expected,
        actor=actor,
    )


def record_reply(
    store: LedgerStore,
    contact_id: str,
    summary: str,
    *,
    expected_updated_at: str | None = None,
    actor: str = CLI_ACTOR,
) -> Contact:
    """返信要約を補足へ追記し、状態を対応中にする。"""
    clean_summary = summary.strip()
    if not clean_summary:
        raise ValueError("返信の要約を空にできません")
    current = store.get(contact_id)
    note = current.note + ("\n" if current.note else "") + f"返信要約: {clean_summary}"
    expected = current.updated_at if expected_updated_at is None else expected_updated_at
    return store.update(
        contact_id,
        {"note": note, "state": STATE_IN_PROGRESS},
        expected_updated_at=expected,
        actor=actor,
    )


def backup_rows(
    rows: Iterable[Mapping[str, Any]],
    *,
    ledger_name: str,
    destination: Path | None = None,
    keep: int = DEFAULT_BACKUP_KEEP,
    now: datetime | None = None,
) -> Path:
    """JSON Lines の控えを原子的に書き、deskly が作った古い世代だけを整理する。"""
    if not _LEDGER_NAME_RE.fullmatch(ledger_name):
        raise ValueError("台帳の名前が正しくありません")
    if keep < 1:
        raise ValueError("--keep は 1 以上にしてください")

    destination_root = destination if destination is not None else deskly_home() / "backups"
    destination_root.mkdir(parents=True, exist_ok=True)
    if not destination_root.is_dir():
        raise NotADirectoryError("控えの出力先はフォルダにしてください")
    directory = destination_root / _BACKUP_SUBDIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.is_dir():
        raise NotADirectoryError("deskly の控えフォルダを作れません")

    timestamp = (now or datetime.now(UTC)).astimezone(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{ledger_name}-{timestamp}.jsonl"
    sequence = 2
    while (
        (directory / filename).exists()
        or _backup_owner_marker_path(directory / filename).exists()
    ):
        filename = f"{ledger_name}-{timestamp}-{sequence:02d}.jsonl"
        sequence += 1
    target = directory / filename

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{filename}.",
            suffix=".tmp",
            dir=directory,
            delete=False,
        ) as stream:
            temp_path = Path(stream.name)
            for row in rows:
                stream.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True))
                stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    marker = _backup_owner_marker_path(target)
    with marker.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(
            _backup_owner_marker(target),
            stream,
            sort_keys=True,
            separators=(",", ":"),
        )
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())

    pattern = re.compile(
        rf"{re.escape(ledger_name)}-(\d{{8}}T\d{{12}}Z)(?:-(\d+))?\.jsonl"
    )
    generations: list[tuple[str, int, Path]] = []
    for path in directory.iterdir():
        if not path.is_file():
            continue
        match = pattern.fullmatch(path.name)
        if match is not None and _has_valid_backup_owner(path):
            generations.append((match.group(1), int(match.group(2) or "1"), path))
    generations.sort(key=lambda item: (item[0], item[1]), reverse=True)
    for _, _, old_path in generations[keep:]:
        old_path.unlink()
        _backup_owner_marker_path(old_path).unlink(missing_ok=True)
    return target


def export_text(contact: Contact) -> str:
    """コピペ用に本文だけを返す。欄名や ID は加えない。"""
    return contact.body


__all__ = [
    "CLI_ACTOR",
    "DEFAULT_BACKUP_KEEP",
    "add_draft",
    "backup_rows",
    "export_text",
    "record_reply",
    "set_contact_state",
]
