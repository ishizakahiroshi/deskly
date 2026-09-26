"""Shared read-only service for the CLI and MCP case view."""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass
from typing import Literal

from deskly.config import ConfigError, load_ledger_config
from deskly.issuepost import (
    IssuepostAuthError,
    IssuepostClient,
    IssuepostNetworkError,
    IssuepostSchemaError,
)
from deskly.ledgers import load_ledgers
from deskly.store import LedgerError
from deskly.views import CaseView, build_case_view

CaseResultStatus = Literal[
    "not_connected",
    "connected",
    "auth_error",
    "network_error",
    "schema_error",
    "config_error",
    "ledger_error",
]


@dataclass(frozen=True)
class CaseServiceResult:
    """A safe result envelope shared by CLI JSON and the MCP read tool."""

    status: CaseResultStatus
    view: CaseView | None
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        """Return the stable transport shape without exception or secret details."""
        return asdict(self)


_ERROR_MESSAGES = {
    "auth_error": "issuepost の認証に失敗しました",
    "network_error": "issuepost に接続できませんでした",
    "schema_error": "issuepost の応答形式が正しくありません",
    "config_error": "Deskly の設定を読み込めませんでした",
    "ledger_error": "Deskly の連絡台帳を読み込めませんでした",
}


def get_case_result() -> CaseServiceResult:
    """Read issuepost cases and Deskly contacts without writing either system."""
    try:
        config = load_ledger_config()
    except (ConfigError, OSError):
        return CaseServiceResult(
            status="config_error", view=None, error=_ERROR_MESSAGES["config_error"]
        )
    settings = config.issuepost
    if settings is None:
        return CaseServiceResult(status="not_connected", view=None)

    try:
        cases = IssuepostClient(settings).list_cases()
    except IssuepostAuthError:
        return CaseServiceResult(
            status="auth_error", view=None, error=_ERROR_MESSAGES["auth_error"]
        )
    except IssuepostNetworkError:
        return CaseServiceResult(
            status="network_error", view=None, error=_ERROR_MESSAGES["network_error"]
        )
    except IssuepostSchemaError:
        return CaseServiceResult(
            status="schema_error", view=None, error=_ERROR_MESSAGES["schema_error"]
        )

    try:
        contacts = load_ledgers(config).list_contacts() if config.ledgers else []
    except ConfigError:
        return CaseServiceResult(
            status="config_error", view=None, error=_ERROR_MESSAGES["config_error"]
        )
    except (LedgerError, sqlite3.Error, OSError):
        return CaseServiceResult(
            status="ledger_error", view=None, error=_ERROR_MESSAGES["ledger_error"]
        )
    view = build_case_view(cases, contacts, settings)
    return CaseServiceResult(status="connected", view=view)


__all__ = ["CaseServiceResult", "CaseResultStatus", "get_case_result"]
