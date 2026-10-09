---
type: reference
status: draft
tags: [deskly, migration]
owner:
review_status: draft
related: []
last_reviewed: 2026-10-03
---

# 個人版の旧D1から新版へ移す道具

`core/scripts/migrate-legacy-personal.mjs` は旧版の `/api/export` JSONを読み取り、新しい空のSQLite/D1に適用するSQLを生成する。実行前に新版coreのbuildが必要。実データと生成SQL、本人設定はリポジトリ外の私用領域に置く。

```text
cd core
node scripts/migrate-legacy-personal.mjs INPUT.json CONFIG.json NEW.sql
```

CONFIG.jsonの項目は `workspace_id` / `member_id` / `account_subject`（小文字UUID）、`name` / `login`、`identity`（`issuer`はAccessのHTTPS origin、`subject`は本人のAccess subject）。認証secretは不要。これらはWorkerの本人対応と一致させる。画面へ本人設定や台帳本文を出さない。

生成SQLは新schemaとmigration checksumを含む。workspaceのschema_versionは3で、本人owner principalによる新版API利用を可能にする。既存の新版DBへの適用はschema_migrationsのCREATE時点で失敗する。旧版DBを含む既存DBへの適用は禁止し、必ず別の空DBを使う。生成SQL全体の一括rollbackは保証しないため、途中で適用が失敗したらその新DBを利用せず、別の空DBからやり直す。出力先はリポジトリ外で既存ファイルの上書きを拒否する。旧JSONには書き込まない。stdoutは件数と入力SHA256のみ、CLIのエラーは値・私用pathを伏せる。

旧IDはUUIDなら小文字へ、その他の文字列・正整数はtableと元IDから安定したUUIDへ対応させる。新規referenceとmigration operationのIDは元IDがUUIDでも別namespaceでhashから生成する。関係・version・状態を保持し、存在しない案件や他案件の目標への紐付け、変換後IDの衝突は拒否する。新たに必要なowner/assigneeは本人、案件状態は進行中、作業種別は開発とする。元に無い待ち理由は空、archivedはfalse。repository_urlはhttps referenceへ写す。

scope・日時・元actor・元ID・旧変更履歴は `legacy_personal_rows` に全行をraw JSONとSHA256付きで保存する。入力ファイルの全byte相当のUTF-8 textも `legacy_personal_export` に保存する。両表はupdate/delete/replaceをtriggerで拒否する。新版の通常履歴には移行時点のsnapshotを案件・目標・作業ごとに1件作る。旧変更履歴は専用原文保管表にあり、通常画面での旧履歴表示はこの道具に含まない。

新版のruntime validationに合わない長さ、空の必須項目、前後空白等は切り捨てや創作で補わず生成前に拒否する。`incompatible_...` はtable名・元IDのhash・検査codeだけを示す。この場合は入力値を本人が修正するか、互換schema/runtimeを追加してから再生成する。

切り替える前に、旧WorkerのJSONとD1 SQLの両方の控えを取り、件数・hashを確認する。生成SQLは別の新D1で適用し、raw全行hash、関係、件数、新版の読み取りと本人認証を照合する。旧Workerと旧D1は削除・変更せず残す。

復旧の照合では、旧4表のtable別件数と全raw row hash、保存されたexport textのSHA256、外部キー検査、新版schema_migrationsの名前・checksumを確認する。新版のSQL控えは別の空D1へ読み戻し、これらと新版resources/events/受付関連表の件数・hashを元の新D1と比較する。控えが取れたことと復元できることは別の検証結果として残す。本人設定や原文をログへ出さず、判定結果・件数・hashだけを記録する。

切替前後の検証で受付・案件を書いた場合も、その書込みは新版にだけ残る。旧へ向き先を戻すだけでは切替後に新版へ書いた内容は旧に戻らない。この道具は新版から旧版への逆変換を提供しない。rollback時は新版への書込みを止め、最新の新D1 SQL控えを保管してから旧へ戻す。新D1を削除せず維持すれば新版での追記・履歴を保持できるが、旧画面から閲覧できることは保証しない。新版の書込解禁前に新D1の控えと別DBでの復旧確認を済ませる。

自動試験: `node --test tests/legacy-personal-migration.test.mjs`（core内）。合成データだけを使い、SQLiteStoreでのreadback、owner principalでのworkspace/account/projects/events/preview、原文hash、append-only制約、UUID案件と新規referenceのID分離、重複と関係エラー、出力上書き拒否を確認する。実D1復元・実データ移行・ブラウザ受入は別途検証する。
