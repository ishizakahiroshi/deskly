use deskly_cli::client::Client;
use serde_json::json;
use std::{fs, process::Command};

const TOKEN: &str = "synthetic-bearer-value";

#[test]
fn endpoint_and_secret_validation_is_closed_and_sanitized() {
    for endpoint in [
        "http://deskly.example",
        "https://user:password@example.com",
        "https://deskly.example/?token=secret",
        "https://deskly.example/#secret",
        "https://deskly.example/path",
        "file:///tmp/file",
        "not a url",
    ] {
        let error = Client::new(endpoint, TOKEN.into(), 10).err().unwrap();
        assert!(!error.to_string().contains(endpoint));
        assert!(!error.to_string().contains(TOKEN));
    }
    for token in ["", "bad\ntoken", "bad token", "トークン"] {
        assert!(Client::new("https://deskly.example", token.into(), 10).is_err());
    }
    for timeout in [0, 301] {
        assert!(Client::new("https://deskly.example", TOKEN.into(), timeout).is_err());
    }
    for endpoint in [
        "https://deskly.example",
        "http://127.0.0.1:1",
        "http://[::1]:1",
    ] {
        assert!(Client::new(endpoint, TOKEN.into(), 10).is_ok());
    }
}

#[test]
fn help_needs_no_config_and_never_echoes_bad_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_deskly"))
        .env_clear()
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    for word in [
        "projects",
        "milestones",
        "items",
        "my-work",
        "search",
        "counts",
        "history",
        "mcp",
    ] {
        assert!(String::from_utf8_lossy(&output.stdout).contains(word));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_deskly"))
        .env_clear()
        .arg(TOKEN)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    let output = Command::new(env!("CARGO_BIN_EXE_deskly"))
        .env_clear()
        .args(["--json", TOKEN])
        .output()
        .unwrap();
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"], "validation_error");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
}

#[test]
fn config_is_explicit_and_environment_overrides_file_without_reading_home() {
    let dir = std::env::temp_dir().join(format!("deskly-cli-config-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let config = dir.join("client.json");
    fs::write(
        &config,
        json!({"endpoint":"https://deskly.example", "token":TOKEN, "timeout_seconds":10})
            .to_string(),
    )
    .unwrap();
    let run = |extra: &[(&str, &str)]| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_deskly"));
        cmd.env_clear()
            .env("DESKLY_HOME", &dir)
            .env("HOME", &dir)
            .env("DESKLY_CONFIG", &config)
            .envs(extra.iter().copied())
            .args(["--json", "--workspace", "invalid", "projects", "list"]);
        cmd.output().unwrap()
    };
    // A valid config reaches local ID validation without touching the network.
    let output = run(&[]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("validation_error"));
    let output = run(&[("DESKLY_TIMEOUT_SECONDS", "0")]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("configuration_error"));
    let output = run(&[("DESKLY_ENDPOINT", "https://user:secret@example.com")]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("configuration_error"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("user:secret"));
    fs::write(&config, format!("{{broken {TOKEN}")).unwrap();
    let output = run(&[]);
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    assert!(String::from_utf8_lossy(&output.stderr).contains("configuration_error"));
    fs::remove_dir_all(dir).unwrap();
}
