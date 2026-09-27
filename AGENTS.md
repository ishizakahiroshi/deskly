# Agent Entry Point (deskly)

このリポジトリの運用ガイダンスは `CLAUDE.md` を正本とする。

- プロジェクト概要・ルール: `./CLAUDE.md`
- ユーザー向けドキュメント: `./README.md`
- ローカル/プライベート追記（存在する場合・コミットしない）: `./CLAUDE.local.md` / `./AGENTS.local.md` / `./docs/local/`

個人/グローバル AI ルールは意図的にこのリポジトリの外に置く。各 AI ツールの
グローバル設定を使うこと。本ファイルは fresh public clone でも有効に保つ。

## Non-negotiables (full detail in CLAUDE.md)

- 現行の保存対象は連絡台帳。採用した案件管理への拡張では deskly 所有の目標・作業・担当等を持つ。外部サービスの記録はその正本を読み取り、参照で結ぶ。境界と未実装範囲は `docs/reference_team-dashboard.md` に従う
- 案件管理は workspace・project・member の安定 ID で区切り、個人利用から開始する。共有開始前に本人認証・案件権限・競合・履歴・復旧を確認する
- 連絡の状態は 6 つの言葉だけ（`下書き`・`送信済み`・`回答待ち`・`対応中`・`完了`・`送らない`）。新しい言葉を作らない
- MCP の書く道具は承認付き（既定は変更の見本だけ。`apply=true` のときだけ書く）。すべての書き込みを変更の経過に残す
- 特定の組織名・人名・実データを、コード・設定の例・テストに入れない（テストは合成データ）
- テストは `DESKLY_HOME` を一時フォルダへ向け、実際のホームを読まない
- ビルド・コミットの扱い、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）
- secrets-scan のこのリポジトリの配線（scanner パス・手動実行コマンド等）は `CLAUDE.md` の「secrets-scan（このリポジトリの配線）」節を参照
- `docs/obsidian/README.md` があれば索引として読み、知識記録は repo 相対の `docs/obsidian` を使う。欠損時に `docs/local` へ黙って fallback しない

ガイダンス間で矛盾が出たら `CLAUDE.md` を優先する。

<!-- many-ai-cli の承認マーカーブロックはここに自動注入される。本ファイルでは持たない。 -->
