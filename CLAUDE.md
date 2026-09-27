<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# deskly 開発ガイド

## プロジェクト概要

deskly は、開発・営業・連絡を案件ごとに見渡すための道具です。専用ダッシュボードを主な入口とし、「何を目指し、誰が次に何をするか」を画面・AI（MCP）・CLI から扱います。個人の初回運用から始め、権限を整えたうえでチームの複数案件へ広げます。

連絡は連絡台帳、deskly 自身が管理する案件・目標・マイルストーン・次の行動・担当・確認日は別のworkspace台帳を正本にします。外部サービスの案件・作業記録・チャット・メール・予定は元サービスを正本として読み取り、参照で結びます。実装段階と検証の境界は [チームダッシュボード設計](docs/reference_team-dashboard.md) を参照してください。

## 設計の決まり（変えないこと）

- 1 つの事実を書き換える場所は 1 か所。deskly 所有の管理項目と外部所有の記録を区別し、同じ状態を二重管理しない。外部サービスへの書き込みは今回の拡張に含めない
- 連絡の状態は 6 つの言葉だけ: `下書き`・`送信済み`・`回答待ち`・`対応中`・`完了`・`送らない`。「誰の番」は、この状態と案件の台帳の状態の組み合わせで出す（新しい言葉を作らない）
- 一覧は案件ごとに 1 行。案件の無い連絡は、それだけで 1 行
- 新しい案件管理は workspace・project・member の安定 ID で区切る。表示名や既存の `Contact.project` 文字列を、権限・結合のキーとして流用しない
- 個人向けの単一パスワードや台帳全体の Bearer token はチーム本人認証ではない。共有開始前に、全入口の本人認証・案件権限・更新競合・履歴・復旧を確認する
- 台帳は置き場を差し替えられる（`local` = 手元のファイル、`server` = 別の機械で動く deskly）。複数の台帳を 1 つの一覧にまとめて出せる
- AI が要らないところは AI を使わない。一覧・期限切れ・誰の番・画面は、台帳から機械的に作る
- MCP の書く道具は承認付き。既定では変更の見本を返すだけで、`apply=true` のときだけ書く
- すべての書き込みを、変更の経過（いつ・どの欄・前の値・後の値・誰が）に残す
- 特定の組織名・人名・実データを、コード・設定の例・テストに入れない。テストのデータは合成で書き、IP の例は TEST-NET（`192.0.2.x` など）だけにする
- 家族の情報は扱わない

## やらないこと（スコープ外）

- 外部台帳を自動複製して deskly の案件台帳へ置き換えること、外部サービスへの双方向同期
- チャット・メールの送信と、人が話しかけずに AI が動く機能（将来の方向として保留中）
- 会計・課金・ログの閲覧
- 多言語の画面（まず日本語）

## 技術スタック

| 層 | 技術 |
|---|---|
| 本体 | Python 3.11 以上。標準ライブラリだけ |
| 台帳 | SQLite（WAL・`busy_timeout`） |
| CLI | argparse。`--json` で機械向けの出力 |
| MCP | `mcp` SDK の FastMCP（stdio）。extra `mcp` |
| server の置き場 | 標準ライブラリの HTTP サーバー。Bearer 認証。既定は `127.0.0.1` で待ち受け |
| 画面 | HTML / CSS / JavaScript、個人用はloopback HTTP・単一パスワード。案件画面と共有認証の提供段階は設計文書を参照 |
| 配布 | `deploy/`（Docker compose・Dockerfile・反映のスクリプト） |
| テスト | pytest・ruff・mypy。extra `dev` |

## ディレクトリ構成

```
deskly/
├── deskly/    — 本体（cli・store・importer・views・mcp_server・api_server など）
├── tests/     — テスト（合成データだけ）
├── deploy/    — サーバーへ置くもの（compose・Dockerfile・install-release.sh）
├── docs/      — 公開する資料（docs/local/ は作業ノートで、追跡しない）
└── scripts/   — secrets-scan など（scripts/local/ は接続先に依存するので追跡しない）
```

## 主要コマンド

```
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,mcp]"
.venv\Scripts\python -m pytest -q
.venv\Scripts\python -m ruff check deskly tests
.venv\Scripts\python -m mypy deskly
```

macOS / Linux では `.venv\Scripts\python` を `.venv/bin/python` に読み替える。

## 設定と台帳の置き場

- 設定は `~/.deskly/config.toml`、台帳は `~/.deskly/ledger/<名前>.sqlite3`
- 環境変数 `DESKLY_HOME` で置き場を差し替える。テストは必ず一時フォルダへ向け、実際のホームを読まない
- 台帳をクラウドの同期フォルダの中に置かない（開いたまま同期されると壊れる）

## AI 作業共通ルール

ビルド・コミットの扱い、secrets-scan の責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）。

- 作業ノート（plan 等）は `docs/local/` に置き、追跡しない
- 依存を足すときは、本体の依存を増やさず extra に入れる

## Obsidian artifacts

If `docs/obsidian/README.md` exists, use it as an index for related knowledge artifacts.
Use the repository-relative `docs/obsidian` entry. Do not write to a central absolute
path and do not silently fall back to `docs/local` when the entry is missing.

## secrets-scan（このリポジトリの配線）

書く瞬間の責務（固有名詞の一般化・fixture は合成データ等）は上記「AI 作業共通ルール」の参照先に従う。このリポジトリ固有の配線は以下:

- scanner: `scripts/secrets-scan.mjs`（手動実行: `node scripts/secrets-scan.mjs --staged --block`）
- layer 2: pre-commit hook（`.githooks/pre-commit` 経由・`git config core.hooksPath .githooks` で有効化済み）
- layer 3: `.github/workflows/secrets-scan.yml`（CI backstop）
- layer 4: release ゲート
- env (full coverage に必要・未設定なら構造 regex のみで継続): `KB_ROOT` / `FAMILY_ROOT`。設定詳細は `scripts/secrets-scan.mjs` の冒頭コメント

## 関連ドキュメント

| 項目 | パス |
|---|---|
| ユーザー向け README | `README.md` |
| Codex/他 AI 用入口 | `AGENTS.md` |
| 案件管理への拡張・最小画面・共有開始条件 | [チームダッシュボード設計](docs/reference_team-dashboard.md)（採用設計と未実装範囲） |
| ローカル作業ノート（非公開） | `docs/local/`（存在する場合） |
| Obsidian knowledge artifacts | `docs/obsidian/`（存在する場合。作業キューではない） |
