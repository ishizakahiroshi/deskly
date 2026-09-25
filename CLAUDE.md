<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# deskly 開発ガイド

## プロジェクト概要

deskly は、連絡・案件・工数を 1 か所で見渡すための道具です。「いま誰の番で、次に何をするか」と「誰がどの案件にどれだけ時間を使ったか」に、画面・AI（MCP）・CLI で答えます。

deskly が持つのは**連絡の台帳**（管理の欄・下書きの本文・変更の経過）だけです。作業の記録・案件の台帳・チャット・メール・予定は、それぞれの道具が持つものを MCP か CLI の出力で読みます。特定のツールに寄らず、道具の種類ごとに、つなぐ部品を差し替えます。

## 設計の決まり（変えないこと）

- 1 つの事実を書き換える場所は 1 か所。deskly は連絡の台帳だけを持ち、ほかの道具の記録を写さない
- 連絡の状態は 6 つの言葉だけ: `下書き`・`送信済み`・`回答待ち`・`対応中`・`完了`・`送らない`。「誰の番」は、この状態と案件の台帳の状態の組み合わせで出す（新しい言葉を作らない）
- 一覧は案件ごとに 1 行。案件の無い連絡は、それだけで 1 行
- 台帳は置き場を差し替えられる（`local` = 手元のファイル、`server` = 別の機械で動く deskly）。複数の台帳を 1 つの一覧にまとめて出せる
- AI が要らないところは AI を使わない。一覧・期限切れ・誰の番・画面は、台帳から機械的に作る
- MCP の書く道具は承認付き。既定では変更の見本を返すだけで、`apply=true` のときだけ書く
- すべての書き込みを、変更の経過（いつ・どの欄・前の値・後の値・誰が）に残す
- 特定の組織名・人名・実データを、コード・設定の例・テストに入れない。テストのデータは合成で書き、IP の例は TEST-NET（`192.0.2.x` など）だけにする
- 家族の情報は扱わない

## やらないこと（スコープ外）

- 独自の案件管理（案件の台帳は、外の道具のものを読む）
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
| ローカル作業ノート（非公開） | `docs/local/`（存在する場合） |
