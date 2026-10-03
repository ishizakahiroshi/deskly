//! Owner-only case (受付) operations, the completion command, commit linking and the
//! per-project entry. No identifier of a kind, status or approval state is written in this
//! file: they come from `GET /cases/settings` on every call.
use std::{
    path::Path,
    process::{Command, Stdio},
};

use deskly_types::{
    AddCaseLinkRequest, AddCasePersonRequest, AddCaseReplyRequest, Case, CaseCollection, CaseDate,
    CaseDetail, CaseIdentifier, CaseLink, CaseNumber, CasePanels, CasePerson, CaseReply,
    CaseSettings, CaseSource, PatchCaseRequest,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};

use crate::client::{valid_id, Client, Error, Verb};

/// The title that marks the one work item holding a project's entry. Deskly's own word for
/// the work item, not a case setting.
const ENTRY_TITLE: &str = "入口";
/// Separator between the document path and the next C inside the work item's `next_action`.
const ENTRY_NEXT: &str = " 次: ";
const MAX_COMMITS: usize = 500;

/// Read filters for `cases list`. Values are checked against the settings before use.
#[derive(Default)]
pub struct CaseFilter {
    pub status: Vec<String>,
    pub kind: Vec<String>,
    pub source: Vec<String>,
    /// `us`, `them` or `none` (the protocol words of the settings' `waiting` map).
    pub waiting: Option<String>,
    /// Open cases whose `promised_due` is before today.
    pub overdue: bool,
    /// UTC `YYYY-MM-DD`; defaults to the API's own `today` from the panels.
    pub today: Option<String>,
}

/// What `PATCH` may change. `Option<Option<_>>`: the outer `None` leaves the field alone,
/// the inner `None` clears it.
pub enum CaseChange<'a> {
    Status(&'a str),
    Approval {
        state: &'a str,
        hold_until: Option<&'a str>,
    },
    Due {
        promised_due: Option<Option<&'a str>>,
        hold_until: Option<Option<&'a str>>,
    },
}

#[derive(Default)]
pub struct PatchOptions<'a> {
    pub reason: Option<&'a str>,
    pub actor_ref: Option<&'a str>,
    /// Pin the revision seen by a person; otherwise the current one is read.
    pub revision: Option<u64>,
    pub apply: bool,
}

#[derive(Default)]
pub struct CompleteOptions<'a> {
    pub status: Option<&'a str>,
    pub evidence: &'a [String],
    pub allow_no_evidence: bool,
    pub patch: PatchOptions<'a>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    Patch,
    Link,
    Person,
    Reply,
}

/// One request the command would send. A preview shows exactly this and an apply sends
/// exactly this.
struct Outgoing {
    route: Route,
    path: String,
    body: Value,
}
impl Outgoing {
    fn show(&self) -> Value {
        let mut body = self.body.clone();
        if self.route == Route::Reply {
            // The reply text is the sensitive part and is never echoed back.
            let chars = body["body"].as_str().map_or(0, |text| text.chars().count());
            body["body"] = json!(format!("（本文 {chars} 文字・表示しません）"));
        }
        json!({"method":match self.route {Route::Patch => "PATCH", _ => "POST"},"path":self.path,"body":body})
    }
}

struct Settings {
    kinds: Vec<String>,
    statuses: Vec<String>,
    open: Vec<String>,
    terminal: Vec<String>,
    approvals: Vec<String>,
    hold: String,
    waiting: Map<String, Value>,
}
impl Settings {
    fn parse(value: &Value) -> Result<Self, Error> {
        let list = |value: &Value| -> Result<Vec<String>, Error> {
            value
                .as_array()
                .ok_or_else(Error::response)?
                .iter()
                .map(|item| item.as_str().map(str::to_owned).ok_or_else(Error::response))
                .collect()
        };
        Ok(Self {
            kinds: list(&value["kinds"]["values"])?,
            statuses: list(&value["statuses"]["values"])?,
            open: list(&value["statuses"]["open"])?,
            terminal: list(&value["statuses"]["terminal"])?,
            approvals: list(&value["approval_states"]["values"])?,
            hold: value["approval_states"]["hold"]
                .as_str()
                .ok_or_else(Error::response)?
                .to_owned(),
            waiting: value["statuses"]["waiting"]
                .as_object()
                .ok_or_else(Error::response)?
                .clone(),
        })
    }
    fn status(&self, value: &str) -> Result<(), Error> {
        contained(&self.statuses, value)
    }
}
fn contained(values: &[String], value: &str) -> Result<(), Error> {
    if values.iter().any(|known| known == value) {
        Ok(())
    } else {
        Err(Error::not_in_settings())
    }
}

fn checked<T: DeserializeOwned + Serialize>(value: Value) -> Result<Value, Error> {
    let typed: T = serde_json::from_value(value).map_err(|_| Error::validation())?;
    serde_json::to_value(typed).map_err(|_| Error::validation())
}
fn parse_number(value: &str) -> Result<(), Error> {
    value
        .parse::<CaseNumber>()
        .map(|_| ())
        .map_err(|_| Error::validation())
}
fn parse_identifier(value: &str) -> Result<(), Error> {
    value
        .parse::<CaseIdentifier>()
        .map(|_| ())
        .map_err(|_| Error::validation())
}
fn parse_date(value: &str) -> Result<(), Error> {
    value
        .parse::<CaseDate>()
        .map(|_| ())
        .map_err(|_| Error::validation())
}
fn is_hex(value: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn public_case(case: &Value, with_body: bool) -> Value {
    let mut case = case.clone();
    if !with_body {
        if let Some(object) = case.as_object_mut() {
            object.remove("body");
        }
    }
    case
}
fn without_reply_text(reply: &Value, with_body: bool) -> Value {
    let mut reply = reply.clone();
    if !with_body {
        let chars = reply["body"]
            .as_str()
            .map_or(0, |text| text.chars().count());
        reply["body"] = json!(format!("（本文 {chars} 文字・表示しません）"));
    }
    reply
}
fn field<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}
fn summary(case: &Value) -> Value {
    json!({"number":case["number"],"status":case["status"],"approval_state":case["approval_state"],
        "promised_due":case["promised_due"],"hold_until":case["hold_until"],"revision":case["revision"]})
}
fn revision(case: &Value) -> Result<u64, Error> {
    case["revision"].as_u64().ok_or_else(Error::response)
}

/// `commit:HASH`, `doc:PATH` and `url:URL` are explicit. Without a prefix an http(s) URL is
/// a url, a lowercase hexadecimal string of 7 to 64 characters is a commit, anything else
/// is a document path.
fn parse_evidence(raw: &str) -> Result<(&'static str, String), Error> {
    let (kind, text) = match raw.split_once(':') {
        Some(("commit", rest)) => ("commit", rest),
        Some(("doc", rest)) => ("doc", rest),
        Some(("url", rest)) => ("url", rest),
        _ if raw.starts_with("http://") || raw.starts_with("https://") => ("url", raw),
        _ if is_hex(raw, 7..=64) => ("commit", raw),
        _ => ("doc", raw),
    };
    link_fields(kind, text)?;
    Ok((kind, text.to_owned()))
}
/// The same checks the API applies to a link, so a bad one never leaves this process.
fn link_fields(link_type: &str, reference: &str) -> Result<(), Error> {
    match link_type {
        "commit" if !is_hex(reference, 7..=64) => return Err(Error::validation()),
        "url" => {
            let parsed = url::Url::parse(reference).map_err(|_| Error::validation())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(Error::validation());
            }
        }
        "commit" | "doc" => {}
        _ => return Err(Error::validation()),
    }
    checked::<AddCaseLinkRequest>(json!({"link_type":link_type,"ref":reference})).map(|_| ())
}

impl Client {
    fn case_base(workspace: &str) -> Result<String, Error> {
        Ok(format!("{}/cases", Self::base(workspace)?))
    }
    fn case_settings(&self, workspace: &str) -> Result<Value, Error> {
        self.request::<CaseSettings>(&format!("{}/settings", Self::case_base(workspace)?), None)
            .map_err(Error::case)
    }
    fn case_detail(&self, workspace: &str, number: &str) -> Result<Value, Error> {
        parse_number(number)?;
        let detail = self
            .request::<CaseDetail>(&format!("{}/{number}", Self::case_base(workspace)?), None)
            .map_err(Error::case)?;
        // The route and the answer must be about the same case in the same workspace.
        if detail["case"]["number"] != number || detail["case"]["workspace_id"] != workspace {
            return Err(Error::response());
        }
        Ok(detail)
    }
    fn send_case(&self, send: &Outgoing) -> Result<Value, Error> {
        let body = Some(&send.body);
        match send.route {
            Route::Patch => self.request_with::<Case>(Verb::Patch, &send.path, body),
            Route::Link => self.request_with::<CaseLink>(Verb::Post, &send.path, body),
            Route::Person => self.request_with::<CasePerson>(Verb::Post, &send.path, body),
            Route::Reply => self.request_with::<CaseReply>(Verb::Post, &send.path, body),
        }
        .map_err(Error::case)
    }
    fn route_path(workspace: &str, number: &str, tail: &str) -> Result<String, Error> {
        Ok(format!("{}/{number}{tail}", Self::case_base(workspace)?))
    }

    /// Reads: `list`, `show`, `panels` and `settings`. Case and reply text appear only in
    /// `show` with `with_body`.
    pub fn case_read(
        &self,
        operation: &str,
        workspace: &str,
        number: Option<&str>,
        filter: &CaseFilter,
        with_body: bool,
    ) -> Result<Value, Error> {
        let base = Self::case_base(workspace)?;
        match operation {
            "settings" => self.case_settings(workspace),
            "panels" => self
                .request::<CasePanels>(&format!("{base}/panels"), None)
                .map_err(Error::case),
            "show" => {
                let detail = self.case_detail(workspace, number.ok_or_else(Error::validation)?)?;
                let replies = detail["replies"].as_array().ok_or_else(Error::response)?;
                Ok(json!({"case":public_case(&detail["case"], with_body),
                    "people":detail["people"],
                    "replies":replies.iter().map(|reply| without_reply_text(reply, with_body)).collect::<Vec<_>>(),
                    "links":detail["links"],"events":detail["events"]}))
            }
            "list" => self.case_list(workspace, filter),
            _ => Err(Error::validation()),
        }
    }
    fn case_list(&self, workspace: &str, filter: &CaseFilter) -> Result<Value, Error> {
        for source in &filter.source {
            source
                .parse::<CaseSource>()
                .map_err(|_| Error::validation())?;
        }
        if let Some(waiting) = &filter.waiting {
            if !["us", "them", "none"].contains(&waiting.as_str()) {
                return Err(Error::validation());
            }
        }
        if let Some(today) = &filter.today {
            parse_date(today)?;
            if !filter.overdue {
                return Err(Error::validation());
            }
        }
        let needs_settings = !filter.status.is_empty()
            || !filter.kind.is_empty()
            || filter.waiting.is_some()
            || filter.overdue;
        let settings = if needs_settings {
            Some(Settings::parse(&self.case_settings(workspace)?)?)
        } else {
            None
        };
        if let Some(settings) = &settings {
            for status in &filter.status {
                settings.status(status)?;
            }
            for kind in &filter.kind {
                contained(&settings.kinds, kind)?;
            }
        }
        let today = if filter.overdue {
            match &filter.today {
                Some(day) => Some(day.clone()),
                None => Some(
                    self.case_read("panels", workspace, None, filter, false)?["today"]
                        .as_str()
                        .ok_or_else(Error::response)?
                        .to_owned(),
                ),
            }
        } else {
            None
        };
        let rows = self
            .request::<CaseCollection>(&Self::case_base(workspace)?, None)
            .map_err(Error::case)?;
        let mut items = Vec::new();
        for row in rows["items"].as_array().ok_or_else(Error::response)? {
            let text = |key: &str| field(row, key);
            let keep = (filter.status.is_empty()
                || filter.status.iter().any(|s| s == text("status")))
                && (filter.kind.is_empty() || filter.kind.iter().any(|k| k == text("kind")))
                && (filter.source.is_empty() || filter.source.iter().any(|s| s == text("source")))
                && match (&filter.waiting, &settings) {
                    (Some(waiting), Some(settings)) => {
                        settings.waiting.get(text("status")).and_then(Value::as_str)
                            == Some(waiting.as_str())
                    }
                    _ => true,
                }
                && match (&today, &settings) {
                    (Some(today), Some(settings)) => {
                        settings.open.iter().any(|open| open == text("status"))
                            && row["promised_due"]
                                .as_str()
                                .is_some_and(|due| due < today.as_str())
                    }
                    _ => true,
                };
            if keep {
                items.push(public_case(row, false));
            }
        }
        Ok(json!({"items":items}))
    }

    fn patch_send(
        workspace: &str,
        number: &str,
        mut fields: Map<String, Value>,
        revision: u64,
        options: &PatchOptions,
    ) -> Result<Outgoing, Error> {
        fields.insert("expected_revision".into(), json!(revision));
        if let Some(reason) = options.reason {
            fields.insert("reason".into(), json!(reason));
        }
        if let Some(actor) = options.actor_ref {
            fields.insert("actor_ref".into(), json!(actor));
        }
        Ok(Outgoing {
            route: Route::Patch,
            path: Self::route_path(workspace, number, "")?,
            body: checked::<PatchCaseRequest>(Value::Object(fields))?,
        })
    }
    fn pinned_revision(case: &Value, pinned: Option<u64>) -> Result<u64, Error> {
        let current = revision(case)?;
        match pinned {
            Some(pinned) if pinned != current => Err(Error::conflict()),
            _ => Ok(current),
        }
    }
    fn preview(summary: Value, sends: &[Outgoing]) -> Value {
        json!({"preview":true,"current":summary,"send":sends.iter().map(Outgoing::show).collect::<Vec<_>>()})
    }

    /// `set-status`, `set-approval` and `set-due`. Preview unless `options.apply`.
    pub fn case_patch(
        &self,
        workspace: &str,
        number: &str,
        change: &CaseChange,
        options: &PatchOptions,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        // Local checks first: nothing is read for input that cannot be valid.
        match change {
            CaseChange::Status(status) => parse_identifier(status)?,
            CaseChange::Approval { state, hold_until } => {
                parse_identifier(state)?;
                if let Some(day) = hold_until {
                    parse_date(day)?;
                }
            }
            CaseChange::Due {
                promised_due,
                hold_until,
            } => {
                if promised_due.is_none() && hold_until.is_none() {
                    return Err(Error::validation());
                }
                for day in [promised_due, hold_until].into_iter().flatten().flatten() {
                    parse_date(day)?;
                }
            }
        }
        let settings = Settings::parse(&self.case_settings(workspace)?)?;
        let detail = self.case_detail(workspace, number)?;
        let case = &detail["case"];
        let revision = Self::pinned_revision(case, options.revision)?;
        let mut fields = Map::new();
        match change {
            CaseChange::Status(status) => {
                settings.status(status)?;
                if case["status"] != *status {
                    fields.insert("status".into(), json!(status));
                }
            }
            CaseChange::Approval { state, hold_until } => {
                contained(&settings.approvals, state)?;
                let holding = *state == settings.hold;
                if hold_until.is_some() && !holding {
                    return Err(Error::validation());
                }
                if case["approval_state"] != *state {
                    fields.insert("approval_state".into(), json!(state));
                }
                match hold_until {
                    Some(day) if case["hold_until"] != *day => {
                        fields.insert("hold_until".into(), json!(day));
                    }
                    // Leaving the hold takes its expiry with it, in the same request.
                    None if !holding && !case["hold_until"].is_null() => {
                        fields.insert("hold_until".into(), Value::Null);
                    }
                    _ => {}
                }
            }
            CaseChange::Due {
                promised_due,
                hold_until,
            } => {
                for (key, wanted) in [("promised_due", promised_due), ("hold_until", hold_until)] {
                    if let Some(wanted) = wanted {
                        let wanted = wanted.map_or(Value::Null, |day| json!(day));
                        if case[key] != wanted {
                            fields.insert(key.into(), wanted);
                        }
                    }
                }
            }
        }
        if fields.is_empty() {
            let mut result = json!({"current":summary(case),"no_change":true});
            result[if options.apply { "applied" } else { "preview" }] = json!(!options.apply);
            result["send"] = json!([]);
            return Ok(result);
        }
        let send = Self::patch_send(workspace, number, fields, revision, options)?;
        self.safe(&send.body)?;
        if !options.apply {
            return Ok(Self::preview(summary(case), &[send]));
        }
        let saved = self.send_case(&send)?;
        Ok(json!({"applied":true,"case":public_case(&saved, false)}))
    }

    /// `reply`: append a reply. The text is never echoed in a preview or a result.
    pub fn case_reply(
        &self,
        workspace: &str,
        number: &str,
        text: &str,
        author_ref: Option<&str>,
        delivered_at: Option<&str>,
        apply: bool,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        if text.trim().is_empty() {
            return Err(Error::validation());
        }
        let mut body = json!({"body":text});
        if let Some(author) = author_ref {
            body["author_ref"] = json!(author);
        }
        if let Some(at) = delivered_at {
            body["delivered_at"] = json!(at);
        }
        let send = Outgoing {
            route: Route::Reply,
            path: Self::route_path(workspace, number, "/replies")?,
            body: checked::<AddCaseReplyRequest>(body)?,
        };
        self.safe(&send.body)?;
        let detail = self.case_detail(workspace, number)?;
        if !apply {
            return Ok(Self::preview(summary(&detail["case"]), &[send]));
        }
        let saved = self.send_case(&send)?;
        Ok(json!({"applied":true,"reply":without_reply_text(&saved, false)}))
    }

    /// `link`: attach a commit, a document or an URL. The same link twice stays one row.
    pub fn case_link(
        &self,
        workspace: &str,
        number: &str,
        link_type: &str,
        reference: &str,
        apply: bool,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        link_fields(link_type, reference)?;
        let send = Self::link_send(workspace, number, link_type, reference)?;
        self.safe(&send.body)?;
        let detail = self.case_detail(workspace, number)?;
        let present = Self::has_link(&detail, link_type, reference);
        if !apply {
            let mut result = Self::preview(summary(&detail["case"]), &[send]);
            result["already_present"] = json!(present);
            return Ok(result);
        }
        if present {
            return Ok(json!({"applied":false,"already_present":true}));
        }
        let saved = self.send_case(&send)?;
        Ok(json!({"applied":true,"already_present":false,"link":saved}))
    }
    fn link_send(
        workspace: &str,
        number: &str,
        link_type: &str,
        reference: &str,
    ) -> Result<Outgoing, Error> {
        Ok(Outgoing {
            route: Route::Link,
            path: Self::route_path(workspace, number, "/links")?,
            body: checked::<AddCaseLinkRequest>(json!({"link_type":link_type,"ref":reference}))?,
        })
    }
    fn has_link(detail: &Value, link_type: &str, reference: &str) -> bool {
        detail["links"].as_array().is_some_and(|links| {
            links
                .iter()
                .any(|link| link["link_type"] == link_type && link["ref"] == reference)
        })
    }

    /// `people-add`: another reporter of the same case.
    pub fn case_person(
        &self,
        workspace: &str,
        number: &str,
        reporter_ref: &str,
        apply: bool,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        let send = Outgoing {
            route: Route::Person,
            path: Self::route_path(workspace, number, "/people")?,
            body: checked::<AddCasePersonRequest>(json!({"reporter_ref":reporter_ref}))?,
        };
        self.safe(&send.body)?;
        let detail = self.case_detail(workspace, number)?;
        let present = detail["people"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["reporter_ref"] == reporter_ref));
        if !apply {
            let mut result = Self::preview(summary(&detail["case"]), &[send]);
            result["already_present"] = json!(present);
            return Ok(result);
        }
        if present {
            return Ok(json!({"applied":false,"already_present":true}));
        }
        let saved = self.send_case(&send)?;
        Ok(json!({"applied":true,"already_present":false,"person":saved}))
    }

    /// ⑥ `complete`: add the evidence, then move the case to a terminal status. The links go
    /// first so the case is never terminal without them. Running it again is safe: the same
    /// evidence stays one row and an unchanged status writes nothing.
    pub fn case_complete(
        &self,
        workspace: &str,
        number: &str,
        options: &CompleteOptions,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        let mut evidence: Vec<(&'static str, String)> = Vec::new();
        for raw in options.evidence {
            let item = parse_evidence(raw)?;
            if !evidence.contains(&item) {
                evidence.push(item);
            }
        }
        // Nothing is read or written for a completion that would leave no evidence.
        if evidence.is_empty() && !options.allow_no_evidence {
            return Err(Error::evidence_required());
        }
        if let Some(status) = options.status {
            parse_identifier(status)?;
        }
        let settings = Settings::parse(&self.case_settings(workspace)?)?;
        let detail = self.case_detail(workspace, number)?;
        let case = &detail["case"];
        let current = case["status"].as_str().ok_or_else(Error::response)?;
        let target = match options.status {
            Some(status) => {
                settings.status(status)?;
                contained(&settings.terminal, status).map_err(|_| Error::not_terminal())?;
                status.to_owned()
            }
            // Keep a terminal status the case already has; otherwise the first one listed.
            None if settings.terminal.iter().any(|status| status == current) => current.to_owned(),
            None => settings
                .terminal
                .first()
                .ok_or_else(Error::response)?
                .clone(),
        };
        let revision = Self::pinned_revision(case, options.patch.revision)?;
        let mut sends = Vec::new();
        let mut shown = Vec::new();
        let mut added = 0usize;
        for (link_type, reference) in &evidence {
            let present = Self::has_link(&detail, link_type, reference);
            shown.push(json!({"link_type":link_type,"ref":reference,"already_present":present}));
            if !present {
                sends.push(Self::link_send(workspace, number, link_type, reference)?);
                added += 1;
            }
        }
        let changes_status = current != target;
        if changes_status {
            let mut fields = Map::new();
            fields.insert("status".into(), json!(target));
            sends.push(Self::patch_send(
                workspace,
                number,
                fields,
                revision,
                &options.patch,
            )?);
        }
        for send in &sends {
            self.safe(&send.body)?;
        }
        let existing = detail["links"].as_array().map_or(0, Vec::len);
        let evidence_missing = existing + added == 0;
        if !options.patch.apply {
            let mut result = Self::preview(summary(case), &sends);
            result["complete"] = json!({"to_status":target,"status_changes":changes_status,
                "evidence":shown,"evidence_missing":evidence_missing});
            return Ok(result);
        }
        let mut status = current.to_owned();
        for send in &sends {
            let saved = self.send_case(send)?;
            if send.route == Route::Patch {
                status = saved["status"]
                    .as_str()
                    .ok_or_else(Error::response)?
                    .to_owned();
            }
        }
        if status != target {
            return Err(Error::response());
        }
        Ok(
            json!({"applied":true,"number":number,"status":status,"status_changed":changes_status,
            "links_added":added,"links_present":evidence.len() - added,"evidence_missing":evidence_missing}),
        )
    }

    /// `link-commits`: commits of a local repository whose message has the exact line
    /// `Ref: <number>` become `commit` links. Only `git log` runs; nothing is written to the
    /// repository.
    pub fn case_link_commits(
        &self,
        workspace: &str,
        number: &str,
        repo: &Path,
        rev: Option<&str>,
        apply: bool,
    ) -> Result<Value, Error> {
        parse_number(number)?;
        let commits = commits_with_ref(repo, number, rev.unwrap_or("HEAD"))?;
        let detail = self.case_detail(workspace, number)?;
        let mut sends = Vec::new();
        let mut present = 0usize;
        for hash in &commits {
            if Self::has_link(&detail, "commit", hash) {
                present += 1;
            } else {
                sends.push(Self::link_send(workspace, number, "commit", hash)?);
            }
        }
        let added = sends.len();
        if !apply {
            let mut result = Self::preview(summary(&detail["case"]), &sends);
            result["commits"] = json!(commits);
            result["links_present"] = json!(present);
            return Ok(result);
        }
        for send in &sends {
            self.send_case(send)?;
        }
        Ok(
            json!({"applied":true,"number":number,"commits":commits,"links_added":added,"links_present":present}),
        )
    }

    fn entry_items(&self, workspace: &str, project: &str) -> Result<Vec<Value>, Error> {
        let work = self.read("items", workspace, Some(project), None, None, None)?;
        Ok(work["items"]
            .as_array()
            .ok_or_else(Error::response)?
            .iter()
            .filter(|row| row["archived"] == false && row["title"] == ENTRY_TITLE)
            .cloned()
            .collect())
    }

    /// `entry show`: the document path and the next C written for the project.
    pub fn entry_show(&self, workspace: &str, project: &str) -> Result<Value, Error> {
        valid_id(project)?;
        let mut items = self.entry_items(workspace, project)?;
        if items.len() > 1 {
            return Err(Error::entry_ambiguous());
        }
        let item = items.pop().ok_or_else(Error::entry_not_found)?;
        let text = item["next_action"].as_str().ok_or_else(Error::response)?;
        let (path, next) = match text.split_once(ENTRY_NEXT) {
            Some((path, next)) => (json!(path), json!(next)),
            None => (Value::Null, Value::Null),
        };
        let result = json!({"project_id":project,"work_item_id":item["id"],"version":item["version"],
            "path":path,"next":next,"next_action":text,"state":item["state"]});
        self.safe(&result)?;
        Ok(result)
    }

    /// `entry set`: create or update the project's one 「入口」work item. Preview unless
    /// `apply`; only the existing work item API is used.
    pub fn entry_set(
        &self,
        workspace: &str,
        project: &str,
        path: &str,
        next: &str,
        reason: Option<&str>,
        apply: bool,
    ) -> Result<Value, Error> {
        valid_id(project)?;
        for part in [path, next] {
            if part.trim() != part
                || part.is_empty()
                || part.chars().any(char::is_control)
                || part.contains(ENTRY_NEXT)
            {
                return Err(Error::validation());
            }
        }
        let next_action = format!("{path}{ENTRY_NEXT}{next}");
        self.safe(&json!(next_action))?;
        let reason = reason.unwrap_or("案件の入口を更新");
        let mut items = self.entry_items(workspace, project)?;
        if items.len() > 1 {
            return Err(Error::entry_ambiguous());
        }
        match items.pop() {
            Some(item) => {
                let mut data = Map::new();
                for key in [
                    "kind",
                    "title",
                    "assignee_id",
                    "next_action",
                    "check_date",
                    "waiting_reason",
                    "state",
                    "milestone_id",
                ] {
                    data.insert(key.into(), item[key].clone());
                }
                data.insert("next_action".into(), json!(next_action));
                let version = item["version"].as_u64().ok_or_else(Error::response)?;
                self.write(
                    workspace,
                    "work_item",
                    "update",
                    Some(project),
                    item["id"].as_str(),
                    Some(version),
                    Some(Value::Object(data)),
                    reason,
                    apply,
                )
            }
            None => {
                let owner = self.read("projects", workspace, None, Some(project), None, None)?
                    ["owner_id"]
                    .clone();
                let data = json!({"kind":"開発","title":ENTRY_TITLE,"assignee_id":owner,
                    "next_action":next_action,"check_date":"","waiting_reason":"",
                    "state":"進行中","milestone_id":""});
                self.write(
                    workspace,
                    "work_item",
                    "create",
                    Some(project),
                    None,
                    None,
                    Some(data),
                    reason,
                    apply,
                )
            }
        }
    }
}

/// Run `git log` and keep the commits that have the exact line `Ref: <number>`.
fn commits_with_ref(repo: &Path, number: &str, rev: &str) -> Result<Vec<String>, Error> {
    // A revision is a name, never an option.
    let plain = rev
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._/~^@{}-".contains(&b))
        && !rev.starts_with('-')
        && !rev.is_empty()
        && rev.len() <= 200;
    if !plain || !repo.is_dir() {
        return Err(Error::validation());
    }
    let marker = format!("Ref: {number}");
    let output = Command::new("git")
        .arg("--no-pager")
        .arg("-C")
        .arg(repo)
        .args(["log", "--format=%x1e%H%x1f%B", "--fixed-strings"])
        .arg(format!("--grep={marker}"))
        .arg(format!("--max-count={}", MAX_COMMITS + 1))
        .arg(rev)
        .arg("--")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::git_unavailable()
            } else {
                Error::git_failed()
            }
        })?;
    if !output.status.success() {
        return Err(Error::git_failed());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut hashes: Vec<String> = Vec::new();
    for chunk in text
        .split('\u{1e}')
        .filter(|chunk| !chunk.trim().is_empty())
    {
        let (hash, message) = chunk.split_once('\u{1f}').ok_or_else(Error::git_failed)?;
        let hash = hash.trim();
        if !is_hex(hash, 7..=64) {
            return Err(Error::git_failed());
        }
        // `--grep` is a substring search: `Ref: a-1` also finds `Ref: a-12`. The line must match.
        if message.lines().any(|line| line.trim_end() == marker)
            && !hashes.iter().any(|h| h == hash)
        {
            hashes.push(hash.to_owned());
        }
    }
    if hashes.len() > MAX_COMMITS {
        return Err(Error::validation());
    }
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_kinds_are_inferred_or_explicit() {
        assert_eq!(parse_evidence("abc1234").unwrap().0, "commit");
        assert_eq!(parse_evidence("https://example.test/x").unwrap().0, "url");
        assert_eq!(parse_evidence("docs/plan.md").unwrap().0, "doc");
        assert_eq!(parse_evidence("doc:abc1234").unwrap().0, "doc");
        assert_eq!(
            parse_evidence("url:https://example.test/x").unwrap(),
            ("url", "https://example.test/x".to_owned())
        );
        assert_eq!(parse_evidence("C:\\docs\\plan.md").unwrap().0, "doc");
        for bad in ["commit:xyz", "url:ftp://example.test", "doc:with space", ""] {
            assert!(parse_evidence(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_revision_cannot_be_an_option() {
        let dir = std::env::temp_dir();
        for rev in ["--output=x", "-n", "", "a b", "x;y"] {
            assert!(commits_with_ref(&dir, "app-1", rev).is_err());
        }
    }
}
