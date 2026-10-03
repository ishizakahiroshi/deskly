mod support;

use deskly_cli::client::Client;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
};
use support::*;

const CLIENT_ID: &str = "Opaque:synthetic+read/client=V2.access";
const SECRET: &str = "synthetic-access-secret-for-tests-only";
fn access(server: &MockServer, home: &TempHome) -> Command {
    let mut cmd = command(server, home);
    cmd.env_remove("DESKLY_TOKEN")
        .env("DESKLY_ACCESS_CLIENT_ID", CLIENT_ID)
        .env("DESKLY_ACCESS_CLIENT_SECRET", SECRET);
    cmd
}
fn sanitized(output: &std::process::Output) {
    for value in [CLIENT_ID, SECRET, TOKEN] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(value));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(value));
    }
}
#[test]
fn access_headers_read_projects_and_items_without_bearer_or_proxy() {
    let proxy = MockServer::new(|_| panic!("proxy must not receive authentication"));
    for (args, value) in [
        (
            vec!["projects", "list"],
            json!({"projects":[fixture("project")],"archived_projects":[]}),
        ),
        (vec!["projects", "detail", PROJECT], fixture("project")),
        (
            vec!["items", "--project", PROJECT, "list"],
            json!({"items":[fixture("work_item")]}),
        ),
        (
            vec!["items", "--project", PROJECT, "detail", ITEM],
            fixture("work_item"),
        ),
    ] {
        let expected = value.clone();
        let server = MockServer::new(move |request| {
            assert_eq!(request.headers["cf-access-client-id"], CLIENT_ID);
            assert_eq!(request.headers["cf-access-client-secret"], SECRET);
            assert!(!request.headers.contains_key("authorization"));
            assert!(!request.headers.contains_key("cookie"));
            Response::json(200, value.clone())
        });
        let home = TempHome::new();
        let output = access(&server, &home)
            .env("HTTP_PROXY", proxy.endpoint())
            .env("HTTPS_PROXY", proxy.endpoint())
            .env("ALL_PROXY", proxy.endpoint())
            .env("http_proxy", proxy.endpoint())
            .env("NO_PROXY", "")
            .arg("--json")
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            expected
        );
        sanitized(&output);
        assert_eq!(server.requests().len(), 1);
    }
    assert!(proxy.requests().is_empty());
}
#[test]
fn access_configuration_rejects_missing_partial_empty_invalid_and_competing_sources() {
    let server = MockServer::new(|_| panic!("invalid config must not send"));
    let home = TempHome::new();
    let path = home.path().join("access.json");
    let valid = json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID,"access_client_secret":SECRET});
    for config in [
        json!({"endpoint":server.endpoint()}),
        json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID}),
        json!({"endpoint":server.endpoint(),"access_client_secret":SECRET}),
        json!({"endpoint":server.endpoint(),"access_client_id":"","access_client_secret":SECRET}),
        json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID,"access_client_secret":""}),
        json!({"endpoint":server.endpoint(),"access_client_id":null,"access_client_secret":SECRET}),
        json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID,"access_client_secret":"bad\r\nheader"}),
        json!({"endpoint":server.endpoint(),"access_client_id":" spaced","access_client_secret":SECRET}),
        json!({"endpoint":server.endpoint(),"access_client_id":"x".repeat(257),"access_client_secret":SECRET}),
        json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID,"access_client_secret":SECRET,"token":TOKEN}),
    ] {
        fs::write(&path, config.to_string()).unwrap();
        let output = command(&server, &home)
            .env_remove("DESKLY_TOKEN")
            .env("DESKLY_CONFIG", &path)
            .args(["--json", "projects", "list"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        sanitized(&output);
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"],
            "configuration_error"
        );
    }
    fs::write(&path, valid.to_string()).unwrap();
    for vars in [
        vec![("DESKLY_ACCESS_CLIENT_ID", CLIENT_ID)],
        vec![("DESKLY_ACCESS_CLIENT_SECRET", SECRET)],
        vec![
            ("DESKLY_ACCESS_CLIENT_ID", ""),
            ("DESKLY_ACCESS_CLIENT_SECRET", SECRET),
        ],
        vec![("DESKLY_TOKEN", TOKEN)],
        vec![("DESKLY_TOKEN", "")],
    ] {
        let output = command(&server, &home)
            .env_remove("DESKLY_TOKEN")
            .env("DESKLY_CONFIG", &path)
            .envs(vars)
            .args(["--json", "projects", "list"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        sanitized(&output);
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"],
            "configuration_error"
        );
    }
    fs::write(
        &path,
        json!({"endpoint":server.endpoint(), "token":TOKEN}).to_string(),
    )
    .unwrap();
    let output = access(&server, &home)
        .env("DESKLY_CONFIG", &path)
        .args(["--json", "projects", "list"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    sanitized(&output);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"],
        "configuration_error"
    );
    assert!(server.requests().is_empty());
}
#[test]
fn access_explicit_file_success_and_secrets_never_have_argv_options() {
    let server =
        MockServer::new(|_| Response::json(200, json!({"projects":[],"archived_projects":[]})));
    let home = TempHome::new();
    let path = home.path().join("client.json");
    fs::write(&path, json!({"endpoint":server.endpoint(),"access_client_id":CLIENT_ID,"access_client_secret":SECRET}).to_string()).unwrap();
    let output = command(&server, &home)
        .env_remove("DESKLY_TOKEN")
        .arg("--config")
        .arg(path)
        .args(["--json", "projects", "list"])
        .output()
        .unwrap();
    assert!(output.status.success());
    sanitized(&output);
    for option in ["--access-client-id", "--access-client-secret", "--token"] {
        let output = access(&server, &home)
            .args(["--json", option, SECRET, "projects", "list"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        sanitized(&output);
    }
    assert_eq!(server.requests().len(), 1);
}
#[test]
fn access_response_reflection_and_errors_never_reveal_credentials() {
    for value in [CLIENT_ID, SECRET] {
        for status in [200, 400, 401, 403, 500] {
            let server = MockServer::new(move |_| {
                let mut p = fixture("project");
                p["name"] = json!(value);
                Response::json(
                    status,
                    if status == 200 {
                        p
                    } else {
                        json!({"error":value,"message":value})
                    },
                )
            });
            let output = access(&server, &TempHome::new())
                .args(["--json", "projects", "detail", PROJECT])
                .output()
                .unwrap();
            assert!(!output.status.success());
            sanitized(&output);
            assert!(output.stdout.is_empty());
        }
    }
}
#[test]
fn access_redirect_never_forwards_credentials() {
    let target = MockServer::new(|_| panic!("redirect must never be followed"));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let location = target.endpoint().to_owned();
    let handler = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut head = Vec::new();
        let mut byte = [0];
        while !head.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        let body = json!({"error": SECRET}).to_string();
        write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let client = Client::new_access(&endpoint, CLIENT_ID.into(), SECRET.into(), 2).unwrap();
    let error = client
        .read("projects", WORKSPACE, None, None, None, None)
        .unwrap_err();
    assert!(!error.to_string().contains(SECRET));
    assert!(!error.to_string().contains(CLIENT_ID));
    handler.join().unwrap();
    assert!(target.requests().is_empty());
}
#[test]
fn access_write_preview_and_entry_commands_remain_subject_to_server_denial() {
    let server = MockServer::new(|request| {
        assert_eq!(request.headers["cf-access-client-id"], CLIENT_ID);
        assert_eq!(request.headers["cf-access-client-secret"], SECRET);
        Response::json(403, json!({"error":"forbidden"}))
    });
    let home = TempHome::new();
    for args in [
        vec![
            "projects",
            "archive",
            PROJECT,
            "--version",
            "1",
            "--reason",
            "synthetic",
        ],
        vec![
            "entry",
            "set",
            "--project",
            PROJECT,
            "--path",
            "synthetic.md",
            "--next",
            "synthetic",
        ],
    ] {
        let output = access(&server, &home)
            .arg("--json")
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        sanitized(&output);
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"],
            "forbidden"
        );
    }
    assert_eq!(server.requests().len(), 2);
}
