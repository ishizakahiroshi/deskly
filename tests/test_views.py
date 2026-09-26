from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from deskly.cli import main
from deskly.config import LEDGER_COMPANY, IssuepostSettings, ledger_path
from deskly.issuepost import IssuepostCase
from deskly.model import (
    STATE_DONE,
    STATE_DRAFT,
    STATE_IN_PROGRESS,
    STATE_NOT_SENT,
    STATE_SENT,
    STATE_WAITING,
    Contact,
)
from deskly.store import SqliteStore
from deskly.views import UNKNOWN_CASE_TURN, build_case_view, build_waiting_rows


def _contact(
    contact_id: str,
    *,
    state: str = STATE_WAITING,
    project: str = "Project A",
    due: str = "",
    body: str = "",
    source_path: str = "",
) -> Contact:
    return Contact(
        id=contact_id,
        state=state,
        project=project,
        due=due,
        body=body,
        source_path=source_path,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )


def _case(
    number: str,
    *,
    title: str = "Synthetic case title",
    status: str = "synthetic-unmapped-status",
    approval_state: str = "synthetic-unmapped-approval",
    promised_due: str | None = "2026-03-04",
    hold_until: str | None = "2026-03-09",
) -> IssuepostCase:
    return IssuepostCase(
        number=number,
        title=title,
        status=status,
        approval_state=approval_state,
        promised_due=promised_due,
        hold_until=hold_until,
    )


def test_case_view_links_only_exact_project_and_retains_unmatched_items() -> None:
    cases = (
        _case(
            "synthetic-case-1",
            title="Synthetic report title",
            status="synthetic-case-status",
            approval_state="synthetic-case-approval",
        ),
        _case("synthetic-case-2", title="Unlinked synthetic case"),
    )
    contacts = (
        _contact(
            "c-20260101-00000001",
            project="synthetic-case-1",
            body="Private synthetic contact body",
        ),
        _contact(
            "c-20260101-00000002",
            project="synthetic-case-1 ",
            body="Private synthetic unlinked body",
        ),
        _contact("c-20260101-00000003", project="Synthetic report title"),
        _contact("c-20260101-00000004", project="no matching case"),
    )
    settings = IssuepostSettings(url="https://example.test", token_env="TOKEN")

    view = build_case_view(cases, contacts, settings)

    assert len(view.cases) == 2
    assert [case.number for case in view.cases] == [
        "synthetic-case-1",
        "synthetic-case-2",
    ]
    assert [item.contact_id for item in view.cases[0].linked_contacts] == [
        "c-20260101-00000001"
    ]
    assert view.cases[1].linked_contacts == ()
    assert [item.contact_id for item in view.unlinked_contacts] == [
        "c-20260101-00000002",
        "c-20260101-00000003",
        "c-20260101-00000004",
    ]
    assert view.cases[0].promised_due == "2026-03-04"
    assert view.cases[0].hold_until == "2026-03-09"
    assert view.cases[0].promised_due != view.cases[0].hold_until
    assert view.cases[0].title == "Synthetic report title"
    assert view.cases[0].status == "synthetic-case-status"
    assert view.cases[0].approval_state == "synthetic-case-approval"
    assert view.cases[0].turn == UNKNOWN_CASE_TURN
    assert not hasattr(view.cases[0], "body")
    assert "Private synthetic contact body" not in repr(view)
    assert "Private synthetic unlinked body" not in repr(view)


def test_case_view_turn_uses_only_configured_mappings() -> None:
    cases = (
        _case(
            "synthetic-status-mapped",
            status="synthetic-status-id",
            approval_state="synthetic-approval-unmapped",
        ),
        _case(
            "synthetic-approval-mapped",
            status="synthetic-status-id",
            approval_state="synthetic-approval-id",
        ),
        _case("synthetic-unknown"),
    )
    settings = IssuepostSettings(
        url="https://example.test",
        token_env="TOKEN",
        status_turn_mapping={"synthetic-status-id": "こちら"},
        approval_turn_mapping={"synthetic-approval-id": "相手"},
    )

    view = build_case_view(cases, (), settings)

    assert [case.turn for case in view.cases] == ["こちら", "相手", UNKNOWN_CASE_TURN]


def test_waiting_groups_projects_and_keeps_unassigned_contacts_separate() -> None:
    rows = build_waiting_rows(
        [
            _contact("c-20260101-00000001", state=STATE_WAITING, due="2026-01-12"),
            _contact(
                "c-20260101-00000002",
                state=STATE_IN_PROGRESS,
                due="2026-01-05",
                body="確認する\n補足",
            ),
            _contact("c-20260101-00000003", state=STATE_DRAFT, project=" "),
            _contact("c-20260101-00000004", state=STATE_DRAFT, project=""),
        ],
        today=date(2026, 1, 6),
    )

    assert len(rows) == 3
    project = next(row for row in rows if row.project == "Project A")
    assert project.turn == "こちら"
    assert project.due == "2026-01-05"
    assert project.overdue is True
    assert project.states == (STATE_WAITING, STATE_IN_PROGRESS)
    assert project.summaries == ("確認する",)
    assert project.contact_ids == ("c-20260101-00000001", "c-20260101-00000002")
    assert project.count == 2
    unassigned = [row for row in rows if row.project is None]
    assert len(unassigned) == 2
    assert {row.contact_ids for row in unassigned} == {
        ("c-20260101-00000003",),
        ("c-20260101-00000004",),
    }


def test_waiting_excludes_closed_states_by_default_and_all_includes_them() -> None:
    contacts = [
        _contact("c-20260101-00000001", state=STATE_SENT),
        _contact("c-20260101-00000002", state=STATE_DONE),
        _contact("c-20260101-00000003", state=STATE_NOT_SENT),
    ]

    assert build_waiting_rows(contacts, today=date(2026, 1, 6)) == []
    rows = build_waiting_rows(contacts, today=date(2026, 1, 6), include_all=True)
    assert len(rows) == 1
    assert rows[0].turn is None
    assert rows[0].due is None
    assert rows[0].contact_ids == tuple(contact.id for contact in contacts)


def test_waiting_order_is_our_turn_then_overdue_then_nearest_due() -> None:
    rows = build_waiting_rows(
        [
            _contact("c-20260101-00000001", project="Overdue", due="2026-01-01"),
            _contact("c-20260101-00000002", project="Soon", due="2026-01-07"),
            _contact(
                "c-20260101-00000003",
                project="Our turn",
                state=STATE_DRAFT,
                due="2026-02-01",
            ),
            _contact("c-20260101-00000004", project="No due"),
        ],
        today=date(2026, 1, 6),
    )

    assert [row.project for row in rows] == ["Our turn", "Overdue", "Soon", "No due"]


def test_waiting_ignores_invalid_due_and_uses_filename_topic_fallback() -> None:
    rows = build_waiting_rows(
        [
            _contact(
                "c-20260101-00000001",
                due="not-a-date",
                source_path=r"synthetic\mail\sample-reply.txt",
            )
        ],
        today=date(2026, 1, 6),
    )

    assert rows[0].due is None
    assert rows[0].overdue is False
    assert rows[0].summaries == ("sample-reply",)


def test_waiting_can_skip_body_summary_computation(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_summary(_contact: Contact) -> str:
        raise AssertionError("summary computation must be skipped")

    monkeypatch.setattr("deskly.views._summary", fail_summary)

    rows = build_waiting_rows(
        [_contact("c-20260101-00000001", body="synthetic private line")],
        today=date(2026, 1, 6),
        include_summaries=False,
    )

    assert len(rows) == 1
    assert rows[0].summaries == ()


def test_waiting_json_schema_and_cli_date_are_stable(
    isolate_deskly_home: Path, capsys
) -> None:
    with SqliteStore(ledger_path(LEDGER_COMPANY)) as store:
        store.create(
            {
                "state": STATE_WAITING,
                "project": "Synthetic Project",
                "due": "2026-01-05",
                "body": "Synthetic next step\nmore detail",
            }
        )

    assert main(["waiting", "--json", "--today", "2026-01-06"]) == 0
    output = capsys.readouterr().out
    rows = json.loads(output)
    assert set(rows[0]) == {
        "project",
        "turn",
        "due",
        "overdue",
        "states",
        "summaries",
        "contact_ids",
        "count",
        "ledger_names",
        "contact_refs",
    }
    assert rows[0]["project"] == "Synthetic Project"
    assert rows[0]["turn"] == "相手"
    assert rows[0]["overdue"] is True
    assert rows[0]["states"] == [STATE_WAITING]
    assert rows[0]["summaries"] == ["Synthetic next step"]
    assert rows[0]["ledger_names"] == [LEDGER_COMPANY]
    assert rows[0]["contact_refs"][0].startswith(f"{LEDGER_COMPANY}/")

    with pytest.raises(SystemExit) as error:
        main(["waiting", "--today", "2026-1-6"])
    assert error.value.code == 2
    assert "YYYY-MM-DD" in capsys.readouterr().err


def test_waiting_on_missing_ledger_does_not_create_it(isolate_deskly_home: Path, capsys) -> None:
    path = ledger_path(LEDGER_COMPANY)

    assert main(["waiting"]) == 0

    assert capsys.readouterr().out == "表示する連絡はありません\n"
    assert not path.exists()


def test_waiting_reads_existing_ledger_without_changing_database(isolate_deskly_home: Path) -> None:
    path = ledger_path(LEDGER_COMPANY)
    with SqliteStore(path) as store:
        store.create({"state": STATE_WAITING, "project": "Synthetic Project"})
    before = path.read_bytes()

    assert main(["waiting", "--json"]) == 0

    assert path.read_bytes() == before
