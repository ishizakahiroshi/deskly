mod support;
use serde_json::{json, Value};
use support::{contacts::*, *};

fn run(server: &MockServer, args: &[&str]) -> Value {
    let home = TempHome::new();
    let output = command(server, &home)
        .args(["--json", "contacts", "--source", SOURCE])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn contact_cli_reads_use_owner_routes_and_body_is_only_explicit() {
    let server = server();
    for args in [
        vec!["list"],
        vec!["detail", CONTACT],
        vec!["history", CONTACT],
        vec![
            "search",
            "合成 & 値",
            "--state",
            "下書き",
            "--state",
            "回答待ち",
            "--project",
            "合成案件",
        ],
        vec!["cases"],
    ] {
        let result = run(&server, &args);
        assert_private_absent(&result);
    }
    for operation in ["body", "export-text"] {
        assert_eq!(run(&server, &[operation, CONTACT]), json!({"body":BODY}));
    }
    let home = TempHome::new();
    let output = command(&server, &home)
        .args([
            "--json",
            "waiting",
            "--source",
            SOURCE,
            "--include-all",
            "--today",
            "2026-10-01",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_private_absent(&serde_json::from_slice(&output.stdout).unwrap());
    let requests = server.requests();
    let base = format!("/api/v1/workspaces/{WORKSPACE}/sources/{SOURCE}");
    assert!(requests.iter().all(|r| r.path.starts_with(&base)));
    assert_eq!(requests[0].path, format!("{base}/contacts"));
    assert_eq!(requests[1].path, format!("{base}/contacts/{CONTACT}"));
    assert_eq!(
        requests[2].path,
        format!("{base}/contacts/{CONTACT}/history")
    );
    let pairs: Vec<_> =
        url::form_urlencoded::parse(requests[3].path.split_once('?').unwrap().1.as_bytes())
            .into_owned()
            .collect();
    assert!(pairs.contains(&("q".into(), "合成 & 値".into())));
    assert_eq!(pairs.iter().filter(|(k, _)| k == "state").count(), 2);
    assert!(requests[4].path.contains("include_all=true"));
    assert!(requests[5].path.ends_with("/body"));
    assert!(requests[6].path.ends_with("/body"));
    assert!(requests[7].path.contains("today=2026-10-01"));
}
#[test]
fn every_contact_write_previews_by_default_and_applies_exactly_the_hidden_preview() {
    let draft =
        json!({"project":"合成案件","body":BODY,"sensitive":PRIVATE,"extra":{"synthetic":PRIVATE}})
            .to_string();
    for args in [
        vec!["add-draft", "--data", &draft],
        vec!["set-state", CONTACT, "回答待ち", "--version", "1"],
        vec!["record-reply", CONTACT, PRIVATE, "--version", "1"],
    ] {
        for apply in [false, true] {
            let server = server();
            let mut args = args.clone();
            args.extend(["--reason", "合成確認"]);
            if apply {
                args.push("--apply");
            }
            let result = run(&server, &args);
            assert_private_absent(&result);
            assert_eq!(result.get("preview_token").is_some(), !apply);
            let requests = server.requests();
            assert_eq!(requests.len(), if apply { 2 } else { 1 });
            assert!(requests[0].path.ends_with("/contacts/commands/preview"));
            if apply {
                assert!(requests[1].path.ends_with("/contacts/commands/apply"));
            }
            let _: deskly_types::ContactActionCommand =
                serde_json::from_value(requests[0].body.clone().unwrap()).unwrap();
        }
    }
}
#[test]
fn tampered_command_snapshot_scope_and_version_never_apply() {
    for tamper in [
        "request",
        "after",
        "workspace",
        "version",
        "before",
        "timestamp",
    ] {
        let server = MockServer::new(move |request| {
            assert!(
                request.path.ends_with("/preview"),
                "tampered preview must not be applied"
            );
            let mut p = preview(request.body.as_ref().unwrap());
            match tamper {
                "request" => p["request"]["data"]["state"] = json!("完了"),
                "after" => p["after"]["contact"]["body"] = json!("別の合成本文"),
                "workspace" => p["after"]["workspace_id"] = json!(SOURCE),
                "version" => p["after"]["version"] = json!(3),
                "timestamp" => p["after"]["contact"]["updated_at"] = json!(BODY),
                _ => p["before"]["version"] = json!(2),
            }
            Response::json(200, p)
        });
        let home = TempHome::new();
        let output = command(&server, &home)
            .args([
                "--json",
                "contacts",
                "--source",
                SOURCE,
                "set-state",
                CONTACT,
                "回答待ち",
                "--version",
                "1",
                "--reason",
                "合成確認",
                "--apply",
            ])
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"], "invalid_response");
        assert_private_absent(&error);
        assert!(output.stdout.is_empty());
        assert_eq!(server.requests().len(), 1);
    }
}
#[test]
fn contact_errors_are_safe_owner_and_conflict_messages_without_retry() {
    for (status, code) in [
        (403, "forbidden"),
        (409, "version_conflict"),
        (409, "stale_preview"),
        (409, "operation_conflict"),
    ] {
        for stage in ["read", "preview", "apply"] {
            let server = MockServer::new(move |request| {
                if stage == "apply" && request.path.ends_with("/preview") {
                    return Response::json(200, preview(request.body.as_ref().unwrap()));
                }
                Response::json(
                    status,
                    json!({"error":code,"message":format!("{TOKEN} {BODY} {PRIVATE}"),"body":BODY}),
                )
            });
            let home = TempHome::new();
            let args = if stage == "read" {
                vec!["detail", CONTACT]
            } else {
                vec![
                    "set-state",
                    CONTACT,
                    "回答待ち",
                    "--version",
                    "1",
                    "--reason",
                    "合成確認",
                    "--apply",
                ]
            };
            let output = command(&server, &home)
                .args(["--json", "contacts", "--source", SOURCE])
                .args(args)
                .output()
                .unwrap();
            assert!(!output.status.success());
            let error: Value = serde_json::from_slice(&output.stderr).unwrap();
            assert_eq!(error["error"], code);
            assert_eq!(error["status"], status);
            if status == 403 {
                assert!(error["message"].as_str().unwrap().contains("owner"));
            }
            assert_private_absent(&error);
            assert!(output.stdout.is_empty());
            assert_eq!(
                server.requests().len(),
                if stage == "apply" { 2 } else { 1 }
            );
        }
    }
}
#[test]
fn contact_invalid_states_ids_dates_and_data_fail_before_network() {
    let server = MockServer::new(|_| panic!("invalid input must not contact the API"));
    let draft = json!({"state":"完了"}).to_string();
    for args in [
        vec!["list", "--state", "未確認"],
        vec![
            "set-state",
            CONTACT,
            "進行中",
            "--version",
            "1",
            "--reason",
            "合成確認",
            "--apply",
        ],
        vec!["add-draft", "--data", &draft, "--reason", "合成確認"],
        vec!["body", "../invalid"],
        vec!["cases", "--today", "2026-02-30"],
        vec![
            "record-reply",
            CONTACT,
            "　 ",
            "--version",
            "1",
            "--reason",
            "合成確認",
        ],
        vec!["search", "　"],
    ] {
        let home = TempHome::new();
        let output = command(&server, &home)
            .args(["--json", "contacts", "--source", SOURCE])
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"], "validation_error");
        assert_private_absent(&error);
    }
    assert!(server.requests().is_empty());
}
#[test]
fn all_six_contact_states_roundtrip_and_body_tokens_never_escape() {
    let schema: Value =
        serde_json::from_str(include_str!("../../../../schema/common.schema.json")).unwrap();
    for state in schema["$defs"]["contact_state"]["enum"].as_array().unwrap() {
        let server = server();
        assert_private_absent(&run(
            &server,
            &[
                "set-state",
                CONTACT,
                state.as_str().unwrap(),
                "--version",
                "1",
                "--reason",
                "合成確認",
                "--apply",
            ],
        ));
        assert_eq!(server.requests().len(), 2);
    }
    for operation in ["list", "body", "export-text"] {
        let server = MockServer::new(move |_| {
            let mut record = record();
            record["contact"]["body"] = json!(TOKEN);
            Response::json(
                200,
                if operation == "list" {
                    json!({"items":[record]})
                } else {
                    json!({"body":TOKEN})
                },
            )
        });
        let home = TempHome::new();
        let mut cmd = command(&server, &home);
        cmd.args(["--json", "contacts", "--source", SOURCE, operation]);
        if operation != "list" {
            cmd.arg(CONTACT);
        }
        let output = cmd.output().unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
        assert!(output.stdout.is_empty());
    }
}
#[test]
fn contact_help_is_available_without_configuration() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_deskly"))
        .env_clear()
        .args(["contacts", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for name in [
        "list",
        "detail",
        "history",
        "body",
        "search",
        "add-draft",
        "set-state",
        "record-reply",
        "export-text",
    ] {
        assert!(text.contains(name));
    }
}

#[test]
fn nested_history_and_waiting_strings_cannot_smuggle_private_content() {
    let server = MockServer::new(|request| {
        let value = if request.path.contains("/waiting?") {
            let mut value = waiting();
            value["items"][0]["ledger_names"] = json!([PRIVATE]);
            value["items"][0]["contact_refs"] = json!([BODY]);
            value
        } else {
            let mut value = history();
            value["events"][0]["changes"][2]["before"] = json!({"body":BODY});
            value
        };
        Response::json(200, value)
    });
    let cases = run(&server, &["cases"]);
    assert_private_absent(&cases);
    assert_eq!(cases["items"][0]["contact_refs"], json!([CONTACT]));
    assert_eq!(cases["items"][0]["ledger_names"], json!([]));
    let home = TempHome::new();
    let output = command(&server, &home)
        .args(["--json", "contacts", "--source", SOURCE, "history", CONTACT])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"], "invalid_response");
    assert_private_absent(&error);
    assert!(output.stdout.is_empty());
}

#[test]
fn unapproved_apply_result_is_not_reported_as_success_or_retried() {
    let mut saved = Value::Null;
    let server = MockServer::new(move |request| {
        if request.path.ends_with("/preview") {
            saved = preview(request.body.as_ref().unwrap());
            Response::json(200, saved.clone())
        } else {
            assert_eq!(request.body.as_ref().unwrap(), &saved);
            let mut after = saved["after"].clone();
            after["contact"]["state"] = json!("完了");
            Response::json(200, after)
        }
    });
    let home = TempHome::new();
    let output = command(&server, &home)
        .args([
            "--json",
            "contacts",
            "--source",
            SOURCE,
            "set-state",
            CONTACT,
            "回答待ち",
            "--version",
            "1",
            "--reason",
            "合成確認",
            "--apply",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"], "invalid_response");
    assert_private_absent(&error);
    assert!(output.stdout.is_empty());
    assert_eq!(server.requests().len(), 2);
}
