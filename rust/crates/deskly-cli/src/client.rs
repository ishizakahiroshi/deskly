//! Synchronous HTTP boundary shared by the one-shot CLI and MCP blocking tasks.
use std::{env, fmt, fs, io::Read, path::Path, time::Duration};

use deskly_types::{
    CommandPreview, CommandRequest, CommandResult, EventCollection, Milestone, MilestoneCollection,
    Project, ProjectCollection, StableId, WorkItem, WorkItemCollection,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

/// Deliberately contains only stable, locally selected messages, never server text.
#[derive(Clone, Debug)]
pub struct Error {
    code: &'static str,
    status: Option<u16>,
    message: &'static str,
}
impl Error {
    pub fn validation() -> Self {
        Self::new(
            "validation_error",
            None,
            "入力を確認してください（ID・版・必須の欄）",
        )
    }
    pub fn transport() -> Self {
        Self::new(
            "transport_error",
            None,
            "API に接続できません（接続先・タイムアウトを確認）",
        )
    }
    pub fn config() -> Self {
        Self::new(
            "configuration_error",
            None,
            "設定を確認してください（接続先・トークン・タイムアウト）",
        )
    }
    pub(crate) fn response() -> Self {
        Self::new("invalid_response", None, "API の応答が契約に一致しません")
    }
    fn new(code: &'static str, status: Option<u16>, message: &'static str) -> Self {
        Self {
            code,
            status,
            message,
        }
    }
    /// Local refusal: an identifier is not in the deployment's case settings.
    pub(crate) fn not_in_settings() -> Self {
        Self::new(
            "not_in_settings",
            None,
            "種別・状態・承認状態が受付の設定にありません（cases settings で確認）",
        )
    }
    /// Local refusal: the completion status must be one of the settings' terminal statuses.
    pub(crate) fn not_terminal() -> Self {
        Self::new(
            "not_terminal",
            None,
            "完了にする状態は受付の設定の terminal から選んでください",
        )
    }
    /// Local refusal: a completion needs evidence unless explicitly allowed.
    pub(crate) fn evidence_required() -> Self {
        Self::new(
            "evidence_required",
            None,
            "完了には証拠（--evidence）が要ります。証拠なしで完了にするときだけ --allow-no-evidence を付けてください",
        )
    }
    pub(crate) fn git_unavailable() -> Self {
        Self::new(
            "git_unavailable",
            None,
            "git を実行できません（git のインストールと PATH を確認）",
        )
    }
    pub(crate) fn git_failed() -> Self {
        Self::new(
            "git_failed",
            None,
            "git でコミットを検索できませんでした（リポジトリのパス・版を確認）",
        )
    }
    pub(crate) fn entry_not_found() -> Self {
        Self::new(
            "entry_not_found",
            None,
            "この案件には入口が設定されていません（entry set で作成）",
        )
    }
    pub(crate) fn entry_ambiguous() -> Self {
        Self::new(
            "entry_ambiguous",
            None,
            "この案件に「入口」の作業が複数あります。1つにして（不要な方をアーカイブ）から実行してください",
        )
    }
    pub(crate) fn conflict() -> Self {
        Self::new(
            "version_conflict",
            Some(409),
            "競合しています。最新の値と差分を確認し、再度実行してください",
        )
    }
    pub(crate) fn contact(self) -> Self {
        if self.status == Some(403) {
            Self::new("forbidden", Some(403), "連絡の読み書きには有効な workspace owner の権限が必要です。権限と承認内容を確認してください")
        } else {
            self
        }
    }
    /// Case routes are owner-only; the generic 403 text would hide why.
    pub(crate) fn case(self) -> Self {
        if self.status == Some(403) {
            Self::new("forbidden", Some(403), "受付の読み書きには有効な workspace owner の権限が必要です。権限と承認内容を確認してください")
        } else {
            self
        }
    }
    pub fn json(&self) -> Value {
        json!({"error":self.code, "status":self.status, "message":self.message})
    }
    fn http(status: u16, body: &Value) -> Self {
        match status {
            401 => Self::new(
                "unauthorized",
                Some(status),
                "認証できません。トークンを確認してください",
            ),
            403 => Self::new("forbidden", Some(status), "この操作の権限がありません"),
            404 if body.get("error").and_then(Value::as_str) == Some("cases_not_enabled") => {
                Self::new(
                    "cases_not_enabled",
                    Some(status),
                    "受付は有効になっていません（受付の設定を確認）",
                )
            }
            404 => Self::new(
                "not_found",
                Some(status),
                "対象が見つからないか、閲覧権限がありません",
            ),
            409 => {
                let code = match body.get("error").and_then(Value::as_str) {
                    Some("version_conflict") => "version_conflict",
                    Some("operation_conflict") => "operation_conflict",
                    Some("stale_preview") => "stale_preview",
                    Some("duplicate_id") => "duplicate_id",
                    Some("archived") => "archived",
                    Some("assigned_work_remaining") => "assigned_work_remaining",
                    Some("sharing_not_enabled") => "sharing_not_enabled",
                    Some("invalid_project") => "invalid_project",
                    _ => "conflict",
                };
                Self::new(
                    code,
                    Some(status),
                    "競合しています。最新の値と差分を確認し、再度実行してください",
                )
            }
            400 | 422 => {
                // A fixed allowlist of the API's own identifiers; other server text is never echoed.
                const CODES: [&str; 12] = [
                    "hold_until_requires_hold",
                    "approval_not_required",
                    "invalid_date",
                    "invalid_link",
                    "invalid_link_type",
                    "invalid_status",
                    "invalid_approval_state",
                    "invalid_case_number",
                    "no_changes",
                    "body_too_long",
                    "required_field",
                    "invalid_field",
                ];
                let code = body
                    .get("error")
                    .and_then(Value::as_str)
                    .and_then(|code| CODES.iter().find(|known| **known == code))
                    .copied()
                    .unwrap_or("validation_error");
                Self::new(
                    code,
                    Some(status),
                    "入力が拒否されました。ID・版・必須の欄を確認してください",
                )
            }
            _ => Self::new("http_error", Some(status), "API がエラーを返しました"),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(status) = self.status {
            write!(f, "{status} {}: {}", self.code, self.message)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}
impl std::error::Error for Error {}

// Configuration is not an API contract. Never derive Debug on secrets.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    endpoint: Option<String>,
    token: Option<String>,
    timeout_seconds: Option<u64>,
}

impl FileConfig {
    fn read(path: &Path) -> Result<Self, Error> {
        let mut source = Vec::new();
        fs::File::open(path)
            .map_err(|_| Error::config())?
            .take(65_537)
            .read_to_end(&mut source)
            .map_err(|_| Error::config())?;
        if source.len() > 65_536 {
            return Err(Error::config());
        }
        serde_json::from_slice(&source).map_err(|_| Error::config())
    }
}

/// HTTP methods the API contract uses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verb {
    Get,
    Post,
    Patch,
}

#[derive(Clone)]
pub struct Client {
    agent: ureq::Agent,
    endpoint: String,
    token: String,
}
impl Client {
    /// Only an explicitly selected file is read; this never inspects the real home.
    pub fn load(config: Option<&Path>) -> Result<Self, Error> {
        let env_path = env::var_os("DESKLY_CONFIG");
        let path = config.or_else(|| env_path.as_deref().map(Path::new));
        let file: FileConfig = match path {
            Some(path) => FileConfig::read(path)?,
            None => FileConfig::default(),
        };
        let value = |key: &str, fallback: Option<String>| -> Result<String, Error> {
            match env::var(key) {
                Ok(value) => Ok(value),
                Err(env::VarError::NotPresent) => fallback.ok_or_else(Error::config),
                Err(_) => Err(Error::config()),
            }
        };
        let endpoint = value("DESKLY_ENDPOINT", file.endpoint)?;
        let token = value("DESKLY_TOKEN", file.token)?;
        let timeout = match env::var("DESKLY_TIMEOUT_SECONDS") {
            Ok(value) => value.parse().map_err(|_| Error::config())?,
            Err(env::VarError::NotPresent) => file.timeout_seconds.unwrap_or(10),
            Err(_) => return Err(Error::config()),
        };
        Self::new(&endpoint, token, timeout)
    }
    pub fn new(endpoint: &str, token: String, timeout: u64) -> Result<Self, Error> {
        let url = url::Url::parse(endpoint).map_err(|_| Error::config())?;
        let loopback = match url.host() {
            Some(url::Host::Domain(host)) => host == "localhost",
            Some(url::Host::Ipv4(host)) => host.is_loopback(),
            Some(url::Host::Ipv6(host)) => host.is_loopback(),
            None => false,
        };
        if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || token.is_empty()
            || token.len() > 8192
            || token.bytes().any(|b| !b.is_ascii_graphic())
            || !(1..=300).contains(&timeout)
        {
            return Err(Error::config());
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(timeout)))
            .max_redirects(0)
            .http_status_as_error(false)
            .proxy(None)
            .build()
            .new_agent();
        Ok(Self {
            agent,
            endpoint: url.origin().ascii_serialization(),
            token,
        })
    }
    pub(crate) fn safe(&self, value: &Value) -> Result<(), Error> {
        fn contains(value: &Value, token: &str) -> bool {
            match value {
                Value::String(s) => s.contains(token),
                Value::Array(a) => a.iter().any(|v| contains(v, token)),
                Value::Object(o) => o
                    .iter()
                    .any(|(k, v)| k.contains(token) || contains(v, token)),
                _ => false,
            }
        }
        if contains(value, &self.token) {
            Err(Error::response())
        } else {
            Ok(())
        }
    }
    pub(crate) fn request<T: DeserializeOwned + Serialize>(
        &self,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Error> {
        let verb = if body.is_some() {
            Verb::Post
        } else {
            Verb::Get
        };
        self.request_with::<T>(verb, path, body)
    }
    pub(crate) fn request_with<T: DeserializeOwned + Serialize>(
        &self,
        verb: Verb,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Error> {
        let url = format!("{}{path}", self.endpoint);
        let authorization = format!("Bearer {}", self.token);
        let response = match (verb, body) {
            (Verb::Post, Some(body)) => self
                .agent
                .post(&url)
                .header("Authorization", &authorization)
                .header("Origin", &self.endpoint)
                .send_json(body),
            (Verb::Patch, Some(body)) => self
                .agent
                .patch(&url)
                .header("Authorization", &authorization)
                .header("Origin", &self.endpoint)
                .send_json(body),
            (Verb::Get, None) => self
                .agent
                .get(&url)
                .header("Authorization", &authorization)
                .call(),
            _ => return Err(Error::validation()),
        };
        let mut response = response.map_err(|_| Error::transport())?;
        let status = response.status().as_u16();
        let body: Value = response
            .body_mut()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_json()
            .map_err(|_| {
                if (200..300).contains(&status) {
                    Error::response()
                } else {
                    Error::http(status, &Value::Null)
                }
            })?;
        if !(200..300).contains(&status) {
            return Err(Error::http(status, &body));
        }
        self.safe(&body)?;
        let _: T = serde_json::from_value(body.clone()).map_err(|_| Error::response())?;
        Ok(body)
    }
    pub(crate) fn base(workspace: &str) -> Result<String, Error> {
        valid_id(workspace)?;
        Ok(format!("/api/v1/workspaces/{workspace}"))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn read(
        &self,
        operation: &str,
        workspace: &str,
        project: Option<&str>,
        id: Option<&str>,
        query: Option<&str>,
        member: Option<&str>,
    ) -> Result<Value, Error> {
        let base = Self::base(workspace)?;
        if let Some(project) = project {
            valid_id(project)?;
        }
        if let Some(id) = id {
            valid_id(id)?;
        }
        match operation {
            "projects" => match id {
                Some(id) => self.request::<Project>(&format!("{base}/projects/{id}"), None),
                None => self.request::<ProjectCollection>(&format!("{base}/projects"), None),
            },
            "milestones" | "items" => {
                let project = project.ok_or_else(Error::validation)?;
                let segment = if operation == "items" {
                    "work-items"
                } else {
                    "milestones"
                };
                let path = format!("{base}/projects/{project}/{segment}");
                match (operation, id) {
                    ("items", Some(id)) => self.request::<WorkItem>(&format!("{path}/{id}"), None),
                    ("items", None) => self.request::<WorkItemCollection>(&path, None),
                    (_, Some(id)) => self.request::<Milestone>(&format!("{path}/{id}"), None),
                    (_, None) => self.request::<MilestoneCollection>(&path, None),
                }
            }
            "history" => self.request::<EventCollection>(
                &format!(
                    "{base}/projects/{}/events",
                    project.ok_or_else(Error::validation)?
                ),
                None,
            ),
            "my-work" | "search" | "counts" => self.aggregate(operation, workspace, query, member),
            _ => Err(Error::validation()),
        }
    }
    fn aggregate(
        &self,
        operation: &str,
        workspace: &str,
        query: Option<&str>,
        member: Option<&str>,
    ) -> Result<Value, Error> {
        let member = if operation == "my-work" {
            let m = member.ok_or_else(Error::validation)?;
            valid_id(m)?;
            Some(m)
        } else {
            None
        };
        let needle = if operation == "search" {
            let query = query.ok_or_else(Error::validation)?;
            // This locally supplied value is included in the aggregate output,
            // outside the per-response safety checks below.
            self.safe(&Value::String(query.to_owned()))?;
            let q = query.split_whitespace().collect::<Vec<_>>().join(" ");
            if q.is_empty() || q.chars().count() > 100 {
                return Err(Error::validation());
            }
            Some(q.to_lowercase())
        } else {
            None
        };
        let projects = self.read("projects", workspace, None, None, None, None)?;
        let projects = projects["projects"]
            .as_array()
            .ok_or_else(Error::response)?;
        let mut items = Vec::new();
        let mut milestones = Vec::new();
        let mut found_projects = Vec::new();
        let matches = |row: &Value, fields: &[&str]| {
            needle.as_ref().is_none_or(|needle| {
                fields.iter().any(|key| {
                    row[key]
                        .as_str()
                        .is_some_and(|s| s.to_lowercase().contains(needle))
                })
            })
        };
        for project in projects {
            let id = project["id"].as_str().ok_or_else(Error::response)?;
            if matches(project, &["name", "purpose", "state"]) {
                found_projects.push(project.clone());
            }
            let work = self.read("items", workspace, Some(id), None, None, None)?;
            for row in work["items"].as_array().ok_or_else(Error::response)? {
                if row["archived"] != false {
                    continue;
                }
                if let Some(member) = member {
                    if row["assignee_id"] != member || row["state"] == "完了" {
                        continue;
                    }
                }
                if matches(row, &["title", "next_action", "waiting_reason", "state"]) {
                    let mut row = row.clone();
                    if member.is_some() {
                        row["project_name"] = project["name"].clone();
                    }
                    items.push(row);
                }
            }
            if operation != "my-work" {
                let rows = self.read("milestones", workspace, Some(id), None, None, None)?;
                for row in rows["items"].as_array().ok_or_else(Error::response)? {
                    if row["archived"] == false && matches(row, &["goal", "state"]) {
                        milestones.push(row.clone());
                    }
                }
            }
        }
        if operation == "counts" {
            return Ok(
                json!({"projects": projects.len(), "work_items": items.len(), "milestones": milestones.len(), "unconfirmed_work_items": items.iter().filter(|r| r["state"] == "未確認").count()}),
            );
        }
        if operation == "my-work" {
            items.sort_by_key(|row| {
                (
                    row["check_date"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("9999-12-31")
                        .to_owned(),
                    !row["waiting_reason"].as_str().unwrap_or("").is_empty(),
                    row["id"].to_string(),
                )
            });
            let result: WorkItemCollection =
                serde_json::from_value(json!({"items":items})).map_err(|_| Error::response())?;
            return serde_json::to_value(result).map_err(|_| Error::response());
        }
        let result = json!({"query": query.unwrap_or_default(), "projects":found_projects, "milestones":milestones, "items":items});
        self.safe(&result)?;
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn write(
        &self,
        workspace: &str,
        entity: &str,
        action: &str,
        project: Option<&str>,
        id: Option<&str>,
        version: Option<u64>,
        data: Option<Value>,
        reason: &str,
        apply: bool,
    ) -> Result<Value, Error> {
        let base = Self::base(workspace)?;
        let action = if action == "change" { "update" } else { action };
        let entity = match entity {
            "project" | "projects" => "project",
            "milestone" | "milestones" => "milestone",
            "work_item" | "items" => "work_item",
            _ => return Err(Error::validation()),
        };
        if !matches!(action, "create" | "update" | "archive" | "restore") {
            return Err(Error::validation());
        }
        if entity == "project" && project.is_some()
            || entity != "project" && project.is_none()
            || action == "create" && version.is_some()
            || action != "create" && (id.is_none() || version.is_none())
            || matches!(action, "archive" | "restore") && data.is_some()
        {
            return Err(Error::validation());
        }
        let request = json!({"operation_id":uuid::Uuid::new_v4().to_string(),"action":action,"type":entity,"id":id,"project_id":project,"expected_version":version,"data":data,"reason":reason});
        let typed: CommandRequest =
            serde_json::from_value(request).map_err(|_| Error::validation())?;
        let request = serde_json::to_value(typed).map_err(|_| Error::validation())?;
        self.safe(&request)?;
        let preview =
            self.request::<CommandPreview>(&format!("{base}/commands/preview"), Some(&request))?;
        // A preview may assign an ID, but must not silently change the approved command.
        let mut expected = request.clone();
        if action == "create" && id.is_none() {
            expected["id"] = preview["request"]["id"].clone();
        }
        if preview["request"] != expected {
            return Err(Error::response());
        }
        if apply {
            self.request::<CommandResult>(&format!("{base}/commands/apply"), Some(&preview))
        } else {
            Ok(preview)
        }
    }
}
pub fn valid_id(value: &str) -> Result<(), Error> {
    value
        .parse::<StableId>()
        .map(|_| ())
        .map_err(|_| Error::validation())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_does_not_reflect_configured_token_or_make_a_request() {
        let token = "synthetic-review-token";
        let client = Client::new("http://127.0.0.1:9", token.into(), 1).unwrap();
        for query in [token.to_owned(), format!("合成 {token} 確認")] {
            let error = client
                .read(
                    "search",
                    "00000000-0000-0000-0000-000000000001",
                    None,
                    None,
                    Some(&query),
                    None,
                )
                .unwrap_err();
            // A network attempt would instead return transport_error.
            assert_eq!(error.json()["error"], "invalid_response");
            assert!(!error.json().to_string().contains(token));
        }
    }

    #[test]
    fn explicit_config_read_is_bounded_and_sanitized() {
        let path = env::temp_dir().join(format!(
            "deskly-bounded-config-{}.json",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"{}").unwrap();
        assert!(FileConfig::read(&path).is_ok());
        let mut maximum = b"{}".to_vec();
        maximum.resize(65_536, b' ');
        fs::write(&path, &maximum).unwrap();
        assert!(FileConfig::read(&path).is_ok());
        maximum.push(b' ');
        fs::write(&path, &maximum).unwrap();
        let error = FileConfig::read(&path).err().unwrap();
        assert_eq!(error.json()["error"], "configuration_error");
        assert!(!error.to_string().contains(path.to_str().unwrap()));
        fs::write(&path, b"{synthetic-review-token").unwrap();
        let error = FileConfig::read(&path).err().unwrap();
        assert_eq!(error.json()["error"], "configuration_error");
        assert!(!error.to_string().contains("synthetic-review-token"));
        fs::remove_file(path).unwrap();
    }
}
