use clap::{Args, Parser, Subcommand};
use deskly_cli::{
    cases::{CaseChange, CaseFilter, CompleteOptions, PatchOptions},
    client::{Client, Error},
};
use serde_json::Value;
use std::{
    env, fs,
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "deskly",
    version,
    about = "案件・作業・連絡の CLI と承認付き MCP",
    disable_help_subcommand = true
)]
struct Cli {
    /// workspace の UUID（DESKLY_WORKSPACE でも指定可）
    #[arg(long, global = true)]
    workspace: Option<String>,
    /// 機械向け JSON を出力
    #[arg(long, global = true)]
    json: bool,
    /// 明示的に読む JSON 設定ファイル（DESKLY_CONFIG でも指定可）
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// 案件を一覧・詳細・作成・変更・アーカイブ・復元
    Projects(Resource),
    /// マイルストーンを操作（--project が必要）
    Milestones(Resource),
    /// 作業を操作（--project が必要）
    Items(Resource),
    /// 指定した自分の member ID の未完了作業（本人確認は API が担当）
    MyWork {
        #[arg(long)]
        member: String,
    },
    /// 閲覧できる案件・マイルストーン・作業を検索
    Search { query: String },
    /// 閲覧できるアクティブな案件・作業を集計
    Counts,
    /// 案件の変更履歴
    History { project: String },
    /// 連絡の一覧・詳細・履歴・本文・承認付き変更（owner 専用）
    Contacts(Contacts),
    /// 案件ごとの連絡の「誰の番か」（本文の要約なし、owner 専用）
    Waiting {
        #[arg(long)]
        source: String,
        #[arg(long)]
        include_all: bool,
        #[arg(long)]
        today: Option<String>,
    },
    /// 受付（case）の一覧・詳細・パネル・設定・承認付き変更・完了（owner 専用）
    Cases(Cases),
    /// 案件の入口（作業「入口」に md のパスと次の C を書く・読む）
    Entry(Entry),
    /// stdio MCP サーバー（標準出力は MCP 通信専用）
    Mcp {
        /// 案件・作業の読み取りだけを公開（Access認証では常に有効）
        #[arg(long)]
        read_only: bool,
    },
}
#[derive(Args)]
struct Cases {
    #[command(subcommand)]
    action: CaseAction,
}
#[derive(Args)]
struct CaseWrite {
    /// 受付の履歴に残す理由
    #[arg(long)]
    reason: Option<String>,
    /// アプリ側で操作した人の識別子（履歴にだけ残る）
    #[arg(long)]
    actor_ref: Option<String>,
    /// 見本で確認した版。省略すると現在の版を読んで使う（違えば競合で止まる）
    #[arg(long)]
    revision: Option<u64>,
    /// 見本ではなく実際に送る
    #[arg(long, default_value_t = false)]
    apply: bool,
}
#[derive(Args)]
struct Apply {
    /// 見本ではなく実際に送る
    #[arg(long, default_value_t = false)]
    apply: bool,
}
#[derive(Subcommand)]
enum CaseAction {
    /// 一覧（本文なし）。絞り込みは設定の値で検査する
    List {
        /// 状態の識別子。複数指定は OR
        #[arg(long)]
        status: Vec<String>,
        /// 種別の識別子。複数指定は OR
        #[arg(long)]
        kind: Vec<String>,
        /// 送り手アプリの接頭辞。複数指定は OR
        #[arg(long)]
        source: Vec<String>,
        /// 誰待ちか（us / them / none）
        #[arg(long)]
        waiting: Option<String>,
        /// 期限（約束した期日）を過ぎた未完了だけ
        #[arg(long)]
        overdue: bool,
        /// --overdue の基準日（UTC の YYYY-MM-DD。省略時は API の today）
        #[arg(long)]
        today: Option<String>,
    },
    /// 1 件の詳細（本文は --body を付けたときだけ）
    Show {
        number: String,
        /// 受付と返事の本文も表示
        #[arg(long)]
        body: bool,
    },
    /// 4 枚のパネルの数字
    Panels,
    /// 受付の設定（種別・状態・承認状態・誰待ち・表示名）
    Settings,
    /// 状態を変える見本（--apply で確定）
    SetStatus {
        number: String,
        status: String,
        #[command(flatten)]
        write: CaseWrite,
    },
    /// 承認状態を変える見本（--apply で確定）
    SetApproval {
        number: String,
        approval_state: String,
        /// 保留の解除期限（保留のときだけ）
        #[arg(long)]
        hold_until: Option<String>,
        #[command(flatten)]
        write: CaseWrite,
    },
    /// 約束した期日・保留の解除期限を変える見本。none で空にする（--apply で確定）
    SetDue {
        number: String,
        #[arg(long)]
        promised_due: Option<String>,
        #[arg(long)]
        hold_until: Option<String>,
        #[command(flatten)]
        write: CaseWrite,
    },
    /// 返事を足す見本（--apply で確定。本文は表示しない。相手へは送信しない）
    Reply {
        number: String,
        /// 返事の本文。@file でファイル、- で標準入力
        #[arg(long)]
        body: String,
        #[arg(long)]
        author_ref: Option<String>,
        /// 相手に届いた日時（UTC・Z 付き）
        #[arg(long)]
        delivered_at: Option<String>,
        #[command(flatten)]
        confirm: Apply,
    },
    /// 関連（commit・doc・url）を足す見本（--apply で確定）
    Link {
        number: String,
        #[arg(long = "type")]
        link_type: String,
        #[arg(long = "ref")]
        reference: String,
        #[command(flatten)]
        confirm: Apply,
    },
    /// 同じことに当たった人を足す見本（--apply で確定）
    PeopleAdd {
        number: String,
        #[arg(long)]
        reporter_ref: String,
        #[command(flatten)]
        confirm: Apply,
    },
    /// 完了にする（⑥）。証拠を足してから終端の状態へ。見本 → --apply
    Complete {
        number: String,
        /// 完了にする状態（設定の terminal から。省略時は現在が終端ならそのまま、違えば terminal の先頭）
        #[arg(long)]
        status: Option<String>,
        /// 証拠。commit:ID / doc:パス / url:URL（接頭辞なしは推定）。繰り返し可
        #[arg(long)]
        evidence: Vec<String>,
        /// 証拠なしで完了にする（一覧に「証拠なし」の印が付く）
        #[arg(long)]
        allow_no_evidence: bool,
        #[command(flatten)]
        write: CaseWrite,
    },
    /// リポジトリの git log から「Ref: 番号」のコミットを関連に足す見本（--apply で確定）
    LinkCommits {
        number: String,
        /// git リポジトリのパス（読み取りだけ）
        #[arg(long)]
        repo: PathBuf,
        /// 検索する範囲（既定は HEAD）
        #[arg(long)]
        rev: Option<String>,
        #[command(flatten)]
        confirm: Apply,
    },
}
#[derive(Args)]
struct Entry {
    #[command(subcommand)]
    action: EntryAction,
}
#[derive(Subcommand)]
enum EntryAction {
    /// 入口の md のパスと次の C を返す
    Show {
        #[arg(long)]
        project: String,
    },
    /// 入口を作る・更新する見本（--apply で確定）
    Set {
        #[arg(long)]
        project: String,
        /// 入口の md のパス
        #[arg(long)]
        path: String,
        /// 次にやる C
        #[arg(long)]
        next: String,
        /// 履歴に残す理由
        #[arg(long)]
        reason: Option<String>,
        #[command(flatten)]
        confirm: Apply,
    },
}
fn patch_options(write: &CaseWrite) -> PatchOptions<'_> {
    PatchOptions {
        reason: write.reason.as_deref(),
        actor_ref: write.actor_ref.as_deref(),
        revision: write.revision,
        apply: write.apply,
    }
}
/// `none` clears a date; any other value is the new date.
fn nullable(value: &Option<String>) -> Option<Option<&str>> {
    value
        .as_deref()
        .map(|value| if value == "none" { None } else { Some(value) })
}
fn cases(client: &Client, workspace: &str, command: Cases) -> Result<Value, Error> {
    let none = CaseFilter::default();
    match command.action {
        CaseAction::List {
            status,
            kind,
            source,
            waiting,
            overdue,
            today,
        } => client.case_read(
            "list",
            workspace,
            None,
            &CaseFilter {
                status,
                kind,
                source,
                waiting,
                overdue,
                today,
            },
            false,
        ),
        CaseAction::Show { number, body } => {
            client.case_read("show", workspace, Some(&number), &none, body)
        }
        CaseAction::Panels => client.case_read("panels", workspace, None, &none, false),
        CaseAction::Settings => client.case_read("settings", workspace, None, &none, false),
        CaseAction::SetStatus {
            number,
            status,
            write,
        } => client.case_patch(
            workspace,
            &number,
            &CaseChange::Status(&status),
            &patch_options(&write),
        ),
        CaseAction::SetApproval {
            number,
            approval_state,
            hold_until,
            write,
        } => client.case_patch(
            workspace,
            &number,
            &CaseChange::Approval {
                state: &approval_state,
                hold_until: hold_until.as_deref(),
            },
            &patch_options(&write),
        ),
        CaseAction::SetDue {
            number,
            promised_due,
            hold_until,
            write,
        } => client.case_patch(
            workspace,
            &number,
            &CaseChange::Due {
                promised_due: nullable(&promised_due),
                hold_until: nullable(&hold_until),
            },
            &patch_options(&write),
        ),
        CaseAction::Reply {
            number,
            body,
            author_ref,
            delivered_at,
            confirm,
        } => client.case_reply(
            workspace,
            &number,
            &text(&body)?,
            author_ref.as_deref(),
            delivered_at.as_deref(),
            confirm.apply,
        ),
        CaseAction::Link {
            number,
            link_type,
            reference,
            confirm,
        } => client.case_link(workspace, &number, &link_type, &reference, confirm.apply),
        CaseAction::PeopleAdd {
            number,
            reporter_ref,
            confirm,
        } => client.case_person(workspace, &number, &reporter_ref, confirm.apply),
        CaseAction::Complete {
            number,
            status,
            evidence,
            allow_no_evidence,
            write,
        } => client.case_complete(
            workspace,
            &number,
            &CompleteOptions {
                status: status.as_deref(),
                evidence: &evidence,
                allow_no_evidence,
                patch: patch_options(&write),
            },
        ),
        CaseAction::LinkCommits {
            number,
            repo,
            rev,
            confirm,
        } => client.case_link_commits(workspace, &number, &repo, rev.as_deref(), confirm.apply),
    }
}
fn entry(client: &Client, workspace: &str, command: Entry) -> Result<Value, Error> {
    match command.action {
        EntryAction::Show { project } => client.entry_show(workspace, &project),
        EntryAction::Set {
            project,
            path,
            next,
            reason,
            confirm,
        } => client.entry_set(
            workspace,
            &project,
            &path,
            &next,
            reason.as_deref(),
            confirm.apply,
        ),
    }
}
#[derive(Args)]
struct Contacts {
    /// 連絡台帳の接続元 UUID（表示名ではない）
    #[arg(long, global = true)]
    source: Option<String>,
    #[command(subcommand)]
    action: ContactAction,
}
#[derive(Args)]
struct ContactFilter {
    /// 6 語の状態。複数指定は OR
    #[arg(long)]
    state: Vec<String>,
    /// 旧連絡の案件文字列で完全一致（権限の ID ではない）
    #[arg(long)]
    project: Option<String>,
}
#[derive(Subcommand)]
enum ContactAction {
    /// 本文・機微欄を除く一覧
    List(ContactFilter),
    /// 本文・機微欄を除く詳細
    Detail { id: String },
    /// 本文・機微欄を除く変更履歴
    History { id: String },
    /// 明示した連絡の本文を取得
    Body { id: String },
    /// API で部分一致検索（結果は本文・機微欄を除く）
    Search {
        query: String,
        #[command(flatten)]
        filter: ContactFilter,
    },
    /// 連絡を案件文字列でまとめる（外部案件は取得しない）
    Cases {
        #[arg(long)]
        today: Option<String>,
    },
    /// 下書きの見本（--apply で確定。本文は表示しない）
    AddDraft {
        #[arg(long)]
        id: Option<String>,
        /// 入力欄の JSON。@file または -（標準入力）も利用可
        #[arg(long)]
        data: String,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// 6 語の状態を変更する見本（--apply で確定）
    SetState {
        id: String,
        state: String,
        #[arg(long)]
        version: u64,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// 返信要約を記録する見本（--apply で確定、対応中へ）
    RecordReply {
        id: String,
        summary: String,
        #[arg(long)]
        version: u64,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// body 経路で本文を書き出す（ファイル保存や送信はしない）
    ExportText { id: String },
}
fn contacts(client: &Client, workspace: &str, command: Contacts) -> Result<Value, Error> {
    let source = command.source.as_deref().ok_or_else(Error::validation)?;
    let read = |op, id: Option<&str>, filter: Option<&ContactFilter>, query, today| {
        client.contact_read(
            op,
            workspace,
            source,
            id,
            filter.map_or(&[][..], |f| f.state.as_slice()),
            filter.and_then(|f| f.project.as_deref()),
            query,
            false,
            today,
        )
    };
    match command.action {
        ContactAction::List(filter) => read("list", None, Some(&filter), None, None),
        ContactAction::Detail { id } => read("detail", Some(&id), None, None, None),
        ContactAction::History { id } => read("history", Some(&id), None, None, None),
        ContactAction::Body { id } => read("body", Some(&id), None, None, None),
        ContactAction::ExportText { id } => read("export-text", Some(&id), None, None, None),
        ContactAction::Search { query, filter } => {
            read("search", None, Some(&filter), Some(&query), None)
        }
        ContactAction::Cases { today } => read("cases", None, None, None, today.as_deref()),
        ContactAction::AddDraft {
            id,
            data: input,
            confirmation: c,
        } => client.contact_write(
            workspace,
            source,
            "add_draft",
            id.as_deref(),
            None,
            data(&input)?,
            &c.reason,
            c.apply,
        ),
        ContactAction::SetState {
            id,
            state,
            version,
            confirmation: c,
        } => client.contact_write(
            workspace,
            source,
            "set_state",
            Some(&id),
            Some(version),
            serde_json::json!({"state":state}),
            &c.reason,
            c.apply,
        ),
        ContactAction::RecordReply {
            id,
            summary,
            version,
            confirmation: c,
        } => client.contact_write(
            workspace,
            source,
            "record_reply",
            Some(&id),
            Some(version),
            serde_json::json!({"summary":summary}),
            &c.reason,
            c.apply,
        ),
    }
}
#[derive(Args)]
struct Resource {
    /// 子の所属する案件の UUID
    #[arg(long, global = true)]
    project: Option<String>,
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// 一覧（アーカイブ済みも返す）
    List,
    /// 指定 ID の詳細
    Detail { id: String },
    /// 新規作成の見本（--apply で確定）
    Create {
        #[arg(long)]
        id: Option<String>,
        /// 全入力欄の JSON。@file でファイル、- で標準入力
        #[arg(long)]
        data: String,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// 既存レコードの全入力欄を変更する見本（--apply で確定）
    Change {
        id: String,
        #[arg(long)]
        version: u64,
        #[arg(long)]
        data: String,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// アーカイブの見本（--apply で確定）
    Archive {
        id: String,
        #[arg(long)]
        version: u64,
        #[command(flatten)]
        confirmation: Confirmation,
    },
    /// 復元の見本（--apply で確定）
    Restore {
        id: String,
        #[arg(long)]
        version: u64,
        #[command(flatten)]
        confirmation: Confirmation,
    },
}
#[derive(Args)]
struct Confirmation {
    /// 履歴に残す変更理由
    #[arg(long)]
    reason: String,
    /// 同じ呼出しで取得した見本を確認用の印とともに確定
    #[arg(long, default_value_t = false)]
    apply: bool,
}
/// Free text from the argument, `@file` or `-` (standard input), at most 1 MiB of UTF-8.
fn text(source: &str) -> Result<String, Error> {
    String::from_utf8(raw(source)?).map_err(|_| Error::validation())
}
fn data(source: &str) -> Result<Value, Error> {
    serde_json::from_slice(&raw(source)?).map_err(|_| Error::validation())
}
fn raw(source: &str) -> Result<Vec<u8>, Error> {
    let bytes = if source == "-" {
        let mut bytes = Vec::new();
        io::stdin()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::validation())?;
        bytes
    } else if let Some(path) = source.strip_prefix('@') {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| Error::validation())?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::validation())?;
        bytes
    } else {
        source.as_bytes().to_vec()
    };
    if bytes.len() > 1_048_576 {
        return Err(Error::validation());
    }
    Ok(bytes)
}
fn resource(
    client: &Client,
    workspace: &str,
    kind: &str,
    resource: Resource,
) -> Result<Value, Error> {
    let p = resource.project.as_deref();
    match resource.action {
        Action::List => client.read(kind, workspace, p, None, None, None),
        Action::Detail { id } => client.read(kind, workspace, p, Some(&id), None, None),
        Action::Create {
            id,
            data: source,
            confirmation: c,
        } => client.write(
            workspace,
            kind,
            "create",
            p,
            id.as_deref(),
            None,
            Some(data(&source)?),
            &c.reason,
            c.apply,
        ),
        Action::Change {
            id,
            version,
            data: source,
            confirmation: c,
        } => client.write(
            workspace,
            kind,
            "change",
            p,
            Some(&id),
            Some(version),
            Some(data(&source)?),
            &c.reason,
            c.apply,
        ),
        Action::Archive {
            id,
            version,
            confirmation: c,
        } => client.write(
            workspace,
            kind,
            "archive",
            p,
            Some(&id),
            Some(version),
            None,
            &c.reason,
            c.apply,
        ),
        Action::Restore {
            id,
            version,
            confirmation: c,
        } => client.write(
            workspace,
            kind,
            "restore",
            p,
            Some(&id),
            Some(version),
            None,
            &c.reason,
            c.apply,
        ),
    }
}
fn run(cli: Cli) -> Result<Option<Value>, Error> {
    let client = Client::load(cli.config.as_deref())?;
    if let Command::Mcp { read_only } = cli.command {
        // One-shot CLI never constructs or enters a Tokio runtime.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Error::transport())?
            .block_on(deskly_cli::mcp::serve_with_mode(client, read_only))?;
        return Ok(None);
    }
    let workspace = cli
        .workspace
        .or_else(|| env::var("DESKLY_WORKSPACE").ok())
        .ok_or_else(Error::validation)?;
    let result = match cli.command {
        Command::Projects(r) => resource(&client, &workspace, "projects", r),
        Command::Milestones(r) => resource(&client, &workspace, "milestones", r),
        Command::Items(r) => resource(&client, &workspace, "items", r),
        Command::MyWork { member } => {
            client.read("my-work", &workspace, None, None, None, Some(&member))
        }
        Command::Search { query } => {
            client.read("search", &workspace, None, None, Some(&query), None)
        }
        Command::Counts => client.read("counts", &workspace, None, None, None, None),
        Command::History { project } => {
            client.read("history", &workspace, Some(&project), None, None, None)
        }
        Command::Contacts(command) => contacts(&client, &workspace, command),
        Command::Cases(command) => cases(&client, &workspace, command),
        Command::Entry(command) => entry(&client, &workspace, command),
        Command::Waiting {
            source,
            include_all,
            today,
        } => client.contact_read(
            "waiting",
            &workspace,
            &source,
            None,
            &[],
            None,
            None,
            include_all,
            today.as_deref(),
        ),
        Command::Mcp { .. } => unreachable!(),
    }?;
    Ok(Some(result))
}
fn label(key: &str) -> &str {
    match key {
        "contact" => "連絡",
        "body" => "本文",
        "source_id" => "接続元 ID",
        "recipient" => "宛先",
        "channel" => "経路",
        "due" => "期限",
        "turn" => "誰の番か",
        "overdue" => "期限切れ",
        "projects" => "案件",
        "archived_projects" => "アーカイブ済み案件",
        "milestones" => "マイルストーン",
        "items" | "work_items" => "作業",
        "events" => "履歴",
        "name" => "名前",
        "title" => "作業名",
        "goal" => "目標",
        "purpose" => "目的",
        "state" => "状態",
        "version" => "版",
        "archived" => "アーカイブ済み",
        "before" => "変更前",
        "after" => "変更後",
        "reason" => "理由",
        "next_action" => "次の行動",
        "check_date" => "確認日",
        "waiting_reason" => "待ち理由",
        "acceptance" => "受入条件",
        "assignee_id" => "担当 ID",
        "owner_id" => "主担当 ID",
        "query" => "検索語",
        "unconfirmed_work_items" => "未確認の作業",
        "preview" => "見本（未確定）",
        "applied" => "確定済み",
        "send" => "送信内容",
        "current" => "現在の値",
        "no_change" => "変更なし",
        "case" => "受付",
        "number" => "番号",
        "approval_state" => "承認状態",
        "promised_due" => "約束した期日",
        "hold_until" => "保留の解除期限",
        "revision" => "版",
        "people" => "同じことに当たった人",
        "replies" => "返事",
        "links" => "関連",
        "commits" => "コミット",
        "links_added" => "足した証拠の件数",
        "links_present" => "既にあった証拠の件数",
        "status_changed" => "状態を変えたか",
        "evidence_missing" => "証拠なし",
        "already_present" => "既にある",
        "path" => "入口の md",
        "next" => "次の C",
        "method" => "方法",
        "complete" => "完了の内容",
        _ => key,
    }
}
fn human(value: &Value, depth: usize) {
    let prefix = "  ".repeat(depth);
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key == "preview_token" || key == "request" {
                    continue;
                }
                match value {
                    Value::Object(_) | Value::Array(_) => {
                        println!("{prefix}{}:", label(key));
                        human(value, depth + 1);
                    }
                    _ => println!("{prefix}{}: {}", label(key), value),
                }
            }
        }
        Value::Array(values) => {
            if values.is_empty() {
                println!("{prefix}該当なし");
            }
            for value in values {
                println!("{prefix}-");
                human(value, depth + 1);
            }
        }
        _ => println!("{prefix}{value}"),
    }
}
fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                let _ = error.print();
                return ExitCode::SUCCESS;
            }
            // Clap may quote arbitrary arguments. Do not echo them to diagnostics.
            if env::args_os().any(|argument| argument == "--json") {
                eprintln!("{}", Error::validation().json());
            } else {
                eprintln!(
                    "validation_error: コマンドの指定を確認してください（--help で使い方を表示）"
                );
            }
            return ExitCode::from(2);
        }
    };
    let json = cli.json;
    match run(cli) {
        Ok(Some(value)) => {
            if json {
                println!("{value}");
            } else {
                if value.get("preview_token").is_some() || value["preview"] == true {
                    println!("変更の見本（未確定。確定には --apply が必要）");
                }
                human(&value, 0);
            }
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::SUCCESS,
        Err(error) => {
            if json {
                eprintln!("{}", error.json());
            } else {
                eprintln!("{error}");
            }
            ExitCode::from(1)
        }
    }
}
