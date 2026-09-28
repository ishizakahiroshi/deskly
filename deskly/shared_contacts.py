"""Permissioned, read-only views of explicitly linked company contacts."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from deskly.config import ConfigError, load_ledger_config
from deskly.contact_read_client import InternalContactReadClient
from deskly.model import Contact, validate_contact_id
from deskly.store import LedgerError, NotFoundError, get_contact_readonly
from deskly.workspace_model import WorkspaceError, bounded_text


def _linked_contacts(service: Any, project_id: str) -> list[dict[str, object]]:
    """Return only active contact references visible to this principal."""
    principal = service.principal()
    with service.store.connect() as db:
        service._active_member(db, principal)
        service._project_access(db, principal, project_id)
        project = service.store.read_entity(db, project_id, service.workspace_id)
        if project["type"] != "project" or project["archived"]:
            raise WorkspaceError("not_found", 404)
        rows = db.execute(
            "SELECT * FROM entities WHERE workspace_id=? AND project_id=? "
            "AND type='reference' AND archived=0 AND data IS NOT NULL ORDER BY id",
            (service.workspace_id, project_id),
        ).fetchall()
        references: list[dict[str, object]] = []
        for row in rows:
            reference = service.store.entity(row)
            if reference.get("kind") != "contact":
                continue
            source_id = str(reference.get("source_id", ""))
            try:
                source = service.store.read_entity(db, source_id, service.workspace_id)
            except WorkspaceError:
                continue
            if source["type"] != "source" or source["archived"] or source["adapter"] != "contact":
                continue
            if not service._source_access(db, principal, source_id):
                continue
            current_binding = str(source["binding"])
            # Multiple bindings are read independently by the caller.
            reference["_binding"] = current_binding
            references.append(reference)
    return references


def _configured_ledger(home: Path, binding: str) -> Any:
    config_path = home / "config.toml"
    if not config_path.is_file():
        if binding == "company":
            if os.environ.get("DESKLY_CONTACT_READ_TOKEN"):
                return SimpleNamespace(name="company", storage="server")
            from deskly.config import Config, LedgerDefinition

            return Config(ledgers=(LedgerDefinition(
                "company", "company", "local", path=home / "ledger" / "company.sqlite3",
            ),), default_ledger="company").ledger(binding)
        raise LookupError("not_connected")
    config = load_ledger_config(config_path)
    try:
        return config.ledger(binding)
    except ConfigError as exc:
        raise LookupError("not_connected") from exc


def list_contact_sources(home: Path, service: Any) -> dict[str, object]:
    principal = service.principal()
    with service.store.connect() as db:
        service._owner_access(db, principal)
        rows = db.execute(
            "SELECT * FROM entities WHERE workspace_id=? AND type='source' "
            "AND archived=0 ORDER BY id", (service.workspace_id,),
        ).fetchall()
        sources = []
        for row in rows:
            source = service.store.entity(row)
            if source["adapter"] == "contact":
                sources.append({key: source[key] for key in ("id", "label", "binding", "version")})
    return {"sources": sources}


def _replay_operation(service: Any, principal: Any,
                      request: Mapping[str, object]) -> object | None:
    canonical = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    request_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    with service.store.connect() as db:
        prior = db.execute(
            "SELECT request_hash, after_json, member_id FROM events "
            "WHERE workspace_id=? AND operation_id=?",
            (service.workspace_id, request["operation_id"]),
        ).fetchone()
    if prior is None:
        return None
    if prior["request_hash"] != request_hash or prior["member_id"] != principal.member_id:
        raise WorkspaceError("operation_conflict", 409)
    return json.loads(prior["after_json"])


def register_contact_source(home: Path, service: Any, *, label: object, binding: object,
                            operation_id: object, reason: object) -> dict[str, object]:
    from deskly.workspace_model import uuid_text

    principal = service.principal()
    # Establish owner authority before inspecting the requested binding or
    # resolving local configuration, so non-owners cannot probe source setup.
    with service.store.connect() as db:
        service._owner_access(db, principal)
    clean_binding = bounded_text(binding, required=True, limit=64)
    if clean_binding != "company":
        raise WorkspaceError("invalid_source", 404)
    clean_label = bounded_text(label, required=True, limit=120)
    clean_operation_id = uuid_text(operation_id)
    try:
        definition = _configured_ledger(home, clean_binding)
    except LookupError as exc:
        raise WorkspaceError("source_not_connected", 409) from exc
    except ConfigError as exc:
        raise WorkspaceError("source_configuration_invalid", 409) from exc
    if definition.storage not in {"local", "server"}:
        raise WorkspaceError("source_configuration_invalid", 409)
    source_id = str(uuid5(NAMESPACE_URL,
                          f"deskly:{service.workspace_id}:contact-source:{clean_binding}"))
    request = {
        "operation_id": clean_operation_id, "action": "create", "type": "source",
        "id": source_id, "project_id": None, "version": None,
        "data": {"label": clean_label, "adapter": "contact", "binding": clean_binding},
        "reason": bounded_text(reason, required=True, limit=240),
    }
    replay = _replay_operation(service, principal, request)
    if replay is not None:
        return replay  # type: ignore[return-value]
    with service.store.connect() as db:
        rows = db.execute(
            "SELECT * FROM entities WHERE workspace_id=? AND type='source' AND archived=0",
            (service.workspace_id,),
        ).fetchall()
        if any(source["adapter"] == "contact" and source["binding"] == clean_binding
               for source in (service.store.entity(row) for row in rows)):
            raise WorkspaceError("source_already_registered", 409)
    return service.apply(service.preview(request))


def link_project_contact(home: Path, service: Any, project_id: str, *, source_id: object,
                         contact_id: object, label: object, operation_id: object,
                         reason: object) -> dict[str, object]:
    from deskly.workspace_model import uuid_text

    principal = service.principal()
    clean_project_id = uuid_text(project_id)
    clean_source_id = uuid_text(source_id)
    clean_contact_id = validate_contact_id(contact_id)
    clean_label = bounded_text(label, required=True, limit=160)
    clean_operation_id = uuid_text(operation_id)
    with service.store.connect() as db:
        service._owner_access(db, principal)
        project = service.store.read_entity(db, clean_project_id, service.workspace_id)
        if project["type"] != "project" or project["archived"]:
            raise WorkspaceError("not_found", 404)
        source = service.store.read_entity(db, clean_source_id, service.workspace_id)
        if source["type"] != "source" or source["archived"] or source["adapter"] != "contact":
            raise WorkspaceError("invalid_source", 404)
    reference_id = str(uuid5(NAMESPACE_URL,
        f"deskly:{service.workspace_id}:{clean_project_id}:contact:{clean_source_id}:{clean_contact_id}"))
    request = {
        "operation_id": clean_operation_id, "action": "create", "type": "reference",
        "id": reference_id, "project_id": clean_project_id, "version": None,
        "data": {"kind": "contact", "target": clean_contact_id, "label": clean_label,
                 "linked_id": "", "source_id": clean_source_id},
        "reason": bounded_text(reason, required=True, limit=240),
    }
    replay = _replay_operation(service, principal, request)
    if replay is not None:
        return {"status": "linked", "reference": replay}
    with service.store.connect() as db:
        service._owner_access(db, principal)
        rows = db.execute(
            "SELECT * FROM entities WHERE workspace_id=? AND project_id=? "
            "AND type='reference' AND archived=0",
            (service.workspace_id, clean_project_id),
        ).fetchall()
        if any(reference["kind"] == "contact"
               and reference["source_id"] == clean_source_id
               and reference["target"] == clean_contact_id
               for reference in (service.store.entity(row) for row in rows)):
            raise WorkspaceError("contact_already_linked", 409)
    try:
        _contact(home, str(source["binding"]), clean_contact_id)
    except LookupError as exc:
        raise WorkspaceError("source_not_connected", 409) from exc
    except NotFoundError as exc:
        raise WorkspaceError("contact_not_found", 404) from exc
    except (ConfigError, LedgerError, OSError, ValueError) as exc:
        raise WorkspaceError("contact_unavailable", 503) from exc
    result = service.apply(service.preview(request))
    return {"status": "linked", "reference": result}


def _contact(home: Path, binding: str, contact_id: str) -> Contact:
    validate_contact_id(contact_id)
    if binding != "company":
        raise LookupError("not_connected")
    config_path = home / "config.toml"
    if config_path.is_file():
        config = load_ledger_config(config_path)
    else:
        token = os.environ.get("DESKLY_CONTACT_READ_TOKEN", "")
        if token:
            return InternalContactReadClient(token).get(contact_id)
        # A missing explicit config supports the documented company default only.
        from deskly.config import Config, LedgerDefinition

        config = Config(ledgers=(LedgerDefinition(
            "company", "company", "local", path=home / "ledger" / "company.sqlite3",
        ),), default_ledger="company")
    definition = next((item for item in config.ledgers if item.name == binding), None)
    if definition is None:
        raise LookupError("not_connected")
    if definition.storage == "local":
        if definition.path is None or not definition.path.is_file():
            raise LookupError("not_connected")
        return get_contact_readonly(definition.path, contact_id)
    if definition.storage == "server":
        # This capability is independent of the full-ledger token and the URL in
        # local config. The client always targets the fixed private Compose DNS.
        token = os.environ.get("DESKLY_CONTACT_READ_TOKEN", "")
        if not token:
            raise LookupError("not_connected")
        return InternalContactReadClient(token).get(contact_id)
    raise LookupError("not_connected")


def _summary(contact: Contact) -> dict[str, object]:
    return {
        "id": contact.id,
        "project": contact.project,
        "recipient": contact.recipient,
        "channel": contact.channel,
        "sent_at": contact.sent_at,
        "state": contact.state,
        "due": contact.due,
        "updated_at": contact.updated_at,
    }


def _detail(contact: Contact) -> dict[str, object]:
    return {
        **_summary(contact),
        "promise": contact.promise,
        "agreement": contact.agreement,
        "basis": contact.basis,
        "note": contact.note,
        "references": contact.references,
        "shared_url": contact.shared_url,
        "body": contact.body,
    }


def list_project_contacts(home: Path, service: Any, project_id: str) -> dict[str, object]:
    references = _linked_contacts(service, project_id)
    if not references:
        return {"project_id": project_id, "status": "no_references", "contacts": []}
    contacts: list[dict[str, object]] = []
    outcomes: set[str] = set()
    for reference in references:
        try:
            contact = _contact(home, str(reference["_binding"]), str(reference["target"]))
            if contact.sensitive:
                # Act as if this linked record were absent: no count or status
                # signal reveals the sensitive record to the caller.
                continue
            outcomes.add("connected")
            contacts.append(_summary(contact))
        except LookupError:
            outcomes.add("not_connected")
        except NotFoundError:
            outcomes.add("not_found")
        except (ConfigError, LedgerError, OSError, ValueError):
            outcomes.add("fetch_failed")
    if "fetch_failed" in outcomes:
        status = "fetch_failed"
    elif outcomes == {"not_found"}:
        status = "not_found"
    elif outcomes == {"not_connected"}:
        status = "not_connected"
    elif outcomes == {"connected"}:
        status = "connected"
    elif "connected" in outcomes:
        status = "partial"
    elif not outcomes:
        status = "no_references"
    else:
        status = "not_found"
    return {
        "project_id": project_id,
        "status": status,
        "contacts": contacts,
    }


def get_project_contact(home: Path, service: Any, project_id: str,
                        contact_id: str) -> dict[str, object]:
    references = _linked_contacts(service, project_id)
    matches = [reference for reference in references
               if reference.get("target") == contact_id]
    if not matches:
        raise WorkspaceError("not_found", 404)
    # Duplicate target references with different bindings are ambiguous and fail closed.
    bindings = {str(reference["_binding"]) for reference in matches}
    if len(bindings) != 1:
        raise WorkspaceError("not_found", 404)
    try:
        contact = _contact(home, next(iter(bindings)), contact_id)
    except LookupError:
        return {"project_id": project_id, "status": "not_connected", "contact": None}
    except NotFoundError as exc:
        raise WorkspaceError("not_found", 404) from exc
    except (ConfigError, LedgerError, OSError, ValueError) as exc:
        raise WorkspaceError("contact_unavailable", 503) from exc
    if contact.sensitive:
        raise WorkspaceError("not_found", 404)
    return {"project_id": project_id, "status": "connected", "contact": _detail(contact)}
