mod support;

use deskly_types::{
    CommandPreview, CommandResult, EventCollection, MilestoneCollection, ProjectCollection,
    WorkItemCollection,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use support::*;

struct Session {
    child: Child,
    input: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Option<thread::JoinHandle<String>>,
    next: u64,
}
impl Session {
    fn new(server: &MockServer, home: &TempHome) -> Self {
        let mut child = command(server, home)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (send, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let stderr = Some(thread::spawn(move || {
            let mut s = String::new();
            stderr.read_to_string(&mut s).unwrap();
            s
        }));
        let mut session = Self {
            child,
            input,
            lines,
            stderr,
            next: 0,
        };
        let init = session.request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"synthetic-local-test","version":"1"}}));
        assert_eq!(init["result"]["serverInfo"]["name"], "deskly");
        session.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        session
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        self.send(json!({"jsonrpc":"2.0","id":self.next,"method":method,"params":params}));
        loop {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(8))
                .expect("MCP response timeout");
            assert!(!line.contains(TOKEN), "credentials must never reach stdout");
            let value: Value =
                serde_json::from_str(&line).expect("stdout must contain only JSON-RPC");
            if value["id"] == self.next {
                return value;
            }
            assert!(value.get("method").is_some(), "unexpected response ID");
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))
    }
    fn finish(mut self) {
        self.input.take();
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < until, "MCP did not exit after EOF");
            thread::sleep(Duration::from_millis(10));
        }
        let stderr = self.stderr.take().unwrap().join().unwrap();
        assert!(!stderr.contains(TOKEN));
        assert!(stderr.is_empty(), "unexpected diagnostics: {stderr}");
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn result(response: &Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    assert_ne!(response["result"]["isError"], true, "{response}");
    response["result"]["structuredContent"].clone()
}

#[test]
fn real_stdio_reads_and_all_write_tools_require_explicit_apply() {
    let latest = Arc::new(Mutex::new(Value::Null));
    let latest_server = Arc::clone(&latest);
    let server = MockServer::new(move |request| {
        assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
        let path = request.path.as_str();
        if path.ends_with("/commands/preview") {
            assert_eq!(request.method, "POST");
            assert_eq!(
                request.headers["origin"],
                format!("http://{}", request.headers["host"])
            );
            let mut command = request.body.clone().unwrap();
            let kind = command["type"].as_str().unwrap();
            let mut after = fixture(kind);
            let action = command["action"].as_str().unwrap().to_owned();
            let mut before = after.clone();
            before["archived"] = json!(action == "restore");
            if command["id"].is_null() {
                command["id"] = after["id"].clone();
            }
            if let Some(data) = command["data"].as_object() {
                for (key, value) in data {
                    after[key] = value.clone();
                }
            }
            after["archived"] = json!(action == "archive");
            after["version"] = json!(if action == "create" { 1 } else { 2 });
            let preview = json!({"request":command,"before":if action=="create" {Value::Null} else {before},"after":after,"preview_token":"a".repeat(64)});
            *latest_server.lock().unwrap() = preview.clone();
            return Response::json(200, preview);
        }
        if path.ends_with("/commands/apply") {
            assert_eq!(
                request.body.as_ref().unwrap(),
                &*latest_server.lock().unwrap(),
                "apply must preserve the exact preview"
            );
            return Response::json(200, request.body.as_ref().unwrap()["after"].clone());
        }
        assert_eq!(request.method, "GET");
        Response::json(
            200,
            if path.ends_with("/projects") {
                json!({"projects":[fixture("project")],"archived_projects":[]})
            } else if path.ends_with("/milestones") {
                json!({"items":[fixture("milestone")]})
            } else if path.ends_with("/work-items") {
                json!({"items":[fixture("work_item")]})
            } else if path.ends_with("/events") {
                json!({"events":[fixture("event")]})
            } else if path.ends_with(ITEM) {
                fixture("work_item")
            } else if path.ends_with(MILESTONE) {
                fixture("milestone")
            } else {
                fixture("project")
            },
        )
    });
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let listed = session.request("tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 34);
    for tool in tools {
        assert!(!tool["title"].as_str().unwrap().is_ascii());
        assert!(!tool["description"].as_str().unwrap().is_ascii());
        if [
            "deskly_create",
            "deskly_change",
            "deskly_archive",
            "deskly_restore",
        ]
        .contains(&tool["name"].as_str().unwrap())
        {
            assert_eq!(tool["inputSchema"]["properties"]["apply"]["default"], false);
        }
    }
    let projects = result(&session.call("deskly_projects", json!({"workspace":WORKSPACE})));
    serde_json::from_value::<ProjectCollection>(projects).unwrap();
    let milestones = result(&session.call(
        "deskly_milestones",
        json!({"workspace":WORKSPACE,"project":PROJECT}),
    ));
    serde_json::from_value::<MilestoneCollection>(milestones).unwrap();
    let items = result(&session.call(
        "deskly_items",
        json!({"workspace":WORKSPACE,"project":PROJECT}),
    ));
    serde_json::from_value::<WorkItemCollection>(items).unwrap();
    for (name, id) in [
        ("deskly_projects", PROJECT),
        ("deskly_milestones", MILESTONE),
        ("deskly_items", ITEM),
    ] {
        let mut args = json!({"workspace":WORKSPACE,"id":id});
        if name != "deskly_projects" {
            args["project"] = json!(PROJECT);
        }
        assert_eq!(result(&session.call(name, args))["id"], id);
    }
    let work = result(&session.call(
        "deskly_my_work",
        json!({"workspace":WORKSPACE,"member":MEMBER}),
    ));
    assert_eq!(work["items"][0]["id"], ITEM);
    let search = result(&session.call(
        "deskly_search",
        json!({"workspace":WORKSPACE,"query":"合成"}),
    ));
    assert_eq!(search["projects"].as_array().unwrap().len(), 1);
    let counts = result(&session.call("deskly_counts", json!({"workspace":WORKSPACE})));
    assert_eq!(counts["work_items"], 1);
    let history = result(&session.call(
        "deskly_history",
        json!({"workspace":WORKSPACE,"project":PROJECT}),
    ));
    serde_json::from_value::<EventCollection>(history).unwrap();
    for (tool, action) in [
        ("deskly_create", "create"),
        ("deskly_change", "update"),
        ("deskly_archive", "archive"),
        ("deskly_restore", "restore"),
    ] {
        let mut args = json!({"workspace":WORKSPACE,"entity":"project","reason":"合成確認"});
        if action != "create" {
            args["id"] = json!(PROJECT);
            args["version"] = json!(1);
        }
        if matches!(action, "create" | "update") {
            args["data"] =
                json!({"name":"合成案件","purpose":"合成目的","owner_id":MEMBER,"state":"未確認"});
        }
        let previous = server
            .requests()
            .iter()
            .filter(|r| r.path.ends_with("/apply"))
            .count();
        let preview = result(&session.call(tool, args.clone()));
        serde_json::from_value::<CommandPreview>(preview.clone()).unwrap();
        assert_eq!(preview["request"]["action"], action);
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|r| r.path.ends_with("/apply"))
                .count(),
            previous
        );
        args["apply"] = json!(true);
        let committed = result(&session.call(tool, args));
        serde_json::from_value::<CommandResult>(committed).unwrap();
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|r| r.path.ends_with("/apply"))
                .count(),
            previous + 1
        );
    }
    let before = server.requests().len();
    let invalid=session.call("deskly_archive",json!({"workspace":WORKSPACE,"entity":"project","id":PROJECT,"version":1,"reason":"合成確認","apply":"true"}));
    assert_eq!(invalid["result"]["isError"], true);
    assert_eq!(server.requests().len(), before);
    session.finish();
}

#[test]
fn stdio_conflicts_and_reflected_tokens_are_sanitized() {
    for status in [401, 403, 404, 409, 422, 500] {
        let server = MockServer::new(move |_| {
            Response::json(
                status,
                json!({"error":if status==409 {"version_conflict"} else {TOKEN},"message":TOKEN}),
            )
        });
        let home = TempHome::new();
        let mut session = Session::new(&server, &home);
        let response = session.call("deskly_projects", json!({"workspace":WORKSPACE}));
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(response["result"]["structuredContent"]["status"], status);
        if status == 409 {
            assert_eq!(
                response["result"]["structuredContent"]["error"],
                "version_conflict"
            );
        }
        session.finish();
    }
    let server = MockServer::new(|_| {
        let mut p = fixture("project");
        p["name"] = json!(TOKEN);
        Response::json(200, json!({"projects":[p],"archived_projects":[]}))
    });
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let response = session.call("deskly_projects", json!({"workspace":WORKSPACE}));
    assert_eq!(
        response["result"]["structuredContent"]["error"],
        "invalid_response"
    );
    session.finish();
}

#[test]
fn all_nine_contact_tools_roundtrip_and_writes_preserve_hidden_preview() {
    use support::contacts::{self as contact, *};
    let server = contact::server();
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let listed = session.request("tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool["name"]
                .as_str()
                .unwrap()
                .starts_with("deskly_contact_"))
            .count(),
        9
    );
    for (name, extra) in [
        ("waiting", json!({"include_all":true,"today":"2026-10-01"})),
        (
            "list_contacts",
            json!({"states":["下書き","回答待ち"],"project":"合成案件","query":"合成"}),
        ),
        ("list_cases", json!({"today":"2026-10-01"})),
        ("show_contact", json!({"id":CONTACT})),
        ("show_contact", json!({"id":CONTACT,"mode":"history"})),
        (
            "search_contacts",
            json!({"query":"合成 & 値","states":["下書き"]}),
        ),
    ] {
        let mut args = json!({"workspace":WORKSPACE,"source":SOURCE});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let value = result(&session.call(&format!("deskly_contact_{name}"), args));
        assert_private_absent(&value);
    }
    for (name, extra) in [
        ("show_contact", json!({"id":CONTACT,"mode":"body"})),
        ("export_text", json!({"id":CONTACT})),
    ] {
        let mut args = json!({"workspace":WORKSPACE,"source":SOURCE});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert_eq!(
            result(&session.call(&format!("deskly_contact_{name}"), args)),
            json!({"body":BODY})
        );
    }
    for (name, data) in [
        (
            "add_draft",
            json!({"body":BODY,"sensitive":PRIVATE,"project":"合成案件"}),
        ),
        ("set_state", json!({"state":"回答待ち"})),
        ("record_reply", json!({"summary":PRIVATE})),
    ] {
        for apply in [false, true] {
            let mut args =
                json!({"workspace":WORKSPACE,"source":SOURCE,"data":data,"reason":"合成確認"});
            if name != "add_draft" {
                args["id"] = json!(CONTACT);
                args["version"] = json!(1);
            }
            if apply {
                args["apply"] = json!(true);
            }
            let before = server.requests().len();
            let value = result(&session.call(&format!("deskly_contact_{name}"), args));
            assert_private_absent(&value);
            assert_eq!(value.get("preview_token").is_some(), !apply);
            let requests = server.requests();
            assert_eq!(requests.len() - before, if apply { 2 } else { 1 });
            assert!(requests[before]
                .path
                .ends_with("/contacts/commands/preview"));
            if apply {
                assert!(requests[before + 1]
                    .path
                    .ends_with("/contacts/commands/apply"));
            }
        }
    }
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|r| r.path.ends_with("/body"))
            .count(),
        2
    );
    session.finish();
}

#[test]
fn contact_mcp_rejects_invalid_state_before_http_and_sanitizes_failures() {
    use support::contacts::*;
    let server = MockServer::new(|_| panic!("invalid MCP contact input must not reach HTTP"));
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    for args in [
        json!({"data":{"state":"進行中"}}),
        json!({"data":{"state":"回答待ち"},"apply":"true"}),
        json!({"data":{"state":"回答待ち"},"id":"../invalid"}),
    ] {
        let mut base = json!({"workspace":WORKSPACE,"source":SOURCE,"id":CONTACT,"version":1,"reason":"合成確認"});
        base.as_object_mut()
            .unwrap()
            .extend(args.as_object().unwrap().clone());
        let response = session.call("deskly_contact_set_state", base);
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["error"],
            "validation_error"
        );
        assert_private_absent(&response);
    }
    assert!(server.requests().is_empty());
    session.finish();
    for (status, code) in [(403, "forbidden"), (409, "stale_preview")] {
        let server = MockServer::new(move |_| {
            Response::json(
                status,
                json!({"error":code,"message":format!("{TOKEN} {BODY} {PRIVATE}")}),
            )
        });
        let home = TempHome::new();
        let mut session = Session::new(&server, &home);
        let response=session.call("deskly_contact_set_state",json!({"workspace":WORKSPACE,"source":SOURCE,"id":CONTACT,"version":1,"data":{"state":"回答待ち"},"reason":"合成確認","apply":true}));
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(response["result"]["structuredContent"]["error"], code);
        assert_private_absent(&response);
        assert_eq!(server.requests().len(), 1);
        session.finish();
    }
}

#[test]
fn contact_mcp_tampered_preview_never_commits_and_body_token_is_rejected() {
    use support::contacts::*;
    for tamper in [false, true] {
        let server = MockServer::new(move |request| {
            if request.path.ends_with("/body") {
                return Response::json(200, json!({"body":TOKEN}));
            }
            assert!(request.path.ends_with("/preview"));
            let mut p = preview(request.body.as_ref().unwrap());
            if tamper {
                p["after"]["contact"]["body"] = json!("別の合成本文");
            } else {
                p["request"]["data"]["state"] = json!("完了");
            }
            Response::json(200, p)
        });
        let home = TempHome::new();
        let mut session = Session::new(&server, &home);
        for (name, args) in [
            (
                "set_state",
                json!({"id":CONTACT,"version":1,"data":{"state":"回答待ち"},"reason":"合成確認","apply":true}),
            ),
            ("export_text", json!({"id":CONTACT})),
        ] {
            let mut base = json!({"workspace":WORKSPACE,"source":SOURCE});
            base.as_object_mut()
                .unwrap()
                .extend(args.as_object().unwrap().clone());
            let response = session.call(&format!("deskly_contact_{name}"), base);
            assert_eq!(response["result"]["isError"], true);
            assert_eq!(
                response["result"]["structuredContent"]["error"],
                "invalid_response"
            );
            assert_private_absent(&response);
        }
        assert_eq!(server.requests().len(), 2);
        assert!(!server.requests().iter().any(|r| r.path.ends_with("/apply")));
        session.finish();
    }
}

const CASE_READ_TOOLS: [&str; 5] = [
    "deskly_case_list",
    "deskly_case_show",
    "deskly_case_panels",
    "deskly_case_settings",
    "deskly_entry_show",
];
const CASE_WRITE_TOOLS: [&str; 9] = [
    "deskly_case_set_status",
    "deskly_case_set_approval",
    "deskly_case_set_due",
    "deskly_case_reply",
    "deskly_case_link",
    "deskly_case_add_person",
    "deskly_case_complete",
    "deskly_case_link_commits",
    "deskly_entry_set",
];

#[test]
fn case_tools_roundtrip_and_every_write_waits_for_apply() {
    use support::cases as c;
    let ledger = c::shared();
    let server = c::server(&ledger);
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let listed = session.request("tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    for name in CASE_READ_TOOLS.iter().chain(CASE_WRITE_TOOLS.iter()) {
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == *name)
            .unwrap_or_else(|| panic!("{name} is not listed"));
        assert!(!tool["title"].as_str().unwrap().is_ascii());
        assert!(!tool["description"].as_str().unwrap().is_ascii());
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        let has_apply = tool["inputSchema"]["properties"].get("apply").is_some();
        assert_eq!(has_apply, CASE_WRITE_TOOLS.contains(name), "{name}");
        if has_apply {
            assert_eq!(tool["inputSchema"]["properties"]["apply"]["default"], false);
        }
    }

    let w = json!(WORKSPACE);
    let listing = result(&session.call(
        "deskly_case_list",
        json!({"workspace":w,"status":["fresh"],"overdue":true}),
    ));
    let items = listing["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["number"], c::NUMBER);
    assert!(items[0].get("body").is_none());
    let shown = result(&session.call(
        "deskly_case_show",
        json!({"workspace":w,"number":c::NUMBER}),
    ));
    assert!(shown["case"].get("body").is_none());
    let full = result(&session.call(
        "deskly_case_show",
        json!({"workspace":w,"number":c::NUMBER,"with_body":true}),
    ));
    assert_eq!(full["case"]["body"], c::BODY);
    assert_eq!(
        result(&session.call("deskly_case_panels", json!({"workspace":w})))["today"],
        c::TODAY
    );
    assert_eq!(
        result(&session.call("deskly_case_settings", json!({"workspace":w})))["statuses"]
            ["initial"],
        "fresh"
    );

    for (tool, extra, method) in [
        (
            "deskly_case_set_status",
            json!({"status":"triage"}),
            "PATCH",
        ),
        (
            "deskly_case_set_approval",
            json!({"approval_state":"parked","hold_until":"2026-11-01"}),
            "PATCH",
        ),
        ("deskly_case_set_due", json!({"promised_due":null}), "PATCH"),
        (
            "deskly_case_reply",
            json!({"body":c::REPLY,"author_ref":"agent-1"}),
            "POST",
        ),
        (
            "deskly_case_link",
            json!({"link_type":"doc","ref":"docs/local/plan_x.md"}),
            "POST",
        ),
        (
            "deskly_case_add_person",
            json!({"reporter_ref":"reporter-2"}),
            "POST",
        ),
    ] {
        let mut args = json!({"workspace":w,"number":c::WISH});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let before = c::writes(&server).len();
        let preview = result(&session.call(tool, args.clone()));
        assert_eq!(preview["preview"], true, "{tool}");
        assert_eq!(preview["send"][0]["method"], method);
        assert!(!preview.to_string().contains(c::REPLY));
        assert_eq!(
            c::writes(&server).len(),
            before,
            "{tool} wrote on a preview"
        );
        args["apply"] = json!(true);
        let applied = result(&session.call(tool, args));
        assert!(!applied.to_string().contains(c::REPLY));
        let sent = c::writes(&server);
        assert_eq!(sent.len(), before + 1, "{tool}");
        assert_eq!(sent[before].method, method);
    }

    // A completion without evidence is refused without any request.
    let before = server.requests().len();
    let refused = session.call(
        "deskly_case_complete",
        json!({"workspace":w,"number":c::NUMBER,"apply":true}),
    );
    assert_eq!(refused["result"]["isError"], true);
    assert_eq!(
        refused["result"]["structuredContent"]["error"],
        "evidence_required"
    );
    assert_eq!(server.requests().len(), before);
    let complete = json!({"workspace":w,"number":c::NUMBER,"evidence":[c::COMMIT,"https://example.test/pull/1"]});
    let writes_before = c::writes(&server).len();
    let preview = result(&session.call("deskly_case_complete", complete.clone()));
    assert_eq!(preview["complete"]["to_status"], "shipped");
    assert_eq!(c::writes(&server).len(), writes_before);
    let mut applying = complete;
    applying["apply"] = json!(true);
    let done = result(&session.call("deskly_case_complete", applying));
    assert_eq!(done["links_added"], 2);
    assert_eq!(done["status"], "shipped");
    assert_eq!(c::writes(&server).len(), writes_before + 3);
    session.finish();
}

#[test]
fn case_tools_reject_bad_input_locally_and_sanitize_failures() {
    use support::cases as c;
    let ledger = c::shared();
    ledger.lock().unwrap().failures.push(c::Failure {
        method: "POST",
        suffix: "/links".into(),
        status: 409,
        code: "version_conflict",
    });
    let server = c::server(&ledger);
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let base = json!({"workspace":WORKSPACE,"number":c::NUMBER});
    let missing = home.path().join("missing");
    for (tool, extra) in [
        (
            "deskly_case_set_status",
            json!({"status":"working","apply":"true"}),
        ),
        ("deskly_case_set_status", json!({"status":"Bad-Id"})),
        (
            "deskly_case_set_status",
            json!({"status":"working","actor":"forged"}),
        ),
        ("deskly_case_set_due", json!({"promised_due":"2026-02-30"})),
        ("deskly_case_set_due", json!({})),
        (
            "deskly_case_link",
            json!({"link_type":"commit","ref":"zzz"}),
        ),
        ("deskly_case_reply", json!({"body":"  "})),
        ("deskly_case_show", json!({"with_body":"yes"})),
        (
            "deskly_case_link_commits",
            json!({"repo":missing.to_str().unwrap()}),
        ),
    ] {
        let mut args = base.clone();
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let response = session.call(tool, args);
        assert_eq!(response["result"]["isError"], true, "{tool}");
        assert_eq!(
            response["result"]["structuredContent"]["error"], "validation_error",
            "{tool}"
        );
    }
    let mut number = base.clone();
    number["number"] = json!("../x");
    assert_eq!(
        session.call("deskly_case_show", number)["result"]["structuredContent"]["error"],
        "validation_error"
    );
    assert!(
        server.requests().is_empty(),
        "bad input must not reach the API"
    );

    // A status that is not in the settings is refused before anything is written.
    let mut bogus = base.clone();
    bogus["status"] = json!("bogus");
    bogus["apply"] = json!(true);
    let response = session.call("deskly_case_set_status", bogus);
    assert_eq!(
        response["result"]["structuredContent"]["error"],
        "not_in_settings"
    );
    assert!(c::writes(&server).is_empty());

    // An API conflict is named and never echoes the server text, the case text or the token.
    let mut link = base;
    link["link_type"] = json!("doc");
    link["ref"] = json!("docs/local/plan_x.md");
    link["apply"] = json!(true);
    let response = session.call("deskly_case_link", link);
    assert_eq!(response["result"]["isError"], true);
    assert_eq!(
        response["result"]["structuredContent"]["error"],
        "version_conflict"
    );
    assert_eq!(response["result"]["structuredContent"]["status"], 409);
    c::assert_no_text(&response.to_string());
    session.finish();
}

#[test]
fn entry_tools_set_and_show_a_project_entry_with_a_preview_first() {
    use support::cases as c;
    let (server, state) = c::entry_server(None);
    let home = TempHome::new();
    let mut session = Session::new(&server, &home);
    let missing = session.call(
        "deskly_entry_show",
        json!({"workspace":WORKSPACE,"project":PROJECT}),
    );
    assert_eq!(
        missing["result"]["structuredContent"]["error"],
        "entry_not_found"
    );
    let args =
        json!({"workspace":WORKSPACE,"project":PROJECT,"path":"docs/local/plan_x.md","next":"C3"});
    let preview = result(&session.call("deskly_entry_set", args.clone()));
    assert_eq!(
        preview["request"]["data"]["next_action"],
        "docs/local/plan_x.md 次: C3"
    );
    assert!(state.lock().unwrap().items.is_empty());
    let mut applying = args;
    applying["apply"] = json!(true);
    result(&session.call("deskly_entry_set", applying));
    let entry = result(&session.call(
        "deskly_entry_show",
        json!({"workspace":WORKSPACE,"project":PROJECT}),
    ));
    assert_eq!(entry["path"], "docs/local/plan_x.md");
    assert_eq!(entry["next"], "C3");
    let bad = session.call(
        "deskly_entry_set",
        json!({"workspace":WORKSPACE,"project":PROJECT,"path":"docs/a.md","next":"C1 次: C2"}),
    );
    assert_eq!(
        bad["result"]["structuredContent"]["error"],
        "validation_error"
    );
    session.finish();
}
