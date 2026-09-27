"""Explicit, read-only source lookups for personal workspace references."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from deskly.config import Config, ConfigError, LedgerDefinition, load_ledger_config
from deskly.issuepost import IssuepostCase, IssuepostClient, IssuepostError
from deskly.ledgers import LedgerCollection
from deskly.store import LedgerError, NotFoundError, get_contact_readonly
from deskly.workspace_store import utc_now


def _config(home: Path) -> Config:
    path = home / "config.toml"
    if path.is_file():
        return load_ledger_config(path)
    return Config(
        ledgers=(LedgerDefinition("company", "company", "local",
                                  path=home / "ledger" / "company.sqlite3"),),
        default_ledger="company",
    )


def fetch_linked_references(
    home: Path, sources: list[dict[str, object]], references: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Fetch only explicitly linked IDs; never return contact body or credentials."""
    try:
        config = _config(home)
    except (ConfigError, OSError):
        config = None
    by_id = {source["id"]: source for source in sources if not source["archived"]}
    cases_by_source: dict[str, tuple[IssuepostCase, ...]] = {}
    results: list[dict[str, object]] = []
    for reference in references:
        source = by_id.get(reference["source_id"])
        result: dict[str, object] = {
            "reference_id": reference["id"], "source_id": reference["source_id"],
            "status": "not_connected", "attempted_at_utc": None,
            "as_of_utc": None, "data": None,
        }
        if source is None or config is None or source["adapter"] != reference["kind"]:
            results.append(result)
            continue
        try:
            if reference["kind"] == "contact":
                definition = next((entry for entry in config.ledgers
                                   if entry.name == source["binding"]), None)
                if definition is None:
                    results.append(result)
                    continue
                result["attempted_at_utc"] = utc_now()
                if definition.storage == "local" and definition.path is not None:
                    contact = get_contact_readonly(definition.path, str(reference["target"]))
                else:
                    with LedgerCollection(config).open_store(str(source["binding"])) as store:
                        contact = store.get(str(reference["target"]))
                result["status"] = "connected"
                result["as_of_utc"] = utc_now()
                result["data"] = {"id": contact.id, "state": contact.state,
                                  "due": contact.due, "updated_at": contact.updated_at}
            elif reference["kind"] == "external_case":
                if config.issuepost is None:
                    results.append(result)
                    continue
                result["attempted_at_utc"] = utc_now()
                source_id = str(source["id"])
                if source_id not in cases_by_source:
                    cases_by_source[source_id] = IssuepostClient(config.issuepost).list_cases()
                cases = cases_by_source[source_id]
                case = next((item for item in cases if item.number == reference["target"]), None)
                result["as_of_utc"] = utc_now()
                if case is None:
                    result["status"] = "not_found"
                else:
                    result["status"] = "connected"
                    result["data"] = {"number": case.number, "title": case.title,
                                      "status": case.status,
                                      "approval_state": case.approval_state,
                                      "promised_due": case.promised_due,
                                      "hold_until": case.hold_until}
        except NotFoundError:
            result["status"] = "not_found"
            result["as_of_utc"] = utc_now()
        except (LedgerError, IssuepostError, ConfigError, sqlite3.Error, OSError, ValueError):
            result["status"] = "fetch_failed"
        results.append(result)
    return results
