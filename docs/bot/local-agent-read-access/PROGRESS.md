---
type: reference
status: draft
tags: [deskly, progress]
owner: ishizakahiroshi
review_status: draft
related: [README.md, REVIEW.md]
last_reviewed: 2026-10-03
---

# dots #7 進捗看板

案件: Deskly develop 新版基盤とローカルAI読取連携

repo: ishizakahiroshi/deskly。PR base: develop。指示branch: handoff/dots-read-access-20261003。作業branch: dots/deskly-local-agent-read-access-7。

更新: 2026-10-03。手元担当: ローカルCodex。実装担当: dots #7 implementation。独立review担当: 別担当を最新code SHAで割当予定（未レビュー）。

| 工程 | 担当 | 状態 | 証跡・残件・次の一手 |
|---|---|---|---|
| 限定ソース候補と依頼書の準備 | 手元Codex | prepared | oracle d498e98c55274d1f9dfc622b95ab46f0e0746384。develop未統合 |
| 送信・受付 | 手元Codex/dots | received | 固定7453e5cのREADME/REVIEWを全文確認。専用branchで開始 |
| C1 公開基盤・認証契約 | dots | in progress | 認証契約案をAUTH_CONTRACT.mdへ記録。依存取得・基盤検査中 |
| C2 読取連携・合成テスト | dots | pending | C1後にcore/Rustを分担可能 |
| C3 独立レビュー・PR | dots別reviewer | pending | 最新code SHAのレビューとCI |
| 本番設定・Windows手元検収 | 手元担当 | pending | PRレビュー後。dotsの完了と区別 |

## 証跡の区別

初回指示SHA: 初回公開commitのGit履歴と依頼receiptで確定（看板自身のcommitを自己参照しない）。

挙動oracle: d498e98c55274d1f9dfc622b95ab46f0e0746384。

実装SHA・review済みSHA・PR・CI: 未提出。

受付commit読了: 7453e5c3e3e19d714ebb432754c7069dbfd18431 のREADME/REVIEWを全文確認。

Toolchain実測: Node v24.19.0、pnpm 11.19.0、rustc 1.90.0、cargo 1.90.0。coreはNode >=22、Rust CLIは1.88以上を要求。

依存取得: pnpm初回は既定storeのホームディレクトリ不存在によりexit 254。専用の書込可能storeを明示した再実行はexit 0（91 packages）。Rust依存取得・build/testは未実行。

会話locatorと秘密はこの公開看板へ記載しない。自己報告と手元確認を明示する。

## 履歴

2026-10-03 手元Codex: develop基準の隔離branchへ限定ソース候補と指示書を用意。実装・ライブ接続検収は未実施。工程の開始/停止/検査/提出ごとにchanged paths、commands/exit code、code/review SHA、PR/CI、未実施、次の一手を追記する。

2026-10-03 09:23 UTC / 受付checkpoint: 公開repoを取得し固定指示commitから専用branchを作成。origin/developは引き続きb0c3202。AGENTS/CLAUDE、認証入口、HTTP/service、CLI/MCP callerを確認。Cloudflare公式のservice JWTはtype=app・common_name=Client ID・sub空文字と再確認。秘密/私用履歴は未取得。C1契約案はAUTH_CONTRACT.md。実装・テストpass・独立review・CI・本番検収はまだ主張しない。

2026-10-03 09:25 UTC / 依存: frozen-lockfile install成功。Git CLIは認証/作者設定がないため公開GitHub connectorで同じ専用branchへcommit/pushする。追加受入条件: Cargoライセンスを既存AGPL-3.0-or-laterへ整合、親archived/子active拒否、他案件item ID拒否、読取前後store/history不変。
