from __future__ import annotations

from pathlib import Path
from typing import NoReturn

import pytest

import deskly.case_service as case_service
from deskly.config import Config, ConfigError, IssuepostSettings, LedgerDefinition
from deskly.store import LedgerError


def test_configuration_error_is_a_safe_service_result(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home

    def fail_config() -> NoReturn:
        raise ConfigError("synthetic private config path")

    monkeypatch.setattr(case_service, "load_ledger_config", fail_config)

    result = case_service.get_case_result()

    assert result.to_dict() == {
        "status": "config_error",
        "view": None,
        "error": "Deskly の設定を読み込めませんでした",
    }
    assert "synthetic private config path" not in repr(result)


def test_ledger_error_is_a_safe_service_result(
    isolate_deskly_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del isolate_deskly_home
    config = Config(
        ledgers=(
            LedgerDefinition(
                name="company",
                label="Synthetic ledger",
                storage="local",
                path=Path("synthetic-private-ledger.sqlite3"),
            ),
        ),
        issuepost=IssuepostSettings(url="https://example.test", token_env="TOKEN"),
    )

    class EmptyIssuepostClient:
        def __init__(self, settings: IssuepostSettings) -> None:
            del settings

        def list_cases(self) -> tuple[()]:
            return ()

    class FailingLedgers:
        def list_contacts(self) -> list[object]:
            raise LedgerError("synthetic private ledger path")

    monkeypatch.setattr(case_service, "load_ledger_config", lambda: config)
    monkeypatch.setattr(case_service, "IssuepostClient", EmptyIssuepostClient)
    monkeypatch.setattr(case_service, "load_ledgers", lambda _config: FailingLedgers())

    result = case_service.get_case_result()

    assert result.to_dict() == {
        "status": "ledger_error",
        "view": None,
        "error": "Deskly の連絡台帳を読み込めませんでした",
    }
    assert "synthetic private ledger path" not in repr(result)
