//! Synthetic case ledger for the CLI and MCP tests. Every identifier here is invented on
//! purpose (no word of any real deployment): the CLI must take them from `/cases/settings`.
use super::*;
use serde_json::{json, Map};

pub const NUMBER: &str = "app_one-7";
pub const WISH: &str = "app_one-8";
pub const NEW_NUMBER: &str = "app_two-1";
pub const DONE_NUMBER: &str = "app_two-2";
pub const BODY: &str = "合成の受付本文";
pub const REPLY: &str = "合成の返事本文";
pub const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
pub const OTHER_COMMIT: &str = "89abcdef0123456789abcdef0123456789abcdef";
pub const TODAY: &str = "2026-10-01";
const STAMP: &str = "2026-10-01T00:00:00Z";
const LATER: &str = "2026-10-01T00:00:01Z";

pub fn path(tail: &str) -> String {
    format!("/api/v1/workspaces/{WORKSPACE}/cases{tail}")
}

pub fn settings() -> Value {
    json!({
        "kinds": {"values": ["defect", "wish", "query", "memo"], "requires_approval": ["wish"]},
        "statuses": {
            "values": ["fresh", "triage", "working", "shipped", "dropped"],
            "open": ["fresh", "triage", "working"],
            "terminal": ["shipped", "dropped"],
            "initial": "fresh",
            "waiting": {"fresh": "us", "triage": "them", "working": "us", "shipped": "none", "dropped": "none"}
        },
        "approval_states": {
            "values": ["na", "awaiting", "granted", "denied", "parked"],
            "initial": "awaiting",
            "initial_free": "na",
            "hold": "parked"
        },
        "labels": {"xx": {"defect": "合成の種別", "fresh": "合成の状態"}},
        "numbering": {"display_names": {"app_one": "合成アプリ"}}
    })
}

fn actor() -> Value {
    json!({"kind": "app", "app": "app_one"})
}

pub struct Row {
    pub case: Value,
    pub people: Vec<Value>,
    pub replies: Vec<Value>,
    pub links: Vec<Value>,
    pub events: Vec<Value>,
}

#[derive(Clone)]
pub struct Failure {
    pub method: &'static str,
    pub suffix: String,
    pub status: u16,
    pub code: &'static str,
}

pub struct Ledger {
    pub settings: Value,
    pub rows: BTreeMap<String, Row>,
    pub failures: Vec<Failure>,
}

fn case(
    number: &str,
    kind: &str,
    status: &str,
    approval: &str,
    promised_due: Value,
    closed_at: Value,
) -> Value {
    let (source, seq) = number.rsplit_once('-').unwrap();
    json!({
        "workspace_id": WORKSPACE, "number": number, "source": source, "tenant_ref": null,
        "seq": seq.parse::<u64>().unwrap(), "origin": "human", "kind": kind, "status": status,
        "approval_state": approval, "title": "合成の題名", "body": BODY, "reporter_ref": "reporter-1",
        "screen_id": "screen-1", "feature_id": null, "environment": null, "version": null,
        "url": null, "fingerprint": null, "promised_due": promised_due, "hold_until": null,
        "closed_at": closed_at, "duplicate_of": null, "legacy_ref": null, "revision": 1,
        "created_at": STAMP, "updated_at": STAMP
    })
}

fn row(case: Value) -> Row {
    let event = json!({"workspace_id": WORKSPACE, "case_number": case["number"], "seq": 1,
        "action": "create", "actor": actor(), "actor_ref": null, "reason": null, "at_utc": STAMP,
        "changes": [{"field": "status", "before": null, "after": case["status"]}]});
    Row {
        case,
        people: Vec::new(),
        replies: Vec::new(),
        links: Vec::new(),
        events: vec![event],
    }
}

impl Ledger {
    pub fn new() -> Self {
        let mut rows = BTreeMap::new();
        for value in [
            case(
                NUMBER,
                "defect",
                "fresh",
                "na",
                json!("2026-09-30"),
                Value::Null,
            ),
            case(
                WISH,
                "wish",
                "working",
                "awaiting",
                json!("2026-10-05"),
                Value::Null,
            ),
            case(
                NEW_NUMBER,
                "query",
                "triage",
                "na",
                Value::Null,
                Value::Null,
            ),
            case(
                DONE_NUMBER,
                "memo",
                "shipped",
                "na",
                json!("2026-09-01"),
                json!(STAMP),
            ),
        ] {
            rows.insert(value["number"].as_str().unwrap().to_owned(), row(value));
        }
        let done = rows.get_mut(DONE_NUMBER).unwrap();
        done.links.push(link(DONE_NUMBER, "commit", COMMIT));
        Self {
            settings: settings(),
            rows,
            failures: Vec::new(),
        }
    }

    pub fn row(&self, number: &str) -> &Row {
        &self.rows[number]
    }
}

pub fn link(number: &str, link_type: &str, reference: &str) -> Value {
    json!({"workspace_id": WORKSPACE, "case_number": number, "link_type": link_type, "ref": reference,
        "added_by": actor(), "created_at": LATER})
}

fn terminal(ledger: &Ledger, status: &str) -> bool {
    ledger.settings["statuses"]["terminal"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s == status)
}

fn error(status: u16, code: &str) -> Response {
    // Deliberately hostile text: nothing of it may reach CLI output.
    Response::json(
        status,
        json!({"error": code, "message": format!("{TOKEN} {BODY} {REPLY}"), "body": BODY}),
    )
}

fn patch(ledger: &mut Ledger, number: &str, request: &Request) -> Response {
    let hold = ledger.settings["approval_states"]["hold"].clone();
    let body = request.body.clone().unwrap();
    let _: deskly_types::PatchCaseRequest = serde_json::from_value(body.clone()).unwrap();
    let Some(found) = ledger.rows.get(number) else {
        return error(404, "not_found");
    };
    if found.case["revision"] != body["expected_revision"] {
        return error(409, "version_conflict");
    }
    let mut next = found.case.clone();
    let mut changes = Vec::new();
    for key in ["status", "approval_state", "promised_due", "hold_until"] {
        if let Some(value) = body.get(key) {
            if next[key] != *value {
                changes.push(json!({"field": key, "before": next[key], "after": value}));
                next[key] = value.clone();
            }
        }
    }
    if !next["hold_until"].is_null() && next["approval_state"] != hold {
        return error(400, "hold_until_requires_hold");
    }
    if changes.is_empty() {
        return Response::json(200, found.case.clone());
    }
    let closed = terminal(ledger, next["status"].as_str().unwrap());
    if closed && next["closed_at"].is_null() {
        next["closed_at"] = json!(LATER);
    } else if !closed {
        next["closed_at"] = Value::Null;
    }
    next["revision"] = json!(next["revision"].as_u64().unwrap() + 1);
    next["updated_at"] = json!(LATER);
    let row = ledger.rows.get_mut(number).unwrap();
    let seq = row.events.len() + 1;
    row.events.push(json!({"workspace_id": WORKSPACE, "case_number": number, "seq": seq,
        "action": "update", "actor": actor(), "actor_ref": body.get("actor_ref").cloned().unwrap_or(Value::Null),
        "reason": body.get("reason").cloned().unwrap_or(Value::Null), "at_utc": LATER, "changes": changes}));
    row.case = next.clone();
    Response::json(200, next)
}

fn handle(ledger: &mut Ledger, request: &Request) -> Response {
    assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
    if request.method != "GET" {
        assert_eq!(
            request.headers["origin"],
            format!("http://{}", request.headers["host"])
        );
    }
    let tail = request
        .path
        .strip_prefix(&path(""))
        .expect("only case routes are served")
        .to_owned();
    if let Some(failure) = ledger
        .failures
        .iter()
        .find(|f| f.method == request.method && tail.ends_with(&f.suffix))
    {
        return error(failure.status, failure.code);
    }
    match (request.method.as_str(), tail.as_str()) {
        ("GET", "") => {
            let items: Vec<Value> = ledger
                .rows
                .values()
                .map(|row| {
                    let mut item = row.case.clone();
                    let missing =
                        terminal(ledger, item["status"].as_str().unwrap()) && row.links.is_empty();
                    item["evidence_missing"] = json!(missing);
                    item
                })
                .collect();
            Response::json(200, json!({"items": items}))
        }
        ("GET", "/settings") => Response::json(200, ledger.settings.clone()),
        ("GET", "/panels") => Response::json(
            200,
            json!({"today": TODAY, "open": 3, "overdue": 1, "waiting": {"us": 2, "them": 1, "none": 0},
                "screens": [{"screen_id": "screen-1", "count": 3}], "kinds": [{"kind": "defect", "count": 1}]}),
        ),
        (method, rest) => {
            let rest = rest.strip_prefix('/').expect("case number route");
            let (number, sub) = match rest.split_once('/') {
                Some((number, sub)) => (number, Some(sub)),
                None => (rest, None),
            };
            let Some(found) = ledger.rows.get(number) else {
                return error(404, "not_found");
            };
            match (method, sub) {
                ("GET", None) => Response::json(
                    200,
                    json!({"case": found.case, "people": found.people, "replies": found.replies,
                        "links": found.links, "events": found.events}),
                ),
                ("PATCH", None) => patch(ledger, number, request),
                ("POST", Some("links")) => {
                    let typed: deskly_types::AddCaseLinkRequest =
                        serde_json::from_value(request.body.clone().unwrap()).unwrap();
                    let (kind, reference) = (typed.link_type.to_string(), typed.ref_.to_string());
                    let row = ledger.rows.get_mut(number).unwrap();
                    if let Some(existing) = row
                        .links
                        .iter()
                        .find(|l| l["link_type"] == kind && l["ref"] == reference)
                    {
                        return Response::json(200, existing.clone());
                    }
                    let added = link(number, &kind, &reference);
                    row.links.push(added.clone());
                    Response::json(200, added)
                }
                ("POST", Some("people")) => {
                    let typed: deskly_types::AddCasePersonRequest =
                        serde_json::from_value(request.body.clone().unwrap()).unwrap();
                    let reporter = typed.reporter_ref.to_string();
                    let row = ledger.rows.get_mut(number).unwrap();
                    if let Some(existing) =
                        row.people.iter().find(|p| p["reporter_ref"] == reporter)
                    {
                        return Response::json(200, existing.clone());
                    }
                    let person = json!({"workspace_id": WORKSPACE, "case_number": number,
                        "reporter_ref": reporter, "added_by": actor(), "created_at": LATER});
                    row.people.push(person.clone());
                    Response::json(200, person)
                }
                ("POST", Some("replies")) => {
                    let body = request.body.clone().unwrap();
                    let _: deskly_types::AddCaseReplyRequest =
                        serde_json::from_value(body.clone()).unwrap();
                    let row = ledger.rows.get_mut(number).unwrap();
                    let mut reply = Map::new();
                    reply.insert("workspace_id".into(), json!(WORKSPACE));
                    reply.insert("case_number".into(), json!(number));
                    reply.insert("seq".into(), json!(row.replies.len() + 1));
                    reply.insert("body".into(), body["body"].clone());
                    reply.insert("author".into(), actor());
                    reply.insert(
                        "author_ref".into(),
                        body.get("author_ref").cloned().unwrap_or(Value::Null),
                    );
                    reply.insert("created_at".into(), json!(LATER));
                    reply.insert(
                        "delivered_at".into(),
                        body.get("delivered_at").cloned().unwrap_or(Value::Null),
                    );
                    row.replies.push(Value::Object(reply.clone()));
                    Response::json(200, Value::Object(reply))
                }
                _ => panic!("unexpected case route {method} {}", request.path),
            }
        }
    }
}

pub type Shared = Arc<Mutex<Ledger>>;

pub fn shared() -> Shared {
    Arc::new(Mutex::new(Ledger::new()))
}
pub fn server(ledger: &Shared) -> MockServer {
    let ledger = Arc::clone(ledger);
    MockServer::new(move |request| handle(&mut ledger.lock().unwrap(), request))
}

/// The requests that changed something (everything except GET).
pub fn writes(server: &MockServer) -> Vec<Request> {
    server
        .requests()
        .into_iter()
        .filter(|request| request.method != "GET")
        .collect()
}

/// Nothing of a case or reply text, nor the token, may be in what a command prints.
pub fn assert_no_text(value: &str) {
    for secret in [BODY, REPLY, TOKEN] {
        assert!(!value.contains(secret), "leaked {secret}: {value}");
    }
}

/// Work-item API of one project, for the entry tests.
pub fn entry_server(existing: Option<&str>) -> (MockServer, Shared2) {
    let state = Arc::new(Mutex::new(Entry {
        items: existing
            .map(|next| {
                let mut item = fixture("work_item");
                item["title"] = json!("入口");
                item["next_action"] = json!(next);
                vec![item]
            })
            .unwrap_or_default(),
        last: Value::Null,
    }));
    let shared = Arc::clone(&state);
    let server = MockServer::new(move |request| {
        let mut entry = shared.lock().unwrap();
        assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
        let prefix = format!("/api/v1/workspaces/{WORKSPACE}");
        let route = request.path.strip_prefix(&prefix).unwrap();
        match (request.method.as_str(), route) {
            ("GET", r) if r == format!("/projects/{PROJECT}") => {
                Response::json(200, fixture("project"))
            }
            ("GET", r) if r == format!("/projects/{PROJECT}/work-items") => {
                Response::json(200, json!({"items": entry.items}))
            }
            ("POST", "/commands/preview") => {
                let mut command = request.body.clone().unwrap();
                let action = command["action"].as_str().unwrap().to_owned();
                let mut after = fixture("work_item");
                let before = if action == "create" {
                    Value::Null
                } else {
                    entry.items[0].clone()
                };
                if command["id"].is_null() {
                    command["id"] = after["id"].clone();
                }
                after["id"] = command["id"].clone();
                for (key, value) in command["data"].as_object().unwrap() {
                    after[key] = value.clone();
                }
                after["version"] = json!(if action == "create" { 1 } else { 2 });
                let preview = json!({"request": command, "before": before, "after": after,
                    "preview_token": "a".repeat(64)});
                entry.last = preview.clone();
                Response::json(200, preview)
            }
            ("POST", "/commands/apply") => {
                assert_eq!(
                    request.body.as_ref().unwrap(),
                    &entry.last,
                    "apply must send the exact preview"
                );
                let after = entry.last["after"].clone();
                entry.items = vec![after.clone()];
                Response::json(200, after)
            }
            _ => panic!("unexpected route {} {}", request.method, request.path),
        }
    });
    (server, state)
}

pub struct Entry {
    pub items: Vec<Value>,
    pub last: Value,
}
pub type Shared2 = Arc<Mutex<Entry>>;
