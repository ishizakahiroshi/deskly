"""stdio MCP サーバー。MCP の依存はサーバー起動時だけ読み込む。"""

from __future__ import annotations

from datetime import date
from typing import Any

from deskly.case_service import get_case_result
from deskly.commands import (
    add_draft as create_draft,
)
from deskly.commands import (
    export_text as get_export_text,
)
from deskly.commands import (
    record_reply as save_reply,
)
from deskly.commands import (
    set_contact_state,
)
from deskly.ledgers import LedgerContact, load_ledgers, paginate_contact_entries
from deskly.model import STATE_DRAFT, normalize_field, validate_state
from deskly.shared_mode import require_local_mode
from deskly.views import build_waiting_rows

MCP_ACTOR = "mcp"
_DRAFT_FIELDS = (
    "project",
    "recipient",
    "channel",
    "sent_at",
    "due",
    "promise",
    "agreement",
    "sensitive",
    "basis",
    "note",
    "references",
    "shared_url",
    "body",
)


def _expected_version(expected_updated_at: str | None) -> str:
    if not expected_updated_at:
        raise ValueError("apply=true には expected_updated_at が必要です")
    return expected_updated_at


def _contact_result(entry: LedgerContact, *, applied: bool) -> dict[str, Any]:
    return {"applied": applied, "contact": entry.to_dict()}


def waiting(include_all: bool = False, today: str | None = None) -> list[dict[str, Any]]:
    """案件ごとの「誰の番？」一覧を返す。today は YYYY-MM-DD。"""
    if today is None:
        selected_day = date.today()
    else:
        try:
            selected_day = date.fromisoformat(today)
        except ValueError as exc:
            raise ValueError("today は YYYY-MM-DD で指定してください") from exc
        if selected_day.isoformat() != today:
            raise ValueError("today は YYYY-MM-DD で指定してください")
    rows = build_waiting_rows(
        load_ledgers().list_contacts(), today=selected_day, include_all=include_all
    )
    return [row.to_dict() for row in rows]


def list_cases() -> dict[str, object]:
    """Return the read-only issuepost case view and its connection status."""
    return get_case_result().to_dict()


def show_contact(contact_id: str) -> dict[str, Any]:
    """ID を指定して連絡 1 件を読む。"""
    return load_ledgers().find_contact(contact_id).to_dict()


def list_contacts(limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """Read one page of all contacts across configured ledgers."""
    return load_ledgers().page_contacts(limit=limit, offset=offset)


def search_contacts(
    query: str, limit: int = 20, offset: int = 0
) -> list[dict[str, Any]]:
    """案件・宛先・経路・約束・合意・根拠・補足・本文を部分一致で探す。"""
    ledgers = load_ledgers()
    matches = ledgers.search_contacts(query)
    page, _, _ = paginate_contact_entries(matches, limit=limit, offset=offset)
    return [entry.to_dict() for entry in page]


def add_draft(
    project: str | None = None,
    recipient: str | None = None,
    channel: str | None = None,
    sent_at: str | None = None,
    due: str | None = None,
    promise: str | None = None,
    agreement: str | None = None,
    sensitive: str | None = None,
    basis: str | None = None,
    note: str | None = None,
    references: str | None = None,
    shared_url: str | None = None,
    body: str | None = None,
    ledger_name: str | None = None,
    apply: bool = False,
    expected_updated_at: str | None = None,
) -> dict[str, Any]:
    """下書きをプレビューする。適用時は expected_updated_at='new' を渡す。"""
    fields = {
        name: normalize_field(name, value)
        for name, value in zip(
            _DRAFT_FIELDS,
            (
                project,
                recipient,
                channel,
                sent_at,
                due,
                promise,
                agreement,
                sensitive,
                basis,
                note,
                references,
                shared_url,
                body,
            ),
            strict=True,
        )
        if value is not None
    }
    ledgers = load_ledgers()
    definition = ledgers.definition(ledger_name) if ledger_name else ledgers.default
    if not apply:
        return {
            "applied": False,
            "expected_updated_at": "new",
            "preview": {
                "ledger": definition.name,
                "ledger_label": definition.label,
                "state": STATE_DRAFT,
                **fields,
            },
        }
    if expected_updated_at != "new":
        raise ValueError("新しい連絡の適用時は expected_updated_at='new' が必要です")
    with ledgers.open_store(definition.name) as store:
        contact = create_draft(store, fields, actor=MCP_ACTOR)
    return _contact_result(LedgerContact(definition, contact), applied=True)


def set_state(
    contact_id: str,
    state: str,
    apply: bool = False,
    expected_updated_at: str | None = None,
) -> dict[str, Any]:
    """状態変更をプレビューする。適用時は表示された更新日時を渡す。"""
    selected_state = validate_state(state)
    ledgers = load_ledgers()
    entry = ledgers.find_contact(contact_id)
    current = entry.contact
    if not apply:
        return {
            "applied": False,
            "expected_updated_at": current.updated_at,
            "preview": {
                "contact_id": current.id,
                "ledger": entry.ledger.name,
                "from_state": current.state,
                "to_state": selected_state,
            },
        }
    expected = _expected_version(expected_updated_at)
    with ledgers.open_store(entry.ledger.name) as store:
        contact = set_contact_state(
            store,
            contact_id,
            selected_state,
            expected_updated_at=expected,
            actor=MCP_ACTOR,
        )
    return _contact_result(LedgerContact(entry.ledger, contact), applied=True)


def record_reply(
    contact_id: str,
    summary: str,
    apply: bool = False,
    expected_updated_at: str | None = None,
) -> dict[str, Any]:
    """返信要約をプレビューし、適用時は対応中へ移す。"""
    clean_summary = summary.strip()
    if not clean_summary:
        raise ValueError("返信の要約を空にできません")
    ledgers = load_ledgers()
    entry = ledgers.find_contact(contact_id)
    current = entry.contact
    if not apply:
        return {
            "applied": False,
            "expected_updated_at": current.updated_at,
            "preview": {
                "contact_id": current.id,
                "ledger": entry.ledger.name,
                "state": "対応中",
                "reply_summary": clean_summary,
            },
        }
    expected = _expected_version(expected_updated_at)
    with ledgers.open_store(entry.ledger.name) as store:
        contact = save_reply(
            store,
            contact_id,
            clean_summary,
            expected_updated_at=expected,
            actor=MCP_ACTOR,
        )
    return _contact_result(LedgerContact(entry.ledger, contact), applied=True)


def export_text(contact_id: str) -> str:
    """本文だけを返す。"""
    return get_export_text(load_ledgers().find_contact(contact_id).contact)


def create_server() -> Any:
    """FastMCP を遅延 import して tool を登録する。"""
    require_local_mode()
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("deskly")
    for name, description, function in (
        ("waiting", "案件ごとの現在の連絡待ち一覧", waiting),
        ("list_contacts", "全台帳の連絡をページ単位で一覧する読み取り専用の道具", list_contacts),
        ("list_cases", "issuepost の案件と関連する連絡を読み取り専用で一覧する", list_cases),
        ("show_contact", "連絡 1 件の全欄を読む", show_contact),
        ("search_contacts", "連絡を部分一致で検索し offset で続きも取得する", search_contacts),
        ("add_draft", "下書きをプレビューまたは承認付きで作成する", add_draft),
        ("set_state", "状態変更をプレビューまたは承認付きで適用する", set_state),
        ("record_reply", "返信要約をプレビューまたは承認付きで記録する", record_reply),
        ("export_text", "連絡の本文だけを返す", export_text),
    ):
        server.tool(name=name, description=description)(function)
    return server


def run_stdio_server() -> None:
    """MCP stdio transport を開始する。"""
    create_server().run(transport="stdio")


__all__ = [
    "add_draft",
    "create_server",
    "export_text",
    "list_contacts",
    "list_cases",
    "record_reply",
    "run_stdio_server",
    "search_contacts",
    "set_state",
    "show_contact",
    "waiting",
]
