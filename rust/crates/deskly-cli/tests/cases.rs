mod support;

use serde_json::{json, Value};
use std::{fs, path::Path, process::Command as Process};
use support::{cases::*, *};

struct Out {
    ok: bool,
    stdout: Value,
    stderr: Value,
    text: String,
}

fn run(server: &MockServer, args: &[&str]) -> Out {
    let home = TempHome::new();
    let output = command(server, &home)
        .arg("--json")
        .args(args)
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Out {
        ok: output.status.success(),
        stdout: serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
        stderr: serde_json::from_slice(&output.stderr).unwrap_or(Value::Null),
        text,
    }
}
fn cases(server: &MockServer, args: &[&str]) -> Out {
    let mut all = vec!["cases"];
    all.extend_from_slice(args);
    run(server, &all)
}
fn ok(out: &Out) -> &Value {
    assert!(out.ok, "failed: {}", out.text);
    assert!(out.text.trim().lines().count() == 1, "{}", out.text);
    &out.stdout
}
fn fails<'a>(out: &'a Out, code: &str) -> &'a Value {
    assert!(!out.ok, "unexpected success: {}", out.text);
    assert_eq!(out.stderr["error"], code, "{}", out.text);
    assert!(out.stdout.is_null(), "stdout must stay empty on failure");
    assert_no_text(&out.text);
    &out.stderr
}
fn numbers(out: &Out) -> Vec<String> {
    ok(out)["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["number"].as_str().unwrap().to_owned())
        .collect()
}
fn forbidden_server() -> MockServer {
    MockServer::new(|request| {
        panic!(
            "must not reach the API: {} {}",
            request.method, request.path
        )
    })
}

#[test]
fn reads_use_the_owner_routes_and_text_needs_an_explicit_flag() {
    let ledger = shared();
    ledger
        .lock()
        .unwrap()
        .rows
        .get_mut(NUMBER)
        .unwrap()
        .replies
        .push(
            json!({"workspace_id":WORKSPACE,"case_number":NUMBER,"seq":1,"body":REPLY,
            "author":{"kind":"app","app":"app_one"},"author_ref":null,
            "created_at":"2026-10-01T00:00:00Z","delivered_at":null}),
        );
    let server = server(&ledger);

    let list = cases(&server, &["list"]);
    let items = ok(&list)["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert!(items.iter().all(|item| item.get("body").is_none()));
    assert_no_text(&list.text);

    let show = cases(&server, &["show", NUMBER]);
    let shown = ok(&show);
    assert!(shown["case"].get("body").is_none());
    assert!(shown["replies"][0]["body"]
        .as_str()
        .unwrap()
        .contains("表示しません"));
    assert_eq!(shown["events"][0]["action"], "create");
    assert_no_text(&show.text);

    let with_body = cases(&server, &["show", NUMBER, "--body"]);
    assert_eq!(ok(&with_body)["case"]["body"], BODY);
    assert_eq!(with_body.stdout["replies"][0]["body"], REPLY);

    assert_eq!(ok(&cases(&server, &["panels"]))["today"], TODAY);
    assert_eq!(
        ok(&cases(&server, &["settings"]))["statuses"]["terminal"],
        json!(["shipped", "dropped"])
    );

    let requests = server.requests();
    assert!(requests.iter().all(|r| r.method == "GET"));
    let paths: Vec<_> = requests.iter().map(|r| r.path.clone()).collect();
    assert_eq!(
        paths,
        [
            path(""),
            path(&format!("/{NUMBER}")),
            path(&format!("/{NUMBER}")),
            path("/panels"),
            path("/settings")
        ]
    );
}

#[test]
fn list_filters_are_checked_against_the_settings_and_applied_locally() {
    let server = server(&shared());
    let expect = |args: &[&str], expected: &[&str]| {
        assert_eq!(numbers(&cases(&server, args)), expected, "{args:?}");
    };
    expect(&["list", "--status", "shipped"], &[DONE_NUMBER]);
    expect(
        &["list", "--status", "fresh", "--status", "triage"],
        &[NUMBER, NEW_NUMBER],
    );
    expect(&["list", "--kind", "wish"], &[WISH]);
    expect(&["list", "--source", "app_two"], &[NEW_NUMBER, DONE_NUMBER]);
    expect(&["list", "--waiting", "us"], &[NUMBER, WISH]);
    expect(&["list", "--waiting", "them"], &[NEW_NUMBER]);
    // Overdue is open and past its promised date; a finished case is never overdue.
    expect(&["list", "--overdue"], &[NUMBER]);
    expect(
        &["list", "--overdue", "--today", "2026-10-10"],
        &[NUMBER, WISH],
    );
    expect(
        &[
            "list",
            "--overdue",
            "--kind",
            "wish",
            "--today",
            "2026-10-10",
        ],
        &[WISH],
    );

    let before = server.requests().len();
    let unknown = cases(&server, &["list", "--status", "bogus"]);
    fails(&unknown, "not_in_settings");
    let unknown = cases(&server, &["list", "--kind", "bogus"]);
    fails(&unknown, "not_in_settings");
    // Only the settings were read; the list itself was never requested.
    let requests = server.requests();
    assert_eq!(requests.len() - before, 2);
    assert!(requests[before..]
        .iter()
        .all(|r| r.path == path("/settings")));

    let blocked = forbidden_server();
    for args in [
        vec!["list", "--waiting", "soon"],
        vec!["list", "--today", "2026-10-10"],
        vec!["list", "--overdue", "--today", "2026-02-30"],
        vec!["list", "--source", "Bad Source"],
    ] {
        fails(&cases(&blocked, &args), "validation_error");
    }
    assert!(blocked.requests().is_empty());
}

#[test]
fn every_write_previews_by_default_and_apply_sends_exactly_the_previewed_request() {
    let all: Vec<(&str, Vec<&str>)> = vec![
        ("PATCH", vec!["set-status", NUMBER, "working"]),
        (
            "PATCH",
            vec!["set-approval", WISH, "parked", "--hold-until", "2026-11-01"],
        ),
        (
            "PATCH",
            vec![
                "set-due",
                NUMBER,
                "--promised-due",
                "2026-12-01",
                "--hold-until",
                "none",
            ],
        ),
        (
            "POST",
            vec!["reply", NUMBER, "--body", REPLY, "--author-ref", "agent-1"],
        ),
        (
            "POST",
            vec![
                "link",
                NUMBER,
                "--type",
                "doc",
                "--ref",
                "docs/local/plan_x.md",
            ],
        ),
        (
            "POST",
            vec!["people-add", NUMBER, "--reporter-ref", "reporter-2"],
        ),
    ];
    for (method, args) in all {
        let ledger = shared();
        let server = server(&ledger);
        let preview = cases(&server, &args);
        let shown = ok(&preview);
        assert_eq!(shown["preview"], true, "{args:?}");
        assert_eq!(shown["send"].as_array().unwrap().len(), 1);
        let send = &shown["send"][0];
        assert_eq!(send["method"], method);
        assert!(writes(&server).is_empty(), "a preview must send nothing");
        assert_no_text(&preview.text);

        let mut applying = args.clone();
        applying.push("--apply");
        let applied = cases(&server, &applying);
        ok(&applied);
        assert_no_text(&applied.text);
        let sent = writes(&server);
        assert_eq!(sent.len(), 1, "{args:?}");
        assert_eq!(sent[0].method, method);
        assert_eq!(sent[0].path, send["path"]);
        let body = sent[0].body.clone().unwrap();
        if args[0] == "reply" {
            // The text itself is sent but is never shown back.
            assert_eq!(body["body"], REPLY);
            assert_eq!(body["author_ref"], send["body"]["author_ref"]);
            assert!(send["body"]["body"]
                .as_str()
                .unwrap()
                .contains("表示しません"));
        } else {
            assert_eq!(&body, &send["body"], "{args:?}");
        }
    }
}

#[test]
fn identifiers_come_from_the_settings_and_never_from_the_code() {
    // The synthetic words above (fresh, shipped, parked ...) work, and the sample deployment's
    // words are not in the sources at all.
    for (name, source) in [
        ("cases.rs", include_str!("../src/cases.rs")),
        ("main.rs", include_str!("../src/main.rs")),
        ("mcp.rs", include_str!("../src/mcp.rs")),
    ] {
        for word in [
            "\"done\"",
            "\"wont_do\"",
            "\"in_progress\"",
            "\"investigated\"",
            "\"not_required\"",
            "\"pending\"",
            "\"approved\"",
            "\"rejected\"",
            "\"on_hold\"",
            "\"bug\"",
            "\"question\"",
            "\"note\"",
            "\"new\"",
        ] {
            assert!(!source.contains(word), "{name} embeds {word}");
        }
    }
    let ledger = shared();
    let server = server(&ledger);
    fails(
        &cases(&server, &["set-status", NUMBER, "bogus", "--apply"]),
        "not_in_settings",
    );
    fails(
        &cases(&server, &["set-approval", NUMBER, "bogus", "--apply"]),
        "not_in_settings",
    );
    assert!(writes(&server).is_empty());
    let done = cases(&server, &["set-status", NUMBER, "dropped", "--apply"]);
    let result = ok(&done);
    assert_eq!(result["applied"], true);
    assert!(result["case"].get("body").is_none());
    assert_eq!(result["case"]["status"], "dropped");
    let guard = ledger.lock().unwrap();
    assert!(!guard.row(NUMBER).case["closed_at"].is_null());
}

#[test]
fn approval_hold_expiry_conflicts_and_no_change_are_handled() {
    let ledger = shared();
    {
        let mut guard = ledger.lock().unwrap();
        let wish = &mut guard.rows.get_mut(WISH).unwrap().case;
        wish["approval_state"] = json!("parked");
        wish["hold_until"] = json!("2026-11-01");
    }
    let server = server(&ledger);
    // Leaving the hold takes its expiry with it, in the same request.
    ok(&cases(
        &server,
        &["set-approval", WISH, "granted", "--apply"],
    ));
    let sent = writes(&server);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].body.clone().unwrap(),
        json!({"expected_revision":1,"approval_state":"granted","hold_until":null})
    );
    assert!(ledger.lock().unwrap().row(WISH).case["hold_until"].is_null());

    // A hold expiry on a case that is not on hold is the API's 400, shown by its identifier.
    let refused = cases(
        &server,
        &["set-due", NUMBER, "--hold-until", "2026-12-01", "--apply"],
    );
    let error = fails(&refused, "hold_until_requires_hold");
    assert_eq!(error["status"], 400);
    // An expiry argument for a state that is not the hold never leaves the process.
    let before = writes(&server).len();
    fails(
        &cases(
            &server,
            &[
                "set-approval",
                NUMBER,
                "granted",
                "--hold-until",
                "2026-11-01",
                "--apply",
            ],
        ),
        "validation_error",
    );
    assert_eq!(writes(&server).len(), before);

    // Nothing to change: nothing is sent, in a preview or an apply.
    let preview = cases(&server, &["set-status", NUMBER, "fresh"]);
    assert_eq!(ok(&preview)["no_change"], true);
    assert_eq!(preview.stdout["send"], json!([]));
    let applied = cases(&server, &["set-status", NUMBER, "fresh", "--apply"]);
    assert_eq!(ok(&applied)["applied"], false);
    assert_eq!(applied.stdout["no_change"], true);
    assert_eq!(writes(&server).len(), before);

    // A pinned revision that is no longer current is a conflict before anything is sent.
    let stale = cases(
        &server,
        &[
            "set-status",
            NUMBER,
            "working",
            "--revision",
            "5",
            "--apply",
        ],
    );
    assert_eq!(fails(&stale, "version_conflict")["status"], 409);
    assert_eq!(writes(&server).len(), before);
    ok(&cases(
        &server,
        &[
            "set-status",
            NUMBER,
            "working",
            "--revision",
            "1",
            "--reason",
            "合成理由",
            "--actor-ref",
            "agent-1",
            "--apply",
        ],
    ));
    let guard = ledger.lock().unwrap();
    let event = guard.row(NUMBER).events.last().unwrap();
    assert_eq!(event["reason"], "合成理由");
    assert_eq!(event["actor_ref"], "agent-1");
}

#[test]
fn completion_is_refused_without_evidence_before_anything_is_read() {
    let server = forbidden_server();
    let out = cases(&server, &["complete", NUMBER, "--apply"]);
    let error = fails(&out, "evidence_required");
    assert!(error["message"].as_str().unwrap().contains("--evidence"));
    assert!(server.requests().is_empty());
    for evidence in ["commit:xyz", "url:ftp://example.test/x", "doc:with space"] {
        fails(
            &cases(&server, &["complete", NUMBER, "--evidence", evidence]),
            "validation_error",
        );
    }
    assert!(server.requests().is_empty());
}

#[test]
fn completion_adds_the_evidence_first_then_sets_a_terminal_status_and_is_repeatable() {
    let ledger = shared();
    let server = server(&ledger);
    let args = [
        "complete",
        NUMBER,
        "--evidence",
        COMMIT,
        "--evidence",
        "docs/local/plan_x.md",
        "--evidence",
        "url:https://example.test/pull/1",
        "--evidence",
        COMMIT,
    ];
    let preview = cases(&server, &args);
    let shown = ok(&preview);
    assert_eq!(shown["preview"], true);
    assert_eq!(shown["current"]["status"], "fresh");
    // No status is named: the first terminal status of the settings is the target.
    assert_eq!(shown["complete"]["to_status"], "shipped");
    assert_eq!(shown["complete"]["status_changes"], true);
    let kinds: Vec<_> = shown["complete"]["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["link_type"].as_str().unwrap(), e["ref"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("commit", COMMIT),
            ("doc", "docs/local/plan_x.md"),
            ("url", "https://example.test/pull/1")
        ]
    );
    let planned: Vec<_> = shown["send"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["method"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(planned, ["POST", "POST", "POST", "PATCH"]);
    assert!(writes(&server).is_empty());

    let mut applying = args.to_vec();
    applying.push("--apply");
    let applied = cases(&server, &applying);
    assert_eq!(
        ok(&applied),
        &json!({"applied":true,"number":NUMBER,"status":"shipped","status_changed":true,
            "links_added":3,"links_present":0,"evidence_missing":false})
    );
    let sent = writes(&server);
    assert_eq!(sent.len(), 4);
    assert!(sent[..3].iter().all(|r| r.path.ends_with("/links")));
    assert_eq!(sent[3].method, "PATCH");
    assert_eq!(
        sent[3].body.clone().unwrap(),
        json!({"expected_revision":1,"status":"shipped"})
    );
    {
        let guard = ledger.lock().unwrap();
        assert_eq!(guard.row(NUMBER).links.len(), 3);
        assert_eq!(guard.row(NUMBER).case["status"], "shipped");
        assert!(!guard.row(NUMBER).case["closed_at"].is_null());
    }

    // The same completion again: the same evidence stays one row and nothing is sent.
    let again = cases(&server, &applying);
    let result = ok(&again);
    assert_eq!(result["links_added"], 0);
    assert_eq!(result["links_present"], 3);
    assert_eq!(result["status_changed"], false);
    assert_eq!(writes(&server).len(), 4);
}

#[test]
fn completion_status_comes_from_the_terminal_list_and_a_terminal_case_keeps_its_own() {
    let ledger = shared();
    {
        let mut guard = ledger.lock().unwrap();
        let case = &mut guard.rows.get_mut(NEW_NUMBER).unwrap().case;
        case["status"] = json!("dropped");
        case["closed_at"] = json!("2026-10-01T00:00:00Z");
    }
    let server = server(&ledger);
    // Already terminal and no status named: it is not moved to another terminal status.
    let kept = cases(
        &server,
        &[
            "complete",
            NEW_NUMBER,
            "--evidence",
            OTHER_COMMIT,
            "--apply",
        ],
    );
    assert_eq!(ok(&kept)["status"], "dropped");
    assert_eq!(kept.stdout["status_changed"], false);
    assert_eq!(writes(&server).len(), 1);
    // An explicit terminal status is used.
    let explicit = cases(
        &server,
        &[
            "complete",
            NUMBER,
            "--status",
            "dropped",
            "--evidence",
            COMMIT,
            "--apply",
        ],
    );
    assert_eq!(ok(&explicit)["status"], "dropped");
    let before = writes(&server).len();
    // Not terminal, or not in the settings: refused before anything is sent.
    fails(
        &cases(
            &server,
            &[
                "complete",
                WISH,
                "--status",
                "working",
                "--evidence",
                COMMIT,
                "--apply",
            ],
        ),
        "not_terminal",
    );
    fails(
        &cases(
            &server,
            &[
                "complete",
                WISH,
                "--status",
                "bogus",
                "--evidence",
                COMMIT,
                "--apply",
            ],
        ),
        "not_in_settings",
    );
    assert_eq!(writes(&server).len(), before);
}

#[test]
fn completion_without_evidence_needs_the_explicit_flag_and_is_marked_in_the_list() {
    let ledger = shared();
    let server = server(&ledger);
    let done = cases(
        &server,
        &["complete", NUMBER, "--allow-no-evidence", "--apply"],
    );
    let result = ok(&done);
    assert_eq!(result["status"], "shipped");
    assert_eq!(result["links_added"], 0);
    assert_eq!(result["evidence_missing"], true);
    let list = cases(&server, &["list", "--status", "shipped"]);
    let items = ok(&list)["items"].as_array().unwrap();
    let marked = |number: &str| {
        items.iter().find(|i| i["number"] == number).unwrap()["evidence_missing"].clone()
    };
    assert_eq!(marked(NUMBER), true);
    assert_eq!(marked(DONE_NUMBER), false);
}

#[test]
fn completion_conflict_is_clear_and_a_second_run_finishes_the_job() {
    let ledger = shared();
    ledger.lock().unwrap().failures.push(Failure {
        method: "PATCH",
        suffix: format!("/{NUMBER}"),
        status: 409,
        code: "version_conflict",
    });
    let server = server(&ledger);
    let args = ["complete", NUMBER, "--evidence", COMMIT, "--apply"];
    let out = cases(&server, &args);
    let error = fails(&out, "version_conflict");
    assert_eq!(error["status"], 409);
    assert!(error["message"].as_str().unwrap().contains("競合"));
    // The evidence was added and the status was not changed.
    assert_eq!(ledger.lock().unwrap().row(NUMBER).links.len(), 1);
    assert_eq!(ledger.lock().unwrap().row(NUMBER).case["status"], "fresh");
    // No retry happened inside the command.
    assert_eq!(writes(&server).len(), 2);

    ledger.lock().unwrap().failures.clear();
    let again = cases(&server, &args);
    let result = ok(&again);
    assert_eq!(result["links_added"], 0);
    assert_eq!(result["status_changed"], true);
    assert_eq!(ledger.lock().unwrap().row(NUMBER).case["status"], "shipped");
}

#[test]
fn api_failures_are_named_and_never_echo_server_text_or_the_token() {
    for (method, suffix, status, code, expected, args) in [
        ("GET", "", 403, "forbidden", "forbidden", vec!["list"]),
        (
            "GET",
            "/settings",
            403,
            "forbidden",
            "forbidden",
            vec!["settings"],
        ),
        (
            "GET",
            "/panels",
            404,
            "cases_not_enabled",
            "cases_not_enabled",
            vec!["panels"],
        ),
        (
            "GET",
            "/panels",
            401,
            "unauthorized",
            "unauthorized",
            vec!["panels"],
        ),
        (
            "GET",
            "/app_one-7",
            404,
            "not_found",
            "not_found",
            vec!["show", NUMBER],
        ),
        (
            "POST",
            "/links",
            409,
            "version_conflict",
            "version_conflict",
            vec![
                "link",
                NUMBER,
                "--type",
                "doc",
                "--ref",
                "docs/x.md",
                "--apply",
            ],
        ),
        (
            "POST",
            "/replies",
            403,
            "forbidden",
            "forbidden",
            vec!["reply", NUMBER, "--body", REPLY, "--apply"],
        ),
        (
            "PATCH",
            "/app_one-7",
            400,
            "invalid_status",
            "invalid_status",
            vec!["set-status", NUMBER, "working", "--apply"],
        ),
        ("GET", "", 500, "boom", "http_error", vec!["list"]),
    ] {
        let ledger = shared();
        ledger.lock().unwrap().failures.push(Failure {
            method,
            suffix: suffix.to_owned(),
            status,
            code,
        });
        let server = server(&ledger);
        let out = cases(&server, &args);
        let error = fails(&out, expected);
        assert_eq!(error["status"], status);
        if expected == "forbidden" {
            assert!(error["message"].as_str().unwrap().contains("owner"));
        }
    }
}

#[test]
fn case_and_reply_text_or_the_token_in_a_response_is_rejected_not_printed() {
    for tamper in ["list", "show"] {
        let server = MockServer::new(move |request| {
            let ledger = Ledger::new();
            let mut row = ledger.row(NUMBER).case.clone();
            row["body"] = json!(TOKEN);
            if request.path.ends_with(NUMBER) {
                Response::json(
                    200,
                    json!({"case":row,"people":[],"replies":[],"links":[],"events":ledger.row(NUMBER).events}),
                )
            } else {
                row["evidence_missing"] = json!(false);
                Response::json(200, json!({"items":[row]}))
            }
        });
        let args: Vec<&str> = if tamper == "list" {
            vec!["list"]
        } else {
            vec!["show", NUMBER, "--body"]
        };
        fails(&cases(&server, &args), "invalid_response");
    }
}

#[test]
fn reply_reads_a_file_stores_it_exactly_and_never_prints_it() {
    let ledger = shared();
    let server = server(&ledger);
    let home = TempHome::new();
    let file = home.path().join("reply.txt");
    fs::write(&file, format!("  {REPLY}\n二行目")).unwrap();
    let at = format!("@{}", file.display());
    let out = cases(
        &server,
        &[
            "reply",
            NUMBER,
            "--body",
            &at,
            "--delivered-at",
            "2026-10-01T00:00:05Z",
            "--apply",
        ],
    );
    let result = ok(&out);
    assert_eq!(result["reply"]["seq"], 1);
    assert_eq!(result["reply"]["delivered_at"], "2026-10-01T00:00:05Z");
    assert_no_text(&out.text);
    let stored = ledger.lock().unwrap().row(NUMBER).replies[0]["body"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(stored, format!("  {REPLY}\n二行目"));
    let writes = writes(&server);
    assert_eq!(writes.len(), 1);
    assert!(writes[0].path.ends_with("/replies"));
}

#[test]
fn links_and_people_are_one_row_however_often_they_are_sent() {
    let ledger = shared();
    let server = server(&ledger);
    let link = [
        "link",
        NUMBER,
        "--type",
        "url",
        "--ref",
        "https://example.test/a",
        "--apply",
    ];
    assert_eq!(ok(&cases(&server, &link))["already_present"], false);
    let again = cases(&server, &link);
    assert_eq!(ok(&again)["already_present"], true);
    assert_eq!(ok(&again)["applied"], false);
    let person = [
        "people-add",
        NUMBER,
        "--reporter-ref",
        "reporter-9",
        "--apply",
    ];
    ok(&cases(&server, &person));
    ok(&cases(&server, &person));
    assert_eq!(writes(&server).len(), 2);
    let guard = ledger.lock().unwrap();
    assert_eq!(guard.row(NUMBER).links.len(), 1);
    assert_eq!(guard.row(NUMBER).people.len(), 1);
}

#[test]
fn invalid_input_fails_before_the_network() {
    let server = forbidden_server();
    let missing = TempHome::new().path().join("missing");
    let missing = missing.to_str().unwrap().to_owned();
    for args in [
        vec!["show", "../x"],
        vec!["show", "App_One-1"],
        vec!["set-status", NUMBER, "Bad-Id"],
        vec!["set-due", NUMBER],
        vec!["set-due", NUMBER, "--promised-due", "2026-02-30"],
        vec!["link", NUMBER, "--type", "note", "--ref", "x"],
        vec!["link", NUMBER, "--type", "commit", "--ref", "zzz"],
        vec![
            "link",
            NUMBER,
            "--type",
            "url",
            "--ref",
            "ftp://example.test/x",
        ],
        vec!["reply", NUMBER, "--body", "  "],
        vec![
            "reply",
            NUMBER,
            "--body",
            "x",
            "--delivered-at",
            "2026-10-01",
        ],
        vec!["people-add", NUMBER, "--reporter-ref", " "],
        vec!["link-commits", NUMBER, "--repo", &missing],
    ] {
        fails(&cases(&server, &args), "validation_error");
    }
    assert!(server.requests().is_empty());
}

fn git(dir: &Path, home: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .current_dir(dir)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic-author",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .output()
        .expect("git must be installed to run this test");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn link_commits_picks_only_the_exact_ref_line_from_a_real_repository() {
    let scratch = TempHome::new();
    let repo = scratch.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, scratch.path(), &["init", "-q"]);
    let mut made = Vec::new();
    for (title, text) in [
        (
            "synthetic one",
            Some("Ref: app_one-7\nCo-Authored-By: Synthetic Helper"),
        ),
        ("synthetic two", Some("Ref: app_one-70")),
        (
            "synthetic three",
            Some("first paragraph\nRef: app_one-7\nmore text"),
        ),
        ("synthetic four", None),
        ("synthetic five", Some("Ref: app_one-7 with extra words")),
    ] {
        let mut args = vec!["commit", "--allow-empty", "-q", "-m", title];
        if let Some(text) = text {
            args.extend(["-m", text]);
        }
        git(&repo, scratch.path(), &args);
        made.push(git(&repo, scratch.path(), &["rev-parse", "HEAD"]));
    }
    let mut expected = vec![made[0].clone(), made[2].clone()];
    expected.sort();

    let ledger = shared();
    let server = server(&ledger);
    let repo_arg = repo.to_str().unwrap();
    let args = ["link-commits", NUMBER, "--repo", repo_arg];
    let preview = cases(&server, &args);
    let shown = ok(&preview);
    let mut found: Vec<String> = shown["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    found.sort();
    assert_eq!(found, expected);
    assert!(writes(&server).is_empty());

    let mut applying = args.to_vec();
    applying.push("--apply");
    let applied = cases(&server, &applying);
    assert_eq!(ok(&applied)["links_added"], 2);
    let sent = writes(&server);
    assert_eq!(sent.len(), 2);
    for request in &sent {
        assert_eq!(request.body.as_ref().unwrap()["link_type"], "commit");
    }
    assert_eq!(ok(&cases(&server, &applying))["links_added"], 0);
    assert_eq!(writes(&server).len(), 2);
    assert_eq!(ledger.lock().unwrap().row(NUMBER).links.len(), 2);

    // The repository is only read.
    assert_eq!(git(&repo, scratch.path(), &["status", "--porcelain"]), "");
    // An unknown revision and a directory that is not a repository are named, not crashed.
    let unknown = cases(
        &server,
        &[
            "link-commits",
            NUMBER,
            "--repo",
            repo_arg,
            "--rev",
            "no-such-branch",
        ],
    );
    fails(&unknown, "git_failed");
    let plain = scratch.path().join("plain");
    fs::create_dir(&plain).unwrap();
    let outside = cases(
        &server,
        &["link-commits", NUMBER, "--repo", plain.to_str().unwrap()],
    );
    fails(&outside, "git_failed");
}

#[test]
fn link_commits_names_a_missing_git() {
    let scratch = TempHome::new();
    let repo = scratch.path().join("repo");
    fs::create_dir(&repo).unwrap();
    let empty = scratch.path().join("empty-path");
    fs::create_dir(&empty).unwrap();
    let server = server(&shared());
    let output = command(&server, &scratch)
        .env("PATH", &empty)
        .args(["--json", "cases", "link-commits", NUMBER, "--repo"])
        .arg(&repo)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"], "git_unavailable");
    assert!(output.stdout.is_empty());
    assert!(server.requests().is_empty());
}

#[test]
fn entry_round_trips_through_the_work_item_api_with_a_preview_first() {
    let (server, state) = entry_server(None);
    let missing = run(&server, &["entry", "show", "--project", PROJECT]);
    fails(&missing, "entry_not_found");

    let set = [
        "entry",
        "set",
        "--project",
        PROJECT,
        "--path",
        "docs/local/plan_x.md",
        "--next",
        "C3",
    ];
    let preview = run(&server, &set);
    let shown = ok(&preview);
    assert_eq!(shown["request"]["action"], "create");
    assert_eq!(shown["request"]["data"]["title"], "入口");
    assert_eq!(
        shown["request"]["data"]["next_action"],
        "docs/local/plan_x.md 次: C3"
    );
    assert_eq!(shown["request"]["data"]["assignee_id"], MEMBER);
    let applies = |server: &MockServer| {
        server
            .requests()
            .iter()
            .filter(|r| r.path.ends_with("/commands/apply"))
            .count()
    };
    assert_eq!(applies(&server), 0);
    assert!(state.lock().unwrap().items.is_empty());

    let mut applying = set.to_vec();
    applying.push("--apply");
    ok(&run(&server, &applying));
    assert_eq!(applies(&server), 1);
    let read = run(&server, &["entry", "show", "--project", PROJECT]);
    let entry = ok(&read);
    assert_eq!(entry["path"], "docs/local/plan_x.md");
    assert_eq!(entry["next"], "C3");
    assert_eq!(entry["work_item_id"], ITEM);

    // An existing entry is updated in place; the other fields stay as they were.
    let update = [
        "entry",
        "set",
        "--project",
        PROJECT,
        "--path",
        "docs/local/plan_x.md",
        "--next",
        "C4",
        "--reason",
        "合成の更新",
        "--apply",
    ];
    let updated = run(&server, &update);
    ok(&updated);
    let preview = state.lock().unwrap().last.clone();
    assert_eq!(preview["request"]["action"], "update");
    assert_eq!(preview["request"]["expected_version"], 1);
    assert_eq!(preview["request"]["data"]["title"], "入口");
    assert_eq!(preview["request"]["reason"], "合成の更新");
    assert_eq!(
        ok(&run(&server, &["entry", "show", "--project", PROJECT]))["next"],
        "C4"
    );
}

#[test]
fn entry_is_unambiguous_and_its_input_is_checked_before_the_network() {
    let (server, state) = entry_server(Some("docs/a.md 次: C1"));
    let second = state.lock().unwrap().items[0].clone();
    state.lock().unwrap().items.push(second);
    fails(
        &run(&server, &["entry", "show", "--project", PROJECT]),
        "entry_ambiguous",
    );
    {
        let mut guard = state.lock().unwrap();
        guard.items[0]["archived"] = json!(true);
        guard.items[1]["archived"] = json!(true);
    }
    fails(
        &run(&server, &["entry", "show", "--project", PROJECT]),
        "entry_not_found",
    );

    let blocked = forbidden_server();
    for (path, next) in [
        ("", "C1"),
        ("docs/a.md", ""),
        (" docs/a.md", "C1"),
        ("docs/a.md", "C1 "),
        ("docs/a 次: b.md", "C1"),
        ("docs/a.md", "C1 次: C2"),
        ("docs/a.md\nb", "C1"),
    ] {
        fails(
            &run(
                &blocked,
                &[
                    "entry",
                    "set",
                    "--project",
                    PROJECT,
                    "--path",
                    path,
                    "--next",
                    next,
                ],
            ),
            "validation_error",
        );
    }
    fails(
        &run(&blocked, &["entry", "show", "--project", "not-an-id"]),
        "validation_error",
    );
    assert!(blocked.requests().is_empty());
}

#[test]
fn help_for_cases_and_entry_works_without_configuration() {
    for (command, names) in [
        (
            "cases",
            vec![
                "list",
                "show",
                "panels",
                "settings",
                "set-status",
                "set-approval",
                "set-due",
                "reply",
                "link",
                "people-add",
                "complete",
                "link-commits",
            ],
        ),
        ("entry", vec!["show", "set"]),
    ] {
        let output = Process::new(env!("CARGO_BIN_EXE_deskly"))
            .env_clear()
            .args([command, "--help"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        for name in names {
            assert!(text.contains(name), "{command} --help lacks {name}");
        }
    }
}
