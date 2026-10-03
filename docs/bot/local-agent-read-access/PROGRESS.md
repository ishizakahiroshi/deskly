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

更新: 2026-10-03。手元担当: ローカルCodex。実装担当: dots #7 implementation。独立review担当: 実装担当とは別担当。固定SHAでソース・合成probe・回帰を実行。結果はREVIEW_RESULTS.mdへ記録。

| 工程 | 担当 | 状態 | 証跡・残件・次の一手 |
|---|---|---|---|
| 限定ソース候補と依頼書の準備 | 手元Codex | prepared | oracle d498e98c55274d1f9dfc622b95ab46f0e0746384。develop未統合 |
| 送信・受付 | 手元Codex/dots | received | 固定7453e5cのREADME/REVIEWを全文確認。専用branchで開始 |
| C1 公開基盤・認証契約 | dots | checkpoint | AUTH_CONTRACT.md確定。README/CLAUDE/AGENTS・Cargo licenseを整合。基盤core 389 pass |
| C2 読取連携・合成テスト | dots | synthetic checks passed | Core 402、Rust 92 pass。P2修正済み。実機とは別 |
| C3 独立レビュー・PR | dots別reviewer | submitted / reviewed | 最終code08539a8の独立reviewに残findingなし。Draft PR #1、同SHA CI全5 check success。REVIEW_RESULTS.md参照 |
| 本番設定・Windows手元検収 | 手元担当 | pending | PRレビュー後。dotsの完了と区別 |

## 証跡の区別

初回指示SHA: 初回公開commitのGit履歴と依頼receiptで確定（看板自身のcommitを自己参照しない）。

挙動oracle: d498e98c55274d1f9dfc622b95ab46f0e0746384。

最新code SHA: 08539a8db37c264e135b9410ecb121389218667d（機械連携fbc54a0 + ownerの既存Python fixture修正）。独立review済みcode SHA: 08539a8db37c264e135b9410ecb121389218667d（P2修正とowner fixture修正を含む）。Draft PR: https://github.com/ishizakahiroshi/deskly/pull/1 （base develop）。CI: 下記履歴でSHA別に区別。

受付commit読了: 7453e5c3e3e19d714ebb432754c7069dbfd18431 のREADME/REVIEWを全文確認。

Toolchain実測: Node v24.19.0、pnpm 11.19.0、rustc 1.90.0、cargo 1.90.0。coreはNode >=22、Rust CLIは1.88以上を要求。

依存取得: pnpm初回は既定storeのホームディレクトリ不存在によりexit 254。専用の書込可能storeを明示した再実行はexit 0（91 packages）。cargo fetch --locked exit 0。最新Rust全test 92 pass、clippy/fmt exit 0。

会話locatorと秘密はこの公開看板へ記載しない。自己報告と手元確認を明示する。

## 履歴

2026-10-03 手元Codex: develop基準の隔離branchへ限定ソース候補と指示書を用意。実装・ライブ接続検収は未実施。工程の開始/停止/検査/提出ごとにchanged paths、commands/exit code、code/review SHA、PR/CI、未実施、次の一手を追記する。

2026-10-03 09:23 UTC / 受付checkpoint: 公開repoを取得し固定指示commitから専用branchを作成。origin/developは引き続きb0c3202。AGENTS/CLAUDE、認証入口、HTTP/service、CLI/MCP callerを確認。Cloudflare公式のservice JWTはtype=app・common_name=Client ID・sub空文字と再確認。秘密/私用履歴は未取得。C1契約案はAUTH_CONTRACT.md。実装・テストpass・独立review・CI・本番検収はまだ主張しない。

2026-10-03 09:25 UTC / 依存: frozen-lockfile install成功。Git CLIは認証/作者設定がないため公開GitHub connectorで同じ専用branchへcommit/pushする。追加受入条件: Cargoライセンスを既存AGPL-3.0-or-laterへ整合、親archived/子active拒否、他案件item ID拒否、読取前後store/history不変。

2026-10-03 09:34 UTC / C1基盤・契約checkpoint、C2開始:
- remote開始commit abfbdae98d1a19657d330b41058198a8d4c512beをbranchからreadback済み。ref更新が一度停止し、明示再承認後に同じ操作を再開。
- changed paths: README.md、CLAUDE.md、AGENTS.md、rust/Cargo.toml、AUTH_CONTRACT.md/PROGRESS.md。旧Pythonを保持しcore/rust候補の説明・検収境界を明記。LICENSEは変更せずCargoをAGPL-3.0-or-laterへ整合。
- pnpm frozen install exit 0、core typecheck exit 0、core test exit 0（389 pass / 0 fail / 0 skip / 0 cancel、機械認証追加前）。cargo fetch --locked exit 0、cargo metadata --no-deps exit 0（両crateのlicense継承確認）。このC1時点ではRust compile/test未実行（現在は上記の92 pass）。
- 手元担当の自己報告: 固定7453e5cのWindows隔離worktreeでCore型検査・389/389 test、Rust test/fmt/clippyが成功。こちらの変更とライブAccess/Windows AI受入の証拠にはしない。
- C1認証/返却契約確定後、C2の外側/内側/serviceと合成負例テストを実装開始。Rustビルドは同一executorの他作業と資源調整中。この時点では独立review・PR・CI・本番は未実施。最新状態は上表。

2026-10-03 09:50 UTC / C2実装・合成検査checkpoint:
- C1 code/docs commit: 00a2d3b93f995add71ad4d73c3bd7070e0d05ed6（remote readback済み）。C2 code SHAはこのcheckpoint commitで確定し、後続のreview記録で参照する。
- changed paths: core/src/adapters/cloudflare/{access,personal,worker}.ts、core/src/{ports,http,service}.ts、core/tests/machine-read-access.test.mjs、rust/crates/deskly-cli/src/{client,main,mcp}.rs、同tests/{access,mcp}.rs、README/配備説明/読取手順/契約/看板。schema・生成型・lockfile・CI/scanner・LICENSEは変更なし。
- Cloudflare公式形状の署名済service JWTを独立machine-read主体へ対応付け、outer personal・inner Worker/API・serviceで4 GET形状のworkspace/project/itemを制限。mapping削除・archived親/子・他案件item・全非許可route/methodを検査。機械からmembership/account/contact/event/case portsへアクセスしないテストと、Memory/SQLite/D1読取前後snapshot一致を追加。
- Client IDの契約を補足: UUIDはworkspace/projectだけ。opaque Client IDの完全一致（case変換/trimなし）であり、非UUID成功・1文字違い/大小文字違い/未知ID失敗を検査。手元の独立契約review報告はこの曖昧さ1点のみ。実装codeの独立reviewやライブ受入とは別証跡。
- RustはAccessペアをconfig/専用envだけで受け、partial/empty/null/control/Bearer混在を拒否。redirect/proxy/反射防止、旧Bearer維持。MCPは明示read-onlyとAccess時強制modeで2 toolだけを広告/実行。直接非広告call、CLI preview/entryの拒否を合成検査。
- 実行: pnpm --dir core run typecheck exit 0。pnpm --dir core run test exit 0（402 pass、0 fail/skip/cancel）。追加scope強化後のnode --test core/tests/machine-read-access.test.mjs exit 0（13 pass）。旧Worker node tests exit 0（7 pass）。cargo test --manifest-path rust/Cargo.toml --all --locked exit 0（91 pass、0 fail/ignore）。cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings exit 0。cargo fmt --manifest-path rust/Cargo.toml --all -- --check exit 0。git diff --check exit 0。
- 秘密検査: node scripts/secrets-scan.mjs --staged --block exit 0（18 files）、--all-tracked --block exit 0（270 files）。KB_ROOT/FAMILY_ROOT未設定のため構造4 patternsだけであり、手元台帳込み検査ではない。
- 初回検査の修正履歴: Core fixtureのarchived更新でversion増分が不足し2 test fail、fixtureを契約どおり直して再実行pass。Rust CLI負例のentry呼出しに--projectが不足し1 test fail、呼出しを直してfull suite再実行pass。検査除外や期待値緩和はしていない。
- 検査環境: Node 24.19.0/pnpm 11.19.0/Rust 1.90.0。Rustは専用target、jobs=2、incremental無効、dev/test debug=0。環境や秘密の設定は変更していない。
- 未実施: Python full checks（PR CIで確認予定）、独立code review、GitHub CI、ライブAccess claim/失効、Windows AI/MCP、本人ブラウザ、配備/復元。手元KB/family台帳なしの構造秘密検査と、手元台帳込み最終検査は別。
- 切戻し: 配備設定の機械mappingを削除/[]にすれば次要求からscopeなし。コードはレビュー済み前版へ戻す。schema/data migrationなし。本人owner設定と旧Python配置を維持する。本番操作は手元担当のみ。

2026-10-03 09:57 UTC / 独立review指摘修正:
- レビュー対象: d1990179764584130d6f2bec46535ef13e92b52c（tree c13a88a8deb0abe3d2b324d75d3ccb4ebe83975c、remote readback済み）。別担当が合成APIで再現したP2: CLI my-work/entry showは許可されたproject/item readだけから派生結果を作れた。許可案件0件ではsearch/countsも成功し得た。scope外データの漏洩は観測されていないが、明示拒否契約違反。
- 修正: Access CLIの許可をprojects/itemsのlist/detailとMCPだけに限定し、それ以外はHTTP・ローカルファイル/Git処理の前に固定forbiddenで拒否。新しいcommandも既定拒否。server側のscope/preview拒否は維持。
- changed paths: Rust client.rs（静的エラー）、main.rs（command allowlist）、tests/access.rs（13個のCLI負例でHTTP 0件。raw Clientのwrite/entryは引き続きserver 403を確認）、利用説明/契約/看板。
- cargo test --manifest-path rust/Cargo.toml --all --locked exit 0（92 pass、0 fail/ignore）。cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings exit 0。cargo fmt --manifest-path rust/Cargo.toml --all -- --check exit 0。Core sourceはC2から変更なし。
- この修正commitのimmutable SHAで独立再レビューを依頼した。旧SHAの検査結果を承認として引き継がない。この時点でDraft PR/CI/実機検収は未完了（最新は上表）。

2026-10-03 10:05 UTC / Draft PR提出・CIの既存fixture修正候補（未公開）:
- Draft PR #1: https://github.com/ishizakahiroshi/deskly/pull/1 。base develop=b0c3202、head=fbc54a0688fd10f882f68c703aadc275b3842217をreadback。merge/release/deployなし。
- fbc54a0 CI: core、Rust、旧Worker、構造secrets-scanはsuccess。Pythonは324 pass / 3 fail / 1 skip、後続ruff/mypyはskipped。実行: https://github.com/ishizakahiroshi/deskly/actions/runs/37114899035 、秘密検査: https://github.com/ishizakahiroshi/deskly/actions/runs/37114898966 。
- 原因: 変更していない旧Pythonのtests/test_shared_cli.py::_setupがPOSIXの一時homeを既定0755で作る一方、既存shared_cli._resolve_homeは0700を要求。b0c3202→fbc54a0のdeskly/tests/pyproject.toml差分が空であることと、合成0755拒否/0700許可を確認。セキュリティ検査は正しく作動している。
- ローカルの修正候補はtests/test_shared_cli.pyのhome.mkdir(mode=0o700, parents=True) 1行のみ。手元の別担当が調査中のため、重複防止の調整待ちとしてcommit/pushを保留。公開branchには含まれない。production、依存宣言、CI/scanner、期待値・除外は変えない。
- Python 3.12.14、既存dev/mcp extra install exit 0。python -m pytest -q exit 0（327 pass / 1 skip）、python -m ruff check deskly tests exit 0、python -m mypy deskly exit 0（31 source files）。skipは既存tests/test_dashboard_ui.pyのhatchling.build未導入によるpackaging検査。依存を追加して隠さず、別の未実施範囲として残す。
- Core/Rust実装はfbc54a0から不変。Core型/全testの再実行もexit 0、402 pass。独立review担当はfbc54a0のRust92/clippy/fmtとCLI→署名JWT→personal Worker→service合成probeを確認済み。公開実装fbc54a0の独立レビューは完了。Python修正を公開する場合は新SHAで別途確認する。

2026-10-03 10:09 UTC / owner修正を保持してCI読戻し:
- ownerが同じPR branchへ08539a8db37c264e135b9410ecb121389218667dをpush。fbc54a0との差分はtests/test_shared_cli.pyのprivate mkdir 1行だけ。実装担当の同一候補はcommit/pushせず、owner commitへ追従した。以後はレビュー証跡/看板のdocs-only更新。
- exact 08539a8で全5 checkがsuccess。Python pytest/ruff/mypy、Core install/typecheck/test、Rust fmt/clippy/test、旧Worker node testは実際に実行されてsuccess。Core/Rustの「Skip notice」は対象ありのためskippedであり、テストjob省略ではない。
- CI: https://github.com/ishizakahiroshi/deskly/actions/runs/37115293262 。構造secrets-scan/CLAUDE構成確認: https://github.com/ishizakahiroshi/deskly/actions/runs/37115293244 。CIの秘密検査は明示的に構造のみ。hatchling不足による既存packaging test skipと、手元台帳込み検査は別の残件。
- 独立レビュー: fbc54a0でCore402、追加JWT/scope/owner probe11、Rust92/clippy/fmt、旧Worker7、CLI→合成Access edge→署名JWT→personal Worker→serviceの4許可read/11禁止command/2範囲外readとsnapshot/history不変を再確認。08539a8の1行差分と影響するPython検査の追認後、REVIEW_RESULTS.mdへ最終記録を掲載する。

2026-10-03 10:13 UTC / 最終レビュー証跡と提出checkpoint（docs-only）:
- code/review SHA: 08539a8db37c264e135b9410ecb121389218667d。独立担当がownerの1行fixture修正を確認し、追加/影響範囲を再検査。未解消findingなし。独立レビュー全文はREVIEW_RESULTS.md。
- 最終差分の独立検査: Python327 pass / 1 existing hatchling skip、ruff exit 0、mypy exit 0（31 files）、machine+追加probe24 pass、CLI end-to-endの許可4/HTTPなし拒否11/scope404 2/snapshot-history不変。Core/Rust/production/schema/deploy/CI/scannerがfbc54a0と同一であることも独立に確認。
- 独立担当も08539a8のCI run37115293262/37115293244と全5 check success・実行stepをreadback。旧fbc54a0のPython失敗を消さず、owner修正後の証跡と分けた。
- この提出checkpointはPROGRESS.mdとREVIEW_RESULTS.mdだけを追加/更新し、owner commitを親として保持する。新しいsource・test・CI/scanner変更はない。docs-only tipのreadback、reviewed codeとの同一性と最終PR checkはPR本文/同じ案件会話で報告する。
- 完了の境界: develop向けDraft PRと合成検査/独立レビュー/CI証跡の提出。merge、本番設定、秘密発行、配備、releaseは実施しない。ライブAccess claim・失効・Windows AI/MCP・本人ブラウザ・配備/復元・手元KB/family込み秘密検査・既存hatchling packaging testは手元確認待ち。
