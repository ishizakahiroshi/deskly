mod support;

use deskly_types::{CommandPreview, CommandRequest, CommandResult};
use serde_json::{json, Map, Value};
use std::{
    process::Output,
    sync::{Arc, Mutex},
};
use support::{
    command, fixture, MockServer, Response, TempHome, ITEM, MEMBER, MILESTONE, PROJECT, TOKEN,
    WORKSPACE,
};

fn output_json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("stdout must contain exactly one JSON value")
}

fn resource_args(resource: &str) -> Vec<String> {
    let mut args = vec!["--json".into(), resource.into()];
    if resource != "projects" {
        args.extend(["--project".into(), PROJECT.into()]);
    }
    args
}

fn mutable_data(kind: &str) -> Value {
    let schema: Value = serde_json::from_str(match kind {
        "project" => include_str!("../../../../schema/project.schema.json"),
        "milestone" => include_str!("../../../../schema/milestone.schema.json"),
        "work_item" => include_str!("../../../../schema/work_item.schema.json"),
        _ => unreachable!(),
    })
    .unwrap();
    let entity = fixture(kind);
    Value::Object(
        schema["$defs"]["data"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(|key| (key.clone(), entity[key].clone()))
            .collect::<Map<_, _>>(),
    )
}

fn make_preview(request: &Value) -> Value {
    let kind = request["type"].as_str().unwrap();
    let action = request["action"].as_str().unwrap();
    let mut entity = fixture(kind);
    let mut normalized = request.clone();
    if normalized["id"].is_null() {
        normalized["id"] = entity["id"].clone();
    }
    let before = if action == "create" {
        Value::Null
    } else {
        entity["archived"] = json!(action == "restore");
        entity.clone()
    };
    if let Some(data) = request["data"].as_object() {
        for (key, value) in data {
            entity[key] = value.clone();
        }
    }
    entity["archived"] = json!(action == "archive");
    entity["version"] = json!(if action == "create" { 1 } else { 2 });
    json!({"request": normalized, "before": before, "after": entity, "preview_token": "a".repeat(64)})
}

#[test]
fn resource_lists_and_details_use_contract_routes_and_bearer_authentication() {
    for (resource, kind, id, segment) in [
        ("projects", "project", PROJECT, "projects"),
        ("milestones", "milestone", MILESTONE, "milestones"),
        ("items", "work_item", ITEM, "work-items"),
    ] {
        for detail in [false, true] {
            let entity = fixture(kind);
            let expected = if detail {
                entity
            } else if resource == "projects" {
                json!({"projects": [entity], "archived_projects": []})
            } else {
                json!({"items": [entity]})
            };
            let response = expected.clone();
            let server = MockServer::new(move |_| Response::json(200, response.clone()));
            let home = TempHome::new();
            let mut args = resource_args(resource);
            args.push(if detail { "detail" } else { "list" }.into());
            if detail {
                args.push(id.into());
            }
            assert_eq!(
                output_json(command(&server, &home).args(&args).output().unwrap()),
                expected
            );
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            let prefix = format!("/api/v1/workspaces/{WORKSPACE}");
            let path = if resource == "projects" {
                format!("{prefix}/{segment}")
            } else {
                format!("{prefix}/projects/{PROJECT}/{segment}")
            };
            assert_eq!(
                requests[0].path,
                if detail { format!("{path}/{id}") } else { path }
            );
            assert_eq!(requests[0].method, "GET");
            assert_eq!(
                requests[0].headers.get("authorization").unwrap(),
                &format!("Bearer {TOKEN}")
            );
            assert!(requests[0].body.is_none());
        }
    }
}

#[test]
fn writes_preview_by_default_and_apply_exactly_the_returned_preview() {
    for (resource, kind, id) in [
        ("projects", "project", PROJECT),
        ("milestones", "milestone", MILESTONE),
        ("items", "work_item", ITEM),
    ] {
        for action in ["create", "change", "archive", "restore"] {
            for apply in [false, true] {
                let saved = Arc::new(Mutex::new(None::<Value>));
                let observed = Arc::clone(&saved);
                let server = MockServer::new(move |request| {
                    assert_eq!(request.method, "POST");
                    assert_eq!(
                        request.headers.get("authorization").unwrap(),
                        &format!("Bearer {TOKEN}")
                    );
                    let body = request.body.as_ref().unwrap();
                    if request.path.ends_with("/commands/preview") {
                        let typed: CommandRequest = serde_json::from_value(body.clone()).unwrap();
                        assert_eq!(serde_json::to_value(typed).unwrap(), *body);
                        let preview = make_preview(body);
                        let typed: CommandPreview =
                            serde_json::from_value(preview.clone()).unwrap();
                        assert_eq!(serde_json::to_value(typed).unwrap(), preview);
                        *observed.lock().unwrap() = Some(preview.clone());
                        Response::json(200, preview)
                    } else {
                        assert!(request.path.ends_with("/commands/apply"));
                        let expected = observed.lock().unwrap().clone().unwrap();
                        assert_eq!(
                            body, &expected,
                            "apply must retain the server-normalized request and opaque token"
                        );
                        Response::json(200, expected["after"].clone())
                    }
                });
                let home = TempHome::new();
                let mut args = resource_args(resource);
                args.push(action.into());
                if action != "create" {
                    args.extend([id.into(), "--version".into(), "1".into()]);
                }
                if matches!(action, "create" | "change") {
                    args.extend(["--data".into(), mutable_data(kind).to_string()]);
                }
                args.extend(["--reason".into(), "合成の確認".into()]);
                if apply {
                    args.push("--apply".into());
                }
                let result = output_json(command(&server, &home).args(&args).output().unwrap());
                let preview = saved.lock().unwrap().clone().unwrap();
                assert_eq!(
                    result,
                    if apply {
                        preview["after"].clone()
                    } else {
                        preview.clone()
                    }
                );
                if apply {
                    serde_json::from_value::<CommandResult>(result).unwrap();
                }
                let requests = server.requests();
                assert_eq!(requests.len(), if apply { 2 } else { 1 });
                assert_eq!(
                    requests[0].path,
                    format!("/api/v1/workspaces/{WORKSPACE}/commands/preview")
                );
                assert_eq!(
                    requests[0].headers.get("origin").unwrap(),
                    server.endpoint()
                );
                let request = requests[0].body.as_ref().unwrap();
                assert_eq!(
                    request["action"],
                    if action == "change" { "update" } else { action }
                );
                assert_eq!(request["type"], kind);
                assert_eq!(
                    request["expected_version"],
                    if action == "create" {
                        Value::Null
                    } else {
                        json!(1)
                    }
                );
                assert!(request["operation_id"]
                    .as_str()
                    .unwrap()
                    .parse::<deskly_types::StableId>()
                    .is_ok());
                if matches!(action, "archive" | "restore") {
                    assert!(request["data"].is_null());
                }
            }
        }
    }
}

#[test]
fn errors_and_malformed_successes_do_not_echo_tokens_or_server_details() {
    for (status, code) in [
        (401, "unauthorized"),
        (403, "forbidden"),
        (404, "not_found"),
        (409, "version_conflict"),
        (422, "validation_error"),
        (500, "http_error"),
    ] {
        let server = MockServer::new(move |_| {
            Response::json(
                status,
                json!({"error": "version_conflict", "detail": TOKEN, "private": "synthetic-hidden-server-detail"}),
            )
        });
        let home = TempHome::new();
        let output = command(&server, &home)
            .args(["--json", "projects", "list"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!stderr.contains(TOKEN));
        assert!(!stderr.contains("synthetic-hidden-server-detail"));
        let error: Value = serde_json::from_str(&stderr).unwrap();
        assert_eq!(error["error"], code);
        assert_eq!(error["status"], status);
        assert_eq!(server.requests().len(), 1);
    }
    for response in [
        json!({"projects": [], "unknown": true}),
        json!({"projects": [{"name": TOKEN}], "archived_projects": []}),
    ] {
        let server = MockServer::new(move |_| Response::json(200, response.clone()));
        let home = TempHome::new();
        let output = command(&server, &home)
            .args(["--json", "projects", "list"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"], "invalid_response");
        assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    }
}

#[test]
fn invalid_input_fails_before_network_and_japanese_output_hides_approval_tokens() {
    let server = MockServer::new(|request| {
        Response::json(200, make_preview(request.body.as_ref().unwrap()))
    });
    let home = TempHome::new();
    for args in [
        vec!["projects", "detail", TOKEN],
        vec!["milestones", "list"],
        vec![
            "projects",
            "create",
            "--data",
            TOKEN,
            "--reason",
            "合成の確認",
        ],
        vec![
            "projects",
            "archive",
            PROJECT,
            "--version",
            "0",
            "--reason",
            "合成の確認",
        ],
    ] {
        let output = command(&server, &home).args(&args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    }
    assert!(server.requests().is_empty());
    let output = command(&server, &home)
        .args([
            "projects",
            "create",
            "--data",
            &mutable_data("project").to_string(),
            "--reason",
            "合成の確認",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("変更の見本"));
    assert!(stdout.contains("変更後"));
    assert!(stdout.contains("合成案件"));
    assert!(!stdout.contains(&"a".repeat(64)));
    assert!(!stdout.contains(TOKEN));
    assert_eq!(server.requests().len(), 1);
}

fn aggregate_server() -> MockServer {
    MockServer::new(|request| {
        if request.path.ends_with("/events") {
            return Response::json(200, json!({"events": [fixture("event")]}));
        }
        if request.path.ends_with("/projects") {
            return Response::json(
                200,
                json!({"projects": [fixture("project")], "archived_projects": []}),
            );
        }
        if request.path.ends_with("/work-items") {
            let active = fixture("work_item");
            let mut done = active.clone();
            done["id"] = "00000000-0000-0000-0000-000000000008".into();
            done["state"] = "完了".into();
            let mut other = active.clone();
            other["id"] = "00000000-0000-0000-0000-000000000009".into();
            other["assignee_id"] = "00000000-0000-0000-0000-000000000010".into();
            let mut archived = active.clone();
            archived["id"] = "00000000-0000-0000-0000-000000000011".into();
            archived["archived"] = true.into();
            let mut earlier = active.clone();
            earlier["id"] = "00000000-0000-0000-0000-000000000012".into();
            earlier["check_date"] = "2026-01-02".into();
            return Response::json(
                200,
                json!({"items": [active, done, other, archived, earlier]}),
            );
        }
        assert!(request.path.ends_with("/milestones"));
        let active = fixture("milestone");
        let mut archived = active.clone();
        archived["id"] = "00000000-0000-0000-0000-000000000013".into();
        archived["archived"] = true.into();
        Response::json(200, json!({"items": [active, archived]}))
    })
}

#[test]
fn aggregate_reads_filter_sort_and_keep_history() {
    let server = aggregate_server();
    let home = TempHome::new();
    let mine = output_json(
        command(&server, &home)
            .args(["--json", "my-work", "--member", MEMBER])
            .output()
            .unwrap(),
    );
    let rows = mine["items"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["check_date"], "2026-01-02");
    assert_eq!(rows[1]["id"], ITEM);
    assert!(rows.iter().all(|row| row["project_name"] == "合成案件"));
    assert_eq!(server.requests().len(), 2);
    let counts = output_json(
        command(&server, &home)
            .args(["--json", "counts"])
            .output()
            .unwrap(),
    );
    assert_eq!(
        counts,
        json!({"projects": 1, "work_items": 4, "milestones": 1, "unconfirmed_work_items": 3})
    );
    let found = output_json(
        command(&server, &home)
            .args(["--json", "search", "合成"])
            .output()
            .unwrap(),
    );
    assert_eq!(found["projects"].as_array().unwrap().len(), 1);
    assert_eq!(found["items"].as_array().unwrap().len(), 4);
    assert_eq!(found["milestones"].as_array().unwrap().len(), 1);
    let missing = output_json(
        command(&server, &home)
            .args(["--json", "search", "no-synthetic-match"])
            .output()
            .unwrap(),
    );
    assert!(missing["projects"].as_array().unwrap().is_empty());
    assert!(missing["items"].as_array().unwrap().is_empty());
    assert!(missing["milestones"].as_array().unwrap().is_empty());
    let history = output_json(
        command(&server, &home)
            .args(["--json", "history", PROJECT])
            .output()
            .unwrap(),
    );
    assert_eq!(history, json!({"events": [fixture("event")]}));
}

#[test]
fn failed_apply_is_not_retried_and_never_exposes_approval_or_auth_tokens() {
    for (status, expected_code) in [
        (401, "unauthorized"),
        (403, "forbidden"),
        (409, "version_conflict"),
    ] {
        let preview = Arc::new(Mutex::new(None::<Value>));
        let observed = Arc::clone(&preview);
        let server = MockServer::new(move |request| {
            if request.path.ends_with("/preview") {
                let value = make_preview(request.body.as_ref().unwrap());
                *observed.lock().unwrap() = Some(value.clone());
                Response::json(200, value)
            } else {
                assert!(request.path.ends_with("/apply"));
                assert_eq!(request.body, *observed.lock().unwrap());
                Response::json(
                    status,
                    json!({"error": "version_conflict", "details": TOKEN, "preview_token": "a".repeat(64)}),
                )
            }
        });
        let home = TempHome::new();
        let output = command(&server, &home)
            .args([
                "--json",
                "projects",
                "create",
                "--data",
                &mutable_data("project").to_string(),
                "--reason",
                "合成の確認",
                "--apply",
            ])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(!stderr.contains(TOKEN));
        assert!(!stderr.contains(&"a".repeat(64)));
        let error: Value = serde_json::from_str(&stderr).unwrap();
        assert_eq!(error["error"], expected_code);
        assert_eq!(
            server.requests().len(),
            2,
            "a rejected apply must not be replayed automatically"
        );
    }
}

#[test]
fn explicit_data_files_and_stdin_are_supported_without_real_home_access() {
    use std::{io::Write, process::Stdio};
    let server = MockServer::new(|request| {
        Response::json(200, make_preview(request.body.as_ref().unwrap()))
    });
    let home = TempHome::new();
    let data = mutable_data("project");
    let path = home.path().join("synthetic-data.json");
    std::fs::write(&path, data.to_string()).unwrap();
    let file_arg = format!("@{}", path.display());
    let file = output_json(
        command(&server, &home)
            .args([
                "--json",
                "projects",
                "create",
                "--data",
                &file_arg,
                "--reason",
                "合成の確認",
            ])
            .output()
            .unwrap(),
    );
    assert_eq!(file["request"]["data"], data);
    let mut child = command(&server, &home)
        .args([
            "--json",
            "projects",
            "create",
            "--data",
            "-",
            "--reason",
            "合成の確認",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(data.to_string().as_bytes())
        .unwrap();
    let stdin = output_json(child.wait_with_output().unwrap());
    assert_eq!(stdin["request"]["data"], data);
    assert_eq!(server.requests().len(), 2);
}

#[test]
fn changed_server_preview_is_rejected_without_applying() {
    for changed in ["reason", "data", "explicit_id"] {
        let server = MockServer::new(move |request| {
            assert!(
                request.path.ends_with("/commands/preview"),
                "a changed preview must never be applied"
            );
            let mut preview = make_preview(request.body.as_ref().unwrap());
            match changed {
                "reason" => preview["request"]["reason"] = "別の合成理由".into(),
                "data" => {
                    preview["request"]["data"]["name"] = "別の合成案件".into();
                    preview["after"]["name"] = "別の合成案件".into();
                }
                "explicit_id" => {
                    preview["request"]["id"] = "00000000-0000-0000-0000-000000000042".into();
                    preview["after"]["id"] = preview["request"]["id"].clone();
                }
                _ => unreachable!(),
            }
            serde_json::from_value::<CommandPreview>(preview.clone()).unwrap();
            Response::json(200, preview)
        });
        let home = TempHome::new();
        let data = mutable_data("project").to_string();
        let mut process = command(&server, &home);
        process.args([
            "--json",
            "projects",
            "create",
            "--data",
            &data,
            "--reason",
            "合成の確認",
            "--apply",
        ]);
        if changed == "explicit_id" {
            process.args(["--id", PROJECT]);
        }
        let output = process.output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"], "invalid_response");
        assert_eq!(server.requests().len(), 1);
    }
}
