"""連絡の台帳から、案件ごとの「誰の番」を機械的に作る。"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import PurePosixPath

from deskly.config import IssuepostSettings
from deskly.issuepost import IssuepostCase
from deskly.ledgers import LedgerContact
from deskly.model import (
    STATE_DONE,
    STATE_DRAFT,
    STATE_IN_PROGRESS,
    STATE_NOT_SENT,
    STATE_SENT,
    STATE_WAITING,
    Contact,
)

_OPEN_STATES = frozenset({STATE_DRAFT, STATE_IN_PROGRESS, STATE_WAITING})
_OUR_TURN_STATES = frozenset({STATE_DRAFT, STATE_IN_PROGRESS})
_CLOSED_STATES = frozenset({STATE_SENT, STATE_DONE, STATE_NOT_SENT})


@dataclass(frozen=True)
class WaitingRow:
    """`deskly waiting` の 1 行。JSON 出力の欄もこの型で固定する。"""

    project: str | None
    turn: str | None
    due: str | None
    overdue: bool
    states: tuple[str, ...]
    summaries: tuple[str, ...]
    contact_ids: tuple[str, ...]
    count: int
    ledger_names: tuple[str, ...] = ()
    contact_refs: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        """安定した欄名で JSON にできる辞書を返す。"""
        return asdict(self)


@dataclass(frozen=True)
class CaseContactRef:
    """案件ビューに出す連絡参照。本文など連絡内容は含めない。"""

    contact_id: str
    project: str
    state: str
    due: str
    ledger_name: str | None = None


@dataclass(frozen=True)
class CaseRow:
    """issuepost の案件項目と、完全一致で結び付いた連絡参照。"""

    number: str
    title: str
    status: str
    approval_state: str
    promised_due: str | None
    hold_until: str | None
    turn: str
    linked_contacts: tuple[CaseContactRef, ...] = ()


@dataclass(frozen=True)
class CaseView:
    """案件一覧と、どの案件にも結び付かなかった連絡。"""

    cases: tuple[CaseRow, ...]
    unlinked_contacts: tuple[CaseContactRef, ...]


UNKNOWN_CASE_TURN = "unknown"


def _due_date(value: str) -> date | None:
    candidate = value.strip()
    try:
        parsed = date.fromisoformat(candidate)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == candidate else None


def _single_line(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _summary(contact: Contact) -> str:
    first_line = next((line for line in contact.body.splitlines() if line.strip()), "")
    if first_line:
        return _single_line(first_line)
    if contact.source_path:
        # 取り込み元の絶対パスは一覧に出さず、ファイル名の話題だけを使う。
        filename = PurePosixPath(contact.source_path.replace("\\", "/")).name
        return PurePosixPath(filename).stem
    return ""


def build_waiting_rows(
    contacts: Iterable[Contact | LedgerContact],
    *,
    today: date,
    include_all: bool = False,
    include_summaries: bool = True,
) -> list[WaitingRow]:
    """連絡を案件ごとにまとめて、番・最短期限・要約で並べる。

    案件が空の連絡は ID ごとに独立した行にする。既定では下書き・回答待ち・対応中だけを
    対象にし、``include_all`` のときだけ送信済み・完了・送らないも表示する。
    """
    groups: dict[tuple[str, str], list[tuple[Contact, str | None]]] = {}
    for item in contacts:
        if isinstance(item, LedgerContact):
            contact = item.contact
            ledger_name: str | None = item.ledger.name
        else:
            contact = item
            ledger_name = None
        if contact.state not in _OPEN_STATES | _CLOSED_STATES:
            continue
        if not include_all and contact.state not in _OPEN_STATES:
            continue
        project = contact.project.strip()
        contact_key = f"{ledger_name}:{contact.id}" if ledger_name else contact.id
        key = ("project", project) if project else ("contact", contact_key)
        groups.setdefault(key, []).append((contact, ledger_name))

    rows: list[WaitingRow] = []
    for (kind, key_value), grouped in groups.items():
        ordered = sorted(
            grouped,
            key=lambda item: (
                item[0].created_at,
                item[0].id,
                item[1] or "",
            ),
        )
        ordered_contacts = [item[0] for item in ordered]
        group_project: str | None = key_value if kind == "project" else None
        active = [contact for contact in ordered_contacts if contact.state in _OPEN_STATES]
        turn = (
            "こちら"
            if any(contact.state in _OUR_TURN_STATES for contact in active)
            else "相手"
            if active
            else None
        )

        dated = [
            (parsed, contact.due.strip())
            for contact in active
            if (parsed := _due_date(contact.due)) is not None
        ]
        due: str | None = None
        if dated:
            nearest, due = min(dated, key=lambda item: (item[0], item[1]))
            overdue = nearest < today
        else:
            overdue = False

        if include_summaries:
            summary_contacts = active or ordered_contacts
            summaries = tuple(
                dict.fromkeys(
                    summary for contact in summary_contacts if (summary := _summary(contact))
                )
            )
        else:
            summaries = ()
        rows.append(
            WaitingRow(
                project=group_project,
                turn=turn,
                due=due,
                overdue=overdue,
                states=tuple(dict.fromkeys(contact.state for contact in ordered_contacts)),
                summaries=summaries,
                contact_ids=tuple(contact.id for contact in ordered_contacts),
                count=len(ordered_contacts),
                ledger_names=tuple(
                    dict.fromkeys(name for _, name in ordered if name is not None)
                ),
                contact_refs=tuple(
                    f"{name}/{contact.id}" if name else contact.id
                    for contact, name in ordered
                ),
            )
        )

    max_date = date.max
    return sorted(
        rows,
        key=lambda row: (
            0 if row.turn == "こちら" else 1 if row.turn == "相手" else 2,
            0 if row.overdue else 1,
            _due_date(row.due or "") or max_date,
            (row.project or "").casefold(),
            row.contact_refs[0] if row.contact_refs else row.contact_ids[0],
        ),
    )


def _case_turn(case: IssuepostCase, settings: IssuepostSettings) -> str:
    # 承認の明示的な対応を優先し、未設定なら状態の対応だけを見る。
    approval_turn = settings.approval_turn_mapping.get(case.approval_state)
    if approval_turn is not None:
        return approval_turn
    return settings.status_turn_mapping.get(case.status, UNKNOWN_CASE_TURN)


def _case_contact_ref(item: Contact | LedgerContact) -> CaseContactRef:
    if isinstance(item, LedgerContact):
        contact = item.contact
        ledger_name: str | None = item.ledger.name
    else:
        contact = item
        ledger_name = None
    return CaseContactRef(
        contact_id=contact.id,
        project=contact.project,
        state=contact.state,
        due=contact.due,
        ledger_name=ledger_name,
    )


def build_case_view(
    cases: Iterable[IssuepostCase],
    contacts: Iterable[Contact | LedgerContact],
    settings: IssuepostSettings,
) -> CaseView:
    """案件と連絡を `Contact.project == case.number` の完全一致で結ぶ。"""
    case_items = tuple(cases)
    contact_refs = tuple(_case_contact_ref(item) for item in contacts)
    known_numbers = {case.number for case in case_items}
    linked_by_number: dict[str, list[CaseContactRef]] = {
        number: [] for number in known_numbers
    }
    unlinked: list[CaseContactRef] = []
    for contact in contact_refs:
        if contact.project in known_numbers:
            linked_by_number[contact.project].append(contact)
        else:
            unlinked.append(contact)

    rows = tuple(
        CaseRow(
            number=case.number,
            title=case.title,
            status=case.status,
            approval_state=case.approval_state,
            promised_due=case.promised_due,
            hold_until=case.hold_until,
            turn=_case_turn(case, settings),
            linked_contacts=tuple(linked_by_number[case.number]),
        )
        for case in case_items
    )
    return CaseView(cases=rows, unlinked_contacts=tuple(unlinked))
