"""Safe, read-only projections for the local Deskly dashboard."""

from __future__ import annotations

import sqlite3
import unicodedata
from datetime import UTC, date, datetime
from pathlib import PurePosixPath, PureWindowsPath

from deskly.case_service import CaseServiceResult, get_case_result
from deskly.config import ConfigError
from deskly.ledgers import load_ledgers
from deskly.store import LedgerError
from deskly.views import CaseRow, WaitingRow, build_waiting_rows

MAX_WAITING_ROWS = 200
MAX_CASE_ROWS = 500
MAX_WORKLOG_PROJECTS = 500
MAX_TEXT_LENGTH = 512

_WAITING_ERRORS = {
    "config_error": "Deskly の設定を読み込めませんでした。",
    "ledger_error": "Deskly の連絡台帳を読み込めませんでした。",
}
_CASE_ERRORS = {
    "auth_error": "issuepost の認証に失敗しました。",
    "network_error": "issuepost に接続できませんでした。",
    "schema_error": "issuepost の応答形式を確認できませんでした。",
    "config_error": _WAITING_ERRORS["config_error"],
    "ledger_error": _WAITING_ERRORS["ledger_error"],
}
_WORKLOG_ERRORS = {
    "execution_error": "工数データを取得できませんでした。",
    "timeout": "工数集計が時間内に完了しませんでした。",
    "schema_error": "工数集計の形式を確認できませんでした。",
}
_CASE_STATUSES = frozenset({"not_connected", "connected", *_CASE_ERRORS})
_WORKLOG_STATUSES = frozenset(
    {"not_configured", "connected", "empty", *_WORKLOG_ERRORS}
)


class NotificationPreviewUnavailable(RuntimeError):
    """Raised when preview counts cannot be read, avoiding a false zero result."""


def _safe_text(value: object, *, fallback: str = "", limit: int = MAX_TEXT_LENGTH) -> str:
    if not isinstance(value, str):
        return fallback
    visible = "".join(
        character
        for character in value
        if unicodedata.category(character) not in {"Cc", "Cf", "Cs", "Zl", "Zp"}
    )
    return " ".join(visible.split())[:limit].strip() or fallback


def _safe_project(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    candidate = value.strip()
    windows_path = PureWindowsPath(candidate)
    if windows_path.is_absolute():
        candidate = windows_path.name
    elif PurePosixPath(candidate).is_absolute():
        candidate = PurePosixPath(candidate).name
    return _safe_text(candidate, fallback="（案件名なし）", limit=MAX_TEXT_LENGTH)


def _safe_optional_value(value: str | None, *, limit: int = 64) -> str | None:
    if value is None:
        return None
    return _safe_text(value, limit=limit) or None


def _waiting_section(today: date) -> dict[str, object]:
    try:
        contacts = load_ledgers().list_contacts()
    except ConfigError:
        return _empty_waiting_section("config_error")
    except (LedgerError, sqlite3.Error, OSError):
        return _empty_waiting_section("ledger_error")

    rows = build_waiting_rows(contacts, today=today, include_summaries=False)
    total_count = len(rows)
    selected = rows[:MAX_WAITING_ROWS]
    return {
        "status": "connected",
        "error": None,
        "total_count": total_count,
        "truncated": total_count > MAX_WAITING_ROWS,
        "count": sum(row.count for row in rows),
        "overdue_count": sum(1 for row in rows if row.overdue),
        "rows": [_waiting_row(row) for row in selected],
    }


def _empty_waiting_section(status: str) -> dict[str, object]:
    return {
        "status": status,
        "error": _WAITING_ERRORS[status],
        "total_count": 0,
        "truncated": False,
        "count": 0,
        "overdue_count": 0,
        "rows": [],
    }


def _waiting_row(row: WaitingRow) -> dict[str, object]:
    ledger_names = tuple(
        dict.fromkeys(
            label
            for raw_label in row.ledger_names
            if (label := _safe_text(raw_label, limit=MAX_TEXT_LENGTH))
        )
    )
    return {
        "project": _safe_project(row.project),
        "turn": _safe_text(row.turn) if row.turn is not None else None,
        "due": row.due,
        "overdue": row.overdue,
        "states": [_safe_text(state) for state in row.states],
        "count": row.count,
        "ledger_names": list(ledger_names),
    }


def _case_section(result: CaseServiceResult) -> dict[str, object]:
    status = result.status if result.status in _CASE_STATUSES else "schema_error"
    if status != "connected":
        return {
            "status": status,
            "error": _CASE_ERRORS.get(status),
            "total_count": 0,
            "truncated": False,
            "count": 0,
            "unlinked_count": 0,
            "rows": [],
        }
    view = result.view
    if view is None:
        return {
            "status": "schema_error",
            "error": "案件データを表示できませんでした。",
            "total_count": 0,
            "truncated": False,
            "count": 0,
            "unlinked_count": 0,
            "rows": [],
        }

    total_count = len(view.cases)
    return {
        "status": "connected",
        "error": None,
        "total_count": total_count,
        "truncated": total_count > MAX_CASE_ROWS,
        "count": total_count,
        "unlinked_count": len(view.unlinked_contacts),
        "rows": [_case_row(case) for case in view.cases[:MAX_CASE_ROWS]],
    }


def _case_row(case: CaseRow) -> dict[str, object]:
    return {
        "number": _safe_text(case.number),
        "title": _safe_text(case.title),
        "status": _safe_text(case.status),
        "approval_state": _safe_text(case.approval_state),
        "promised_due": _safe_optional_value(case.promised_due),
        "hold_until": _safe_optional_value(case.hold_until),
        "turn": _safe_text(case.turn),
        "linked_count": len(case.linked_contacts),
    }


def _worklog_result():
    from deskly.worklog import get_worklog_result

    return get_worklog_result()


def _worklog_section() -> dict[str, object]:
    try:
        result = _worklog_result()
    except Exception:
        return {
            "status": "execution_error",
            "error": "工数データを取得できませんでした。",
            "range_from": None,
            "range_to": None,
            "total_count": 0,
            "truncated": False,
            "projects": [],
        }

    status = result.status if result.status in _WORKLOG_STATUSES else "schema_error"
    if status not in {"connected", "empty"}:
        return {
            "status": status,
            "error": _WORKLOG_ERRORS.get(status),
            "range_from": None,
            "range_to": None,
            "total_count": 0,
            "truncated": False,
            "projects": [],
        }

    projects = result.projects
    return {
        "status": status,
        "error": None,
        "range_from": result.range_from,
        "range_to": result.range_to,
        "total_count": len(projects),
        "truncated": len(projects) > MAX_WORKLOG_PROJECTS,
        "projects": [
            {
                "project": _safe_text(item.project, fallback="(unknown)"),
                "total_seconds": item.total_seconds,
                "by_date": [
                    {"date": bucket.date, "seconds": bucket.seconds}
                    for bucket in item.by_date
                ],
            }
            for item in projects[:MAX_WORKLOG_PROJECTS]
        ],
    }


def _get_case_result() -> CaseServiceResult:
    return get_case_result()


def _as_of_utc() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_dashboard_payload() -> dict[str, object]:
    """Read source systems and return only allowlisted, display-safe dashboard fields."""
    now = _as_of_utc()
    waiting = _waiting_section(today=date.today())
    try:
        case_result = _get_case_result()
    except Exception:
        case_result = CaseServiceResult(
            status="network_error",
            view=None,
            error="案件データを取得できませんでした。",
        )
    return {
        "generated_at_utc": now,
        "waiting": waiting,
        "cases": _case_section(case_result),
        "worklog": _worklog_section(),
    }


def get_notification_preview_payload() -> dict[str, object]:
    """Return count-only, on-demand preview data; no notification is sent or scheduled."""
    now = _as_of_utc()
    waiting = _waiting_section(today=date.today())
    if waiting["status"] != "connected":
        raise NotificationPreviewUnavailable("通知件数を読み込めませんでした。")
    return {
        "preview_only": True,
        "as_of_utc": now,
        "waiting_count": waiting["count"],
        "overdue_count": waiting["overdue_count"],
    }


__all__ = ["get_dashboard_payload", "get_notification_preview_payload"]
