# Agent Entry Point (deskly)

このリポジトリの運用ガイダンスは `CLAUDE.md` を正本とする。

- プロジェクト概要・ルール: `./CLAUDE.md`
- ユーザー向けドキュメント: `./README.md`
- ローカル/プライベート追記（存在する場合・コミットしない）: `./CLAUDE.local.md` / `./AGENTS.local.md` / `./docs/local/`

個人/グローバル AI ルールは意図的にこのリポジトリの外に置く。各 AI ツールの
グローバル設定を使うこと。本ファイルは fresh public clone でも有効に保つ。

## Non-negotiables (full detail in CLAUDE.md)

- deskly が持つのは連絡の台帳だけ。ほかの道具の記録は読むだけで写さない
- 連絡の状態は 6 つの言葉だけ（`下書き`・`送信済み`・`回答待ち`・`対応中`・`完了`・`送らない`）。新しい言葉を作らない
- MCP の書く道具は承認付き（既定は変更の見本だけ。`apply=true` のときだけ書く）。すべての書き込みを変更の経過に残す
- 特定の組織名・人名・実データを、コード・設定の例・テストに入れない（テストは合成データ）
- テストは `DESKLY_HOME` を一時フォルダへ向け、実際のホームを読まない
- ビルド・コミットの扱い、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）
- secrets-scan のこのリポジトリの配線（scanner パス・手動実行コマンド等）は `CLAUDE.md` の「secrets-scan（このリポジトリの配線）」節を参照

ガイダンス間で矛盾が出たら `CLAUDE.md` を優先する。

<!-- many-ai-cli の承認マーカーブロックはここに自動注入される。本ファイルでは持たない。 -->
