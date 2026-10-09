//! Owner-only contact operations. Full API records never cross the display boundary.
use deskly_types::{
    ContactActionCommand, ContactActionPreview, ContactBody, ContactCollection, ContactHistory,
    ContactId, ContactRecord, ContactState, ContactWaitingCollection,
    ContactWaitingRowPropertiesDueOneOf0, UtcTimestamp,
};
use serde_json::{json, Map, Value};

use crate::client::{valid_id, Client, Error};

// Presentation allowlist, not a second domain model. Free-text content and private
// import metadata are deliberately absent, including reply summaries in `note`.
const PUBLIC_FIELDS: &[&str] = &[
    "id",
    "state",
    "state_inferred",
    "project",
    "recipient",
    "channel",
    "sent_at",
    "due",
    "created_at",
    "updated_at",
];
fn metadata(value: &Value) -> Value {
    Value::Object(
        value
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| PUBLIC_FIELDS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}
fn record(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json!({"workspace_id":value["workspace_id"],"source_id":value["source_id"],
        "version":value["version"],"contact":metadata(&value["contact"])})
}
fn id(value: &str) -> Result<(), Error> {
    value
        .parse::<ContactId>()
        .map(|_| ())
        .map_err(|_| Error::validation())
}
fn python_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || matches!(c, '\u{001c}'..='\u{001f}'))
}
fn validate_scope(
    value: &Value,
    workspace: &str,
    source: &str,
    contact: Option<&str>,
) -> Result<(), Error> {
    if value["workspace_id"] != workspace
        || value["source_id"] != source
        || contact.is_some_and(|id| value["contact"]["id"] != id)
    {
        return Err(Error::response());
    }
    Ok(())
}

impl Client {
    fn contact_base(workspace: &str, source: &str) -> Result<String, Error> {
        valid_id(source)?;
        Ok(format!("{}/sources/{source}", Self::base(workspace)?))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn contact_read(
        &self,
        operation: &str,
        workspace: &str,
        source: &str,
        contact: Option<&str>,
        states: &[String],
        project: Option<&str>,
        query: Option<&str>,
        include_all: bool,
        today: Option<&str>,
    ) -> Result<Value, Error> {
        let base = Self::contact_base(workspace, source)?;
        if let Some(contact) = contact {
            id(contact)?;
        }
        for state in states {
            state
                .parse::<ContactState>()
                .map_err(|_| Error::validation())?;
        }
        if let Some(day) = today {
            day.parse::<ContactWaitingRowPropertiesDueOneOf0>()
                .map_err(|_| Error::validation())?;
        }
        // Locally supplied values must not reflect credentials through aggregated output.
        self.safe(&json!({"project":project,"query":query}))?;
        let mut params = url::form_urlencoded::Serializer::new(String::new());
        let result = match operation {
            "list" | "search" => {
                if contact.is_some() || today.is_some() || include_all {
                    return Err(Error::validation());
                }
                for state in states {
                    params.append_pair("state", state);
                }
                if let Some(project) = project {
                    params.append_pair("project", project);
                }
                if operation == "search" || query.is_some() {
                    let query = query
                        .filter(|q| !python_trim(q).is_empty())
                        .ok_or_else(Error::validation)?;
                    params.append_pair("q", query);
                }
                let query = params.finish();
                let path = format!(
                    "{base}/contacts{}",
                    if query.is_empty() {
                        String::new()
                    } else {
                        format!("?{query}")
                    }
                );
                let rows = self
                    .request::<ContactCollection>(&path, None)
                    .map_err(Error::contact)?;
                let rows = rows["items"].as_array().ok_or_else(Error::response)?;
                let mut items = Vec::new();
                for row in rows {
                    validate_scope(row, workspace, source, None)?;
                    items.push(record(row));
                }
                json!({"items":items})
            }
            "waiting" | "cases" => {
                if contact.is_some() || !states.is_empty() || project.is_some() || query.is_some() {
                    return Err(Error::validation());
                }
                params.append_pair("include_summaries", "false");
                params.append_pair(
                    "include_all",
                    if include_all || operation == "cases" {
                        "true"
                    } else {
                        "false"
                    },
                );
                if let Some(day) = today {
                    params.append_pair("today", day);
                }
                let rows = self
                    .request::<ContactWaitingCollection>(
                        &format!("{base}/waiting?{}", params.finish()),
                        None,
                    )
                    .map_err(Error::contact)?;
                let mut items = rows["items"]
                    .as_array()
                    .ok_or_else(Error::response)?
                    .clone();
                for row in &mut items {
                    // Even a server that ignores include_summaries must not disclose body excerpts.
                    row["summaries"] = json!([]);
                    row["ledger_names"] = json!([]);
                    row["contact_refs"] = row["contact_ids"].clone();
                    let allowed = [
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
                    ];
                    row.as_object_mut()
                        .ok_or_else(Error::response)?
                        .retain(|key, _| allowed.contains(&key.as_str()));
                }
                json!({"items":items})
            }
            "detail" | "history" | "body" | "export-text" => {
                if !states.is_empty()
                    || project.is_some()
                    || query.is_some()
                    || today.is_some()
                    || include_all
                {
                    return Err(Error::validation());
                }
                let contact = contact.ok_or_else(Error::validation)?;
                let path = format!("{base}/contacts/{contact}");
                match operation {
                    "body" | "export-text" => {
                        let result = self
                            .request::<ContactBody>(&format!("{path}/body"), None)
                            .map_err(Error::contact)?;
                        json!({"body":result["body"]})
                    }
                    "detail" => {
                        let row = self
                            .request::<ContactRecord>(&path, None)
                            .map_err(Error::contact)?;
                        validate_scope(&row, workspace, source, Some(contact))?;
                        record(&row)
                    }
                    _ => {
                        let result = self
                            .request::<ContactHistory>(&format!("{path}/history"), None)
                            .map_err(Error::contact)?;
                        let mut events = Vec::new();
                        for event in result["events"].as_array().ok_or_else(Error::response)? {
                            if event["workspace_id"] != workspace
                                || event["source_id"] != source
                                || event["contact_id"] != contact
                            {
                                return Err(Error::response());
                            }
                            validate_scope(&event["after"], workspace, source, Some(contact))?;
                            if !event["before"].is_null() {
                                validate_scope(&event["before"], workspace, source, Some(contact))?;
                            }
                            let mut changes = Vec::new();
                            for change in event["changes"].as_array().ok_or_else(Error::response)? {
                                let field = change["field"].as_str().ok_or_else(Error::response)?;
                                if !PUBLIC_FIELDS.contains(&field) {
                                    continue;
                                }
                                let before = event["before"]["contact"].get(field);
                                let after = event["after"]["contact"].get(field);
                                if change["before_present"] != before.is_some()
                                    || change["after_present"] != after.is_some()
                                    || change["before"] != before.cloned().unwrap_or(Value::Null)
                                    || change["after"] != after.cloned().unwrap_or(Value::Null)
                                {
                                    return Err(Error::response());
                                }
                                changes.push(json!({"field":field,"before_present":before.is_some(),"after_present":after.is_some(),"before":before,"after":after}));
                            }
                            events.push(json!({"operation_id":event["operation_id"],"workspace_id":workspace,"source_id":source,"contact_id":contact,
                                "requester_member_id":event["requester_member_id"],"at_utc":event["at_utc"],"changes":changes,
                                "before":record(&event["before"]),"after":record(&event["after"])}));
                        }
                        json!({"events":events})
                    }
                }
            }
            _ => return Err(Error::validation()),
        };
        self.safe(&result)?;
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn contact_write(
        &self,
        workspace: &str,
        source: &str,
        action: &str,
        contact: Option<&str>,
        version: Option<u64>,
        mut data: Value,
        reason: &str,
        apply: bool,
    ) -> Result<Value, Error> {
        let base = Self::contact_base(workspace, source)?;
        if let Some(contact) = contact {
            id(contact)?;
        }
        if !matches!(action, "add_draft" | "set_state" | "record_reply")
            || action == "add_draft" && version.is_some()
            || action != "add_draft" && (contact.is_none() || version.is_none())
        {
            return Err(Error::validation());
        }
        if action == "record_reply" {
            let summary = data["summary"].as_str().ok_or_else(Error::validation)?;
            data["summary"] = json!(python_trim(summary));
        }
        let request = json!({"operation_id":uuid::Uuid::new_v4().to_string(),"action":action,
            "contact_id":contact,"expected_version":version,"data":data,"reason":reason.trim()});
        // Deserializing the generated union validates the six states, data keys,
        // contact IDs, required fields and versions before any HTTP request.
        let typed: ContactActionCommand =
            serde_json::from_value(request).map_err(|_| Error::validation())?;
        let request = serde_json::to_value(typed).map_err(|_| Error::validation())?;
        self.safe(&request)?;
        let preview = self
            .request::<ContactActionPreview>(
                &format!("{base}/contacts/commands/preview"),
                Some(&request),
            )
            .map_err(Error::contact)?;
        let mut expected = request.clone();
        if action == "add_draft" && contact.is_none() {
            expected["contact_id"] = preview["request"]["contact_id"].clone();
        }
        if preview["request"] != expected {
            return Err(Error::response());
        }
        check_preview(&preview, workspace, source)?;
        if apply {
            // Send the original, unredacted API value, never the display projection.
            let result = self
                .request::<ContactRecord>(
                    &format!("{base}/contacts/commands/apply"),
                    Some(&preview),
                )
                .map_err(Error::contact)?;
            validate_scope(
                &result,
                workspace,
                source,
                preview["request"]["contact_id"].as_str(),
            )?;
            if result != preview["after"] {
                return Err(Error::response());
            }
            Ok(record(&result))
        } else {
            let mut request = preview["request"].clone();
            request["data"] = metadata(&request["data"]);
            // Reason can be user-supplied private content, and is not needed for safe metadata display.
            request
                .as_object_mut()
                .ok_or_else(Error::response)?
                .remove("reason");
            Ok(
                json!({"request":request,"before":record(&preview["before"]),"after":record(&preview["after"]),"preview_token":preview["preview_token"]}),
            )
        }
    }
}

/// Reject unexpected changes as well as a changed command. Timestamp generation
/// remains the API's job; no local snapshot or unsigned preview is ever applied.
fn check_preview(preview: &Value, workspace: &str, source: &str) -> Result<(), Error> {
    let request = &preview["request"];
    let id = request["contact_id"].as_str().ok_or_else(Error::response)?;
    let after = &preview["after"];
    validate_scope(after, workspace, source, Some(id))?;
    let action = request["action"].as_str().ok_or_else(Error::response)?;
    if action == "add_draft" || after != &preview["before"] {
        serde_json::from_value::<UtcTimestamp>(after["contact"]["updated_at"].clone())
            .map_err(|_| Error::response())?;
    }
    if action == "add_draft" && after["contact"]["created_at"] != after["contact"]["updated_at"] {
        return Err(Error::response());
    }
    let mut expected_contact = if action == "add_draft" {
        if !preview["before"].is_null() || after["version"] != 1 {
            return Err(Error::response());
        }
        // Defaults follow the existing full generated Contact schema's primitive
        // values. No handwritten Contact struct or additional state vocabulary.
        let mut fields: Map<String, Value> = after["contact"]
            .as_object()
            .ok_or_else(Error::response)?
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    match value {
                        Value::Bool(_) => json!(false),
                        Value::Object(_) => json!({}),
                        _ => json!(""),
                    },
                )
            })
            .collect();
        fields.insert("id".into(), json!(id));
        fields.insert("state".into(), json!("下書き"));
        for (key, value) in request["data"].as_object().ok_or_else(Error::response)? {
            fields.insert(key.clone(), value.clone());
        }
        Value::Object(fields)
    } else {
        let before = &preview["before"];
        validate_scope(before, workspace, source, Some(id))?;
        if before["version"] != request["expected_version"] {
            return Err(Error::response());
        }
        let mut contact = before["contact"].clone();
        let state = if action == "set_state" {
            request["data"]["state"].clone()
        } else {
            json!("対応中")
        };
        if contact["state"] != state {
            contact["state"] = state;
            contact["state_inferred"] = json!(false);
        }
        if action == "record_reply" {
            let note = contact["note"].as_str().ok_or_else(Error::response)?;
            contact["note"] = json!(format!(
                "{note}{}返信要約: {}",
                if note.is_empty() { "" } else { "\n" },
                request["data"]["summary"]
                    .as_str()
                    .ok_or_else(Error::response)?
            ));
        }
        let changed = contact != before["contact"];
        let version = before["version"].as_u64().ok_or_else(Error::response)?;
        if after["version"].as_u64() != version.checked_add(u64::from(changed)) {
            return Err(Error::response());
        }
        if !changed && after != before {
            return Err(Error::response());
        }
        contact
    };
    if action == "add_draft" {
        expected_contact["created_at"] = after["contact"]["created_at"].clone();
    }
    expected_contact["updated_at"] = after["contact"]["updated_at"].clone();
    if expected_contact != after["contact"] {
        return Err(Error::response());
    }
    Ok(())
}
