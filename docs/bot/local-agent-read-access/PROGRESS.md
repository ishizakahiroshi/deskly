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

repo: ishizakahiroshi/deskly。PR base: develop。指示branch: handoff/dots-read-access-20261003。作業branch: dots受付時に確定。

更新: 2026-10-03。手元担当: ローカルCodex。実装/review担当: dots受付時に分離を確認。

| 工程 | 担当 | 状態 | 証跡・残件・次の一手 |
|---|---|---|---|
| 限定ソース候補と依頼書の準備 | 手元Codex | prepared | oracle d498e98c55274d1f9dfc622b95ab46f0e0746384。develop未統合 |
| 送信・受付 | 手元Codex/dots | pending | 実送信と固定commit読了返信を別に確認 |
| C1 公開基盤・認証契約 | dots | pending | develop基準で整合、checkpoint報告 |
| C2 読取連携・合成テスト | dots | pending | C1後にcore/Rustを分担可能 |
| C3 独立レビュー・PR | dots別reviewer | pending | 最新code SHAのレビューとCI |
| 本番設定・Windows手元検収 | 手元担当 | pending | PRレビュー後。dotsの完了と区別 |

## 証跡の区別

初回指示SHA: 初回公開commitのGit履歴と依頼receiptで確定（看板自身のcommitを自己参照しない）。

挙動oracle: d498e98c55274d1f9dfc622b95ab46f0e0746384。

実装SHA・review済みSHA・PR・CI: 未提出。

受付commit読了・toolchain・依存取得成功: 未確認。

会話locatorと秘密はこの公開看板へ記載しない。自己報告と手元確認を明示する。

## 履歴

2026-10-03 手元Codex: develop基準の隔離branchへ限定ソース候補と指示書を用意。実装・ライブ接続検収は未実施。工程の開始/停止/検査/提出ごとにchanged paths、commands/exit code、code/review SHA、PR/CI、未実施、次の一手を追記する。
