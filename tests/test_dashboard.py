from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

import deskly.dashboard as dashboard
from deskly.case_service import CaseServiceResult
from deskly.config import ConfigError, LedgerDefinition
from deskly.ledgers import LedgerContact
from deskly.model import STATE_WAITING, Contact
from deskly.store import LedgerError
from deskly.views import CaseContactRef, CaseRow, CaseView
from deskly.worklog import WorklogDateBucket, WorklogProject, WorklogResult


def _contact(
    contact_id: str,
    *,
    project: str,
    body: str = "",
    source_path: str = "",
    due: str = "",
) -> Contact:
    return Contact(
        id=contact_id,
        state=STATE_WAITING,
        project=project,
        due=due,
        body=body,
        source_path=source_path,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )


def _case(number: str = "case-1", *, title: str = "Synthetic case") -> CaseRow:
    return CaseRow(
        number=number,
        title=title,
        status="synthetic-status",
        approval_state="synthetic-approval",
        promised_due="2026-10-01",
        hold_until="2026-10-05",
        turn="unknown",
        linked_contacts=(
            CaseContactRef(
                contact_id="private-contact-id",
                project=number,
                state=STATE_WAITING,
                due="2026-10-02",
                ledger_name="company",
            ),
        ),
    )


def _connected_case_result(*cases: CaseRow) -> CaseServiceResult:
    return CaseServiceResult(
        status="connected",
        view=CaseView(cases=cases, unlinked_contacts=()),
    )


def test_dashboard_projection_omits_body_ids_paths_and_tokens(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    entry = LedgerContact(
        ledger=LedgerDefinition(
            name="company",
            label="Synthetic ledger",
            storage="local",
            path=Path("synthetic.sqlite3"),
        ),
        contact=_contact(
            "private-contact-id",
            project="C:" + chr(92) + "synthetic" + chr(92) + "deskly",
            body="PRIVATE BODY SENTINEL\nsecond line",
            source_path="C:" + chr(92) + "synthetic" + chr(92) + "source.jsonl",
            due="2026-09-01",
        ),
    )
    monkeypatch.setattr(
        dashboard,
        "load_ledgers",
        lambda: SimpleNamespace(list_contacts=lambda: [entry]),
    )
    monkeypatch.setattr(
        dashboard,
        "_get_case_result",
        lambda: _connected_case_result(_case(title="<script>PRIVATE CASE TITLE</script>")),
    )
    monkeypatch.setattr(
        dashboard,
        "_worklog_result",
        lambda: WorklogResult(
            status="connected",
            range_from="2026-08-28",
            range_to="2026-09-26",
            projects=(
                WorklogProject(
                    project="deskly\u202e",
                    total_seconds=120,
                    by_date=(WorklogDateBucket(date="2026-09-26", seconds=120),),
                ),
            ),
        ),
    )

    payload = dashboard.get_dashboard_payload()
    serialized = json.dumps(payload, ensure_ascii=False)

    assert payload["waiting"]["rows"][0]["project"] == "deskly"
    assert payload["waiting"]["rows"][0]["count"] == 1
    assert payload["waiting"]["rows"][0]["ledger_names"] == ["company"]
    assert payload["cases"]["rows"][0]["linked_count"] == 1
    assert payload["cases"]["rows"][0]["title"] == "<script>PRIVATE CASE TITLE</script>"
    assert payload["worklog"]["projects"][0]["project"] == "deskly"
    for private_value in (
        "PRIVATE BODY SENTINEL",
        "private-contact-id",
        "private-source.txt",
        "synthetic-user",
        "DESKLY_API_TOKEN",
        "secret-value",
    ):
        assert private_value not in serialized


def test_dashboard_distinguishes_empty_disconnected_and_safe_errors(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    monkeypatch.setattr(
        dashboard,
        "load_ledgers",
        lambda: SimpleNamespace(list_contacts=lambda: []),
    )
    monkeypatch.setattr(
        dashboard,
        "_get_case_result",
        lambda: CaseServiceResult(status="not_connected", view=None),
    )
    monkeypatch.setattr(
        dashboard,
        "_worklog_result",
        lambda: WorklogResult(status="empty", range_from="2026-08-28", range_to="2026-09-26"),
    )

    payload = dashboard.get_dashboard_payload()

    assert payload["waiting"]["status"] == "connected"
    assert payload["waiting"]["rows"] == []
    assert payload["cases"]["status"] == "not_connected"
    assert payload["cases"]["rows"] == []
    assert payload["worklog"]["status"] == "empty"
    assert payload["worklog"]["projects"] == []

    def fail_config():
        raise ConfigError("synthetic private config path")

    monkeypatch.setattr(dashboard, "load_ledgers", fail_config)
    monkeypatch.setattr(
        dashboard,
        "_worklog_result",
        lambda: WorklogResult(status="execution_error", error="fixed safe error"),
    )
    error_payload = dashboard.get_dashboard_payload()
    error_json = json.dumps(error_payload, ensure_ascii=False)

    assert error_payload["waiting"]["status"] == "config_error"
    assert error_payload["waiting"]["error"] == dashboard._WAITING_ERRORS["config_error"]
    assert error_payload["worklog"]["error"] == dashboard._WORKLOG_ERRORS["execution_error"]
    assert "synthetic private config path" not in error_json


def test_dashboard_projection_reallowlists_service_status_and_error(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    monkeypatch.setattr(
        dashboard,
        "load_ledgers",
        lambda: SimpleNamespace(list_contacts=lambda: []),
    )
    monkeypatch.setattr(
        dashboard,
        "_get_case_result",
        lambda: CaseServiceResult(
            status="network_error",
            view=None,
            error="private path and token must not escape",
        ),
    )
    monkeypatch.setattr(
        dashboard,
        "_worklog_result",
        lambda: WorklogResult(
            status="execution_error",
            error="private command line and root path must not escape",
        ),
    )

    payload = dashboard.get_dashboard_payload()
    serialized = json.dumps(payload, ensure_ascii=False)

    assert payload["cases"]["status"] == "network_error"
    assert payload["cases"]["error"] == dashboard._CASE_ERRORS["network_error"]
    assert payload["worklog"]["status"] == "execution_error"
    assert payload["worklog"]["error"] == dashboard._WORKLOG_ERRORS["execution_error"]
    assert "private path" not in serialized
    assert "private command line" not in serialized


def test_notification_preview_fails_closed_instead_of_reporting_false_zero(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home

    def fail_read():
        raise LedgerError("synthetic private ledger path")

    monkeypatch.setattr(dashboard, "load_ledgers", fail_read)

    with pytest.raises(dashboard.NotificationPreviewUnavailable) as caught:
        dashboard.get_notification_preview_payload()

    assert str(caught.value) == "通知件数を読み込めませんでした。"
    assert "synthetic private ledger path" not in str(caught.value)


def test_notification_preview_contains_counts_only(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    entry = LedgerContact(
        ledger=LedgerDefinition(
            name="company",
            label="Synthetic ledger",
            storage="local",
            path=Path("synthetic.sqlite3"),
        ),
        contact=_contact(
            "private-contact-id",
            project="Synthetic project",
            body="PRIVATE BODY SENTINEL",
            due="2020-01-01",
        ),
    )
    monkeypatch.setattr(
        dashboard,
        "load_ledgers",
        lambda: SimpleNamespace(list_contacts=lambda: [entry]),
    )

    payload = dashboard.get_notification_preview_payload()

    assert set(payload) == {
        "preview_only",
        "as_of_utc",
        "waiting_count",
        "overdue_count",
    }
    assert payload["preview_only"] is True
    assert payload["waiting_count"] == 1
    assert payload["overdue_count"] == 1
    serialized = json.dumps(payload)
    assert "private-contact-id" not in serialized
    assert "PRIVATE BODY SENTINEL" not in serialized


def test_dashboard_limits_rows_and_marks_truncation(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    contacts = [
        _contact(
            f"c-20260101-{index:08x}",
            project=f"project-{index}",
        )
        for index in range(dashboard.MAX_WAITING_ROWS + 1)
    ]
    many_cases = tuple(
        _case(f"case-{index}") for index in range(dashboard.MAX_CASE_ROWS + 1)
    )
    monkeypatch.setattr(
        dashboard,
        "load_ledgers",
        lambda: SimpleNamespace(list_contacts=lambda: contacts),
    )
    monkeypatch.setattr(
        dashboard,
        "_get_case_result",
        lambda: _connected_case_result(*many_cases),
    )
    monkeypatch.setattr(
        dashboard,
        "_worklog_result",
        lambda: WorklogResult(status="not_configured"),
    )

    payload = dashboard.get_dashboard_payload()

    assert payload["waiting"]["total_count"] == dashboard.MAX_WAITING_ROWS + 1
    assert payload["waiting"]["truncated"] is True
    assert len(payload["waiting"]["rows"]) == dashboard.MAX_WAITING_ROWS
    assert payload["cases"]["total_count"] == dashboard.MAX_CASE_ROWS + 1
    assert payload["cases"]["truncated"] is True
    assert len(payload["cases"]["rows"]) == dashboard.MAX_CASE_ROWS


@pytest.mark.parametrize("failure", [ConfigError, LedgerError, OSError])
def test_waiting_error_does_not_expose_exception(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch, failure: type[Exception]
) -> None:
    del isolate_deskly_home

    def fail_read():
        raise failure("synthetic private path")

    monkeypatch.setattr(dashboard, "load_ledgers", fail_read)
    result = dashboard._waiting_section(date(2026, 9, 27))
    assert "synthetic private path" not in repr(result)
    assert result["error"] in set(dashboard._WAITING_ERRORS.values())
