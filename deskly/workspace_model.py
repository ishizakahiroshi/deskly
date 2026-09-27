"""Stable identifiers and bounded inputs for the personal workspace."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from uuid import UUID

PROJECT_STATES = frozenset({"未確認", "進行中", "保留", "終了"})
ITEM_STATES = frozenset({"未確認", "進行中", "待ち", "完了", "保留"})
KINDS = frozenset({"開発", "営業", "運営"})
ENTITY_TYPES = frozenset({"project", "milestone", "work_item", "reference", "source"})


class WorkspaceError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class Principal:
    workspace_id: str
    member_id: str
    role: str
    active: bool


def uuid_text(value: object) -> str:
    if not isinstance(value, str):
        raise WorkspaceError("invalid_id")
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise WorkspaceError("invalid_id") from exc
    if str(parsed) != value:
        raise WorkspaceError("invalid_id")
    return value


def bounded_text(value: object, *, required: bool = False, limit: int = 500) -> str:
    if not isinstance(value, str) or len(value) > limit or any(
        ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value
    ):
        raise WorkspaceError("invalid_field")
    clean = value.strip()
    if required and not clean:
        raise WorkspaceError("required_field")
    return clean


def optional_date(value: object) -> str:
    text = bounded_text(value, limit=10)
    if text:
        try:
            if date.fromisoformat(text).isoformat() != text:
                raise ValueError("noncanonical date")
        except ValueError as exc:
            raise WorkspaceError("invalid_date") from exc
    return text


def reference_target(value: object, kind: str) -> str:
    target = bounded_text(value, required=True, limit=500)
    if kind == "https":
        from urllib.parse import urlsplit

        parsed = urlsplit(target)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment or parsed.query
            or not re.fullmatch(r"[A-Za-z0-9.-]+", parsed.hostname)
        ):
            raise WorkspaceError("invalid_reference")
    elif kind == "md":
        if (target.startswith(("/", "\\")) or ".." in target.split("/")
            or "\\" in target or any(char in target for char in ":?#")
            or not target.endswith(".md")):
            raise WorkspaceError("invalid_reference")
    else:
        raise WorkspaceError("invalid_reference")
    return target
