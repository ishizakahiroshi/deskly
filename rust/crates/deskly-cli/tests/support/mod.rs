#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde_json::Value;

pub const WORKSPACE: &str = "00000000-0000-0000-0000-000000000001";
pub const MEMBER: &str = "00000000-0000-0000-0000-000000000002";
pub const PROJECT: &str = "00000000-0000-0000-0000-000000000003";
pub const MILESTONE: &str = "00000000-0000-0000-0000-000000000004";
pub const ITEM: &str = "00000000-0000-0000-0000-000000000005";
pub const TOKEN: &str = "synthetic-test-token";

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Value>,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }
}

pub struct MockServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MockServer {
    pub fn new(mut handler: impl FnMut(&Request) -> Response + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows は listener の non-blocking が accept した socket に引き継がれる
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let request = read_request(&mut stream);
                        observed.lock().unwrap().push(request.clone());
                        let response = handler(&request);
                        let bytes = response.body.as_bytes();
                        let header = format!("HTTP/1.1 {} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, bytes.len());
                        stream.write_all(header.as_bytes()).unwrap();
                        stream.write_all(bytes).unwrap();
                        stream.flush().unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("mock server accept failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.expect("mock server thread failed");
            }
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Request {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        assert!(header.len() < 16_384, "oversized mock request headers");
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
    }
    let header = String::from_utf8(header).unwrap();
    let mut lines = header.split("\r\n");
    let mut first = lines.next().unwrap().split_whitespace();
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let headers: BTreeMap<_, _> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .map(|value| value.parse().unwrap())
        .unwrap_or(0);
    assert!(length <= 1_048_576);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    Request {
        method,
        path,
        headers,
        body: if body.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&body).unwrap())
        },
    }
}

pub struct TempHome(PathBuf);

impl TempHome {
    pub fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let number = SEQUENCE.fetch_add(1, Ordering::SeqCst);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deskly-cli-test-{}-{number}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn command(server: &MockServer, home: &TempHome) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_deskly"));
    command
        .env_clear()
        .env("DESKLY_HOME", home.path())
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("DESKLY_ENDPOINT", server.endpoint())
        .env("DESKLY_TOKEN", TOKEN)
        .env("DESKLY_WORKSPACE", WORKSPACE)
        .env("DESKLY_TIMEOUT_SECONDS", "2");
    // git を呼ぶ cases link-commits のために PATH だけを渡す（他の環境変数は空のまま）。
    if let Some(value) = std::env::var_os("PATH") {
        command.env("PATH", value);
    }
    // Windows は SystemRoot が無いと Winsock を初期化できず、接続できない。
    for key in ["SystemRoot", "SYSTEMROOT", "windir"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

pub fn fixture(name: &str) -> Value {
    let source = match name {
        "project" => include_str!("../../../deskly-types/tests/fixtures/project.json"),
        "milestone" => include_str!("../../../deskly-types/tests/fixtures/milestone.json"),
        "work_item" => include_str!("../../../deskly-types/tests/fixtures/work_item.json"),
        "event" => include_str!("../../../deskly-types/tests/fixtures/event.json"),
        _ => panic!("unknown synthetic fixture"),
    };
    serde_json::from_str(source).unwrap()
}

pub mod cases;
pub mod contacts;
