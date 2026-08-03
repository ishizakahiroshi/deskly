<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# deskly 開発ガイド

## プロジェクト概要

<!-- TODO: 1〜2 段落で、このプロジェクトが何で、誰のためのもので、何を解決するかを書く。 -->

deskly は、業務システム利用者・開発者・運用管理者・経営層をつなぐ **セルフホスト型 service desk suite**。QA 起票・追跡・統合ダッシュボードを中核に、各業務システムへ埋め込む軽量ライブラリ (embed) と、Nextcloud / TranChat / その他チャネル向けの adapter を持つ ports-and-adapters 設計。他社クラウドにデータを預けず、既存の社内 IdP・NC・Agent 基盤に乗る形で運用できる。

配置は private 開始・将来 public 展開を想定（AGPL v3）。core は言語・チャネル非依存の REST API サービスとして構築し、adapter で NC / TranChat / MCP 等に翻訳する。

## やらないこと（スコープ外）

<!-- TODO: 「機能追加の打診」を AI から防ぐため、明示的に切り捨てている範囲を列挙する。 -->

- ログ閲覧本体機能（既存 Grafana / Kibana / Loki 等へ URL 導線で連携するに留める）
- 会計ソフト記帳・仕訳投入・税務判断
- 多言語 UI（初期は日本語のみ、必要になったら l10n）
- 決済・請求機能
- 商用 SaaS 展開（あくまで OSS + 自社ホスト前提）
- 特定顧客向けのカスタム UI 分岐（adapter で切り出す）

## 技術スタック

| レイヤー | 想定技術 |
|---|---|
| core (REST API + storage + MCP) | Go + PostgreSQL + MinIO or FS + FastMCP (Python) |
| adapters/nextcloud | PHP + Vue 3（Nextcloud app SDK） |
| adapters/tranchat | Node or Python（TranChat bot API） |
| adapters/mcp | Python + FastMCP（`nc_accounting_mcp` を参考） |
| ui/web | Vue 3 + Vite（core 直接叩き想定） |
| ui/mobile | PWA（web と共通ビルド） |
| libs/embed | PHP composer / npm 各版（業務システム側言語に合わせる） |

Phase 1 段階では core + adapters/nextcloud + libs/embed（PHP）のみ実装。他は Phase 2 以降で段階追加。

## ディレクトリ構成

```
deskly/
├── core/           — 中核 REST API + MCP + storage（Go）
├── adapters/
│   ├── nextcloud/  — NC app（PHP + Vue）
│   ├── tranchat/   — TranChat bot（後続）
│   └── mcp/        — MCP server (Python)
├── ui/
│   ├── web/        — 独立 Web UI（Vue 3）
│   └── mobile/     — PWA（後続）
├── libs/
│   └── embed/      — 業務システム埋込ライブラリ
├── docs/           — 設計資料 / plan / mockup / recap
└── scripts/        — 開発補助スクリプト
```

## 主要コマンド

<!-- TODO: 各サブディレクトリ init 後に埋める。現状は空 -->

- （未定・core 実装後に追記）

## AI 作業共通ルール

ビルド・コミット禁止、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）。

<!-- このリポジトリ固有のルールがあれば以下に箇条書きで追記する。 -->

- core と adapters の依存方向は **一方向**（adapters → core、逆は禁止）。core は adapter を知らない
- 新規 adapter を追加する時は必ず ChannelAdapter interface に準拠する（core 側の interface を先に定義してから adapter を作る）
- テストは core と各 adapter で独立に回せる状態を維持する（adapter 側は core の mock で単体テスト可能）
- appstore（Nextcloud / npm / PyPI / crates.io）への公開名は **deskly** で統一
- 顧客固有名（Mercury / Meijie / Timely 等）を core / adapters のコード・設定に埋め込まない（tenant として汎化する）

## secrets-scan（このリポジトリの配線）

書く瞬間の責務（固有名詞の一般化・fixture は合成データ等）は上記「AI 作業共通ルール」の参照先に従う。このリポジトリ固有の配線は以下:

- scanner: `scripts/secrets-scan.mjs`（手動実行: `node scripts/secrets-scan.mjs --staged --block`）
- layer 2: pre-commit hook（`.githooks/pre-commit` 経由・`git config core.hooksPath .githooks` で有効化済み）
- layer 3: `.github/workflows/secrets-scan.yml`（CI backstop）
- layer 4: release ゲート
- env (full coverage に必要・未設定なら構造 regex のみで継続): `KB_ROOT` / `FAMILY_ROOT`。設定詳細は `scripts/secrets-scan.mjs` の冒頭コメント
- 参照実装・設計詳細: `worklog-bridge` リポの `docs/local/secrets-scan-design/`（gitignored・公開しない）

## 関連ドキュメント

| 項目 | パス |
|---|---|
| ユーザー向け README | `README.md` |
| Codex/他 AI 用入口 | `AGENTS.md` |
| ローカル作業ノート（非公開） | `docs/local/`（存在する場合） |
| アーキテクチャ設計資料 | `docs/design_deskly-architecture_2026-07-22.html` |
| 統合ダッシュボード UI モック | `docs/mockup_deskly-integrated-view_2026-07-22.html` |
