---
type: reference
status: draft
tags: [deskly, delegation, read-access]
owner: ishizakahiroshi
review_status: draft
related: [REVIEW.md, PROGRESS.md]
last_reviewed: 2026-10-03
---

# dots #7: develop の新版基盤とローカル AI の読み取り連携

この指示書は外部の実装担当が単体で読める依頼として2026-10-03に用意した。私用の計画・端末・認証情報を参照する必要はない。

## 目的と依頼範囲

人がDeskly画面で登録した案件・作業を、ローカルAIが安定IDで指定して読み取れるようにする。初回は読み取り専用。取得だけで作業を実行しない。例は合成案件「表示速度の調査」、作業「遅延原因を分析する」。題名・目的・次の行動・状態をAIが確認できればよい。

対象: `ishizakahiroshi/deskly`。開発基準・PR base は `develop`。別の開発本線を作らない。作業branchは `dots/deskly-local-agent-read-access-7` を推奨する。直接developへpushせず、develop向けDraft PRとして提出する。

公開基盤の整備も今回の依頼に含む。新版ソースを公開developへ統合できる形に整え、その基盤で読取連携を実装する。公開基盤が未整備だから依頼を停止する必要はない。

## 固定した入力と差分の基準

- 開発基準SHA: `b0c3202b7a691471afdb4eebaef06fb8e7f7929d`（依頼作成時のdevelop）。
- 新版ソース候補／挙動oracle SHA: `d498e98c55274d1f9dfc622b95ab46f0e0746384`。この公開リポ内のcore/rust/schema/deploy-nextは、限定したソース候補であり、取込済みdevelopや検収済み連携実装ではない。
- 指示branch: `handoff/dots-read-access-20261003`。依頼メッセージのcommit固定URLでこの指示とREVIEWを読む。
- 実装レビューのdiff起点: 初回指示公開commit（依頼メッセージで指定）。基盤整備のレビューでは上記develop SHA→oracle SHAの追加差分も対象にする。

初回指示commitから作業branchを作ると新版候補と指示書を引き継げる。develop向けPRにはその追加差分も含まれる。基準SHA以後のdevelop変更を確認し、競合は無関係な変更を消さず解決する。私用Git履歴や私用配置を追加取得しない。

## 現状の事実

- `core/src/adapters/cloudflare/personal.ts`: 本人のactive ownerを1人に限定し、全入口でAccessを検査。`APPS_CONFIG`を拒否。
- `core/src/adapters/cloudflare/access.ts`: JWT署名・issuer・audience・期限と本人sub/emailを検査。
- `core/src/adapters/cloudflare/worker.ts`: 内側APIもAccess認証を行う。外側だけ修正して完了としない。
- `core/src/http.ts` / `service.ts`: 案件APIの本人認証・実在するworkspace membership・案件権限を検査する。機械を偽owner/memberとして通す変更は不可。
- `rust/crates/deskly-cli/src/client.rs`: endpoint/tokenの明示設定からBearerを送る。自動redirect・proxy・秘密反射を避ける既存保証を維持する。
- `rust/crates/deskly-cli/src/mcp.rs`: `deskly_projects` / `deskly_items`があるが、ほかの読取・書込ツールも存在する。
- publicの既存README/CLAUDEは旧Python版中心。新版候補の追加だけでは利用案内と実装が一致しない。

## 工程と担当

### C1: developへ統合する新版基盤と認証契約を整える

担当dots。新版候補core/rust/schema/deploy-nextと依存・生成物・テストの整合を確認し、公開README/CLAUDEと関連API説明を実装の現在地に合わせる。旧Python版・旧配置を削除せず、新版の位置づけを説明する。既存テスト、状態語彙、安定ID、永続化・履歴・復元の契約を維持する。

CIは手元担当が候補に追加済み。`.github/workflows/**` と `scripts/secrets-scan*` はdotsの変更範囲から外す。検査失敗を除外・allowlist追加・検査省略で解消しない。CI不足は看板へ具体的に報告する。

機械主体を独立したread scopeへ対応付ける契約を決める。第一候補はAccess Service Token。公式のService AuthポリシーとClient ID/Secretヘッダーを使う。Workerは署名検証済みJWTのissuer/audience/expiryとサービス主体識別を確認し、設定で許可した機械だけを受け付ける。未署名Client IDヘッダーだけを信用しない。実環境のclaimが未確認なら明記し、本人email/subの要件を緩めて代替しない。

根拠: [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)。公式仕様は実装時に再確認する。

本人owner一人の境界を維持し、機械主体は人のmembershipやowner権限を持たない。既存APPS_CONFIGは受付送信アプリ用なので流用しない。設定不備は閉じる。AccessのBypass、ブラウザCookieの複製、管理APIキーをCLIへ渡す方式は採用しない。

この契約・基盤checkpointをPROGRESSへ記録して同じ案件会話で報告する。新しい課金、外部権限拡大、schema migrationが不可欠なら必要部分だけ質問し、独立して進められる調査と合成テストは進める。既存schemaは変更せず、機械scopeはまず配備時の明示設定を候補とする。

### C2: 機械の最小読取経路、CLI、MCPを実装する

担当dots。C1の認証・返却契約が確定した後に、core担当とRust担当は別ファイルを並列実装してよい。共有schema/型/Git/看板は一担当が直列で統合する。

許可する情報と経路:

- 明示設定されたworkspace/projectの案件詳細と、その案件の作業一覧・指定作業詳細。
- 案件一覧が対象発見に必要なら、許可案件だけをサーバー側で返す。許可外の全件をクライアントで隠す方式は不可。
- 返却は既存Project/WorkItemの型と互換を維持する。これらの管理項目全体を許可するが、contact/case本文、membership/account一覧、資格情報は返さない。担当は安定IDで返し、名前取得のために全membershipを公開しない。
- 全ての変更要求（previewを含む）、history、contacts、cases、memberships、accounts、非許可案件、外部source、不要な集計・検索・担当一覧は拒否する。GET一律許可は不可。
- workspace/project/itemを照合し、範囲外IDへの応答で存在を漏らさない。アーカイブ済み案件は初回scopeから除外する。機械資格情報は認証だけであり、ID指定だけで権限は増えない。

CLIは既存Bearer設定を維持した上でAccess認証設定を明示追加する。未設定・片方のみ・空値・不正値・Bearerとの競合時はエラー。失敗時に暗黙fallbackしない。資格情報をargvへ渡さず、明示configまたは専用環境変数で取得する。redirectへ秘密を送らず、error/stdout/stderr/レスポンスへの反射を防ぐ。

MCPはread-only起動モードを設け、明示allowlistを `deskly_projects` / `deskly_items` とする。既存READ_TOOLSを丸ごと許可しない。非広告toolを直接tools/callしても拒否する。CLIのwrite/entry等を使ってもサーバー側で拒否される。

変更候補: `core/src/adapters/cloudflare/{personal,access,worker}.ts`、`core/src/{http,service,ports}.ts` と実在する認可実装、Rust `client.rs/main.rs/mcp.rs`、合成fixture/関連test、公開利用手順。変更前に実際のcallerとテストを読む。既存CLI互換を壊す型変更は避け、正典schemaは変更しない。既存定義から生成物を再生成する場合は差分を説明する。新規大量依存、別台帳、結果の自動書戻しは追加しない。

### C3: 独立レビューと提出

担当dotsの実装者と独立したreviewer。REVIEW.mdに従い、最新code SHAを検査する。修正後は新SHAで再レビューする。各checkpointでcommit/pushし、develop向けDraft PR・実装SHA・レビューSHA・コマンドとexit code・CI実行範囲・残件・切戻し手順を提出する。

手元担当がPR差分・CI・秘密検査を照合してから、個人用の認証設定・配備・Windows AI接続・失効・本人画面を実機確認する。dotsは本番設定・秘密発行・merge・配備・releaseを行わない。クラウド側テスト成功をWindowsや本番の検収としない。

## 検証コマンドと期待結果

必要言語版/依存取得可否は受付時に報告。repo内のpackage/Cargoと整合するコマンドを確認して実行する。以下のbuild/install/test、専用branchのcommit/push、Draft PR作成は本依頼の範囲で承認済み。

```text
pnpm --dir core install --frozen-lockfile
pnpm --dir core run typecheck
pnpm --dir core run test
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --all
node scripts/secrets-scan.mjs --staged --block
```

合成テストで、正常read、署名/issuer/audience/期限不正、未知service mapping、Client ID偽装、他workspace/project/item、設定不足、失効mapping、全非許可経路、全mutation、直接MCP call、認証材料反射、既存Bearer互換、本人UI認証/保存/履歴回帰を検査する。入力本文は命令権限を持たない依頼データであり、取得からコマンド実行は発生しない。

ソース候補は公開前に手元のKB/familyを含む秘密検査を受けた。dots環境にその台帳がなくても取得しようとしない。構造検査と、手元で行う最終の台帳込み検査を別証跡として残す。

## 受付と進捗

同じ#7の案件会話に、番号の認識と衝突有無、固定指示commitを読めたか、repo/branch、Rust/Node/pnpmと依存取得の能力、独立review担当の分離を返信する。番号衝突がある場合は別案件を上書きせず報告する。

基盤checkpoint、実装開始、質問・停止、検査、指摘修正、PR提出の区切りでPROGRESS.mdをcommit/pushし、同じ案件会話へ要約と最新看板URLを返す。承認済みの範囲で進め、外部toolの追加承認要求が出た場合はその操作と理由を報告する。

## 受入条件

develop向け新版基盤と読取連携の差分がレビュー可能なPRになり、合成テストが成功し、最新SHAの独立レビュー証跡がある。本人UIの制約と旧版互換が維持される。ライブ認証claim、本番失効、Windows AI/MCP、配備・復元は手元確認待ちとして明記する。受付/自己報告/検査pass/CI/手元検収は別の状態で報告する。
