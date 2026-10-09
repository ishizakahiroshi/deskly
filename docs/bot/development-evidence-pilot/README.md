---
type: reference
status: draft
tags: [deskly, dots, development-evidence]
owner: ishizakahiroshi
review_status: draft
related: []
last_reviewed: 2026-10-04
---

# dots #10 — 案件の活動と調査証跡を追うスモールスタート

## 目的と提出物

既存の案件詳細で「いつ活動したか」「どの画面・機能へ集中しているか」「調査や不具合の根拠は何か」「次に何をするか」を確認できるようにする。初回は個人利用の1案件・1リポジトリ。既存案件と作業を再利用する。調査はコミットを伴わないことがあるため、Git活動と測定・調査記録を別々に表示する。

主実装はdots。担当を分けられるなら下記C2/C3を並列化し、統合担当が共有ファイルとGit操作を所有する。成果はdevelop向けDraft PR、合成データによる検証結果、独立レビュー、手元検収用手順。merge・本番反映・リリースは実行しない。

この文書はローカル準備中。正式な公開・送信・受付は[PROGRESS.md](PROGRESS.md)の証跡で確認する。案件番号はIssue/PR番号とは別。

## 基準と既存機能

- repository: `ishizakahiroshi/deskly`、提出先: `develop`。
- 挙動基準: `35e634f1a8c6123e41ecfd63c7bb8527428b8a67`。2026-10-04にリモートdevelopを照合した。受付時に取得できることと、後続変更との衝突を確認する。
- 上記は挙動の基準。指示公開commit、実装commit、独立レビューcommit、看板更新commitは別に記録する。
- 基準には`core/src/http.ts`の`HttpDependencies`、`WorkspaceService`、`core/ui/workspace.ts`の案件詳細、workspace/project権限、案件と作業の正典UIがある。手元の古いcheckoutにcoreが存在しないことを欠落判定に使わない。
- 既存の連絡状態6語、案件・作業DTO、外部サービスの正本、変更履歴、本人認証を維持する。
- ローカルエージェントの機械読み取りは既存のprojects/items限定。今回の証跡は本人の画面用であり、機械の読み取り範囲を拡張しない。

## 初回に作るもの

1. 保存方式に依存しない`EvidenceDataset`契約、厳格な入力検証、集計の純粋関数。
2. 明示したローカルGitリポジトリを読み取るオフライン収集CLI。固定ref、期間、タイムゾーンを指定し、commit証跡を正規化する。リポジトリ・設定・履歴を書き換えず、認証情報の取得やネットワークアクセスはしない。
3. 本人が測定・調査の証跡と画面対応を記入できるローカルJSONの仕様・合成サンプル。初回は編集フォームを作らず、CLIから妥当性検証できるようにする。
4. 管理者が配置した検証済みJSONを読む任意のreadonly provider。既存の本人認証と案件権限を通した案件詳細から表示する。provider未設定の環境は「未収集」と表示する。
5. 日別ヒートマップ、画面/機能別の件数、根拠一覧、未分類一覧、既存作業の次の行動へのリンク。コミットと調査・測定の系列を分け、根拠まで辿れるようにする。

会社の実案件・リポジトリ・実測値・画像は手元でのみ使う。dotsには合成案件と合成Git履歴だけを渡す。Cloudflare環境は初回provider未設定でも動くことを確認する。ローカルファイルをCloudflareへ自動転送する機能は今回作らない。

## EvidenceDatasetの契約をC1で固定する

次を満たすschema、TypeScript型、合成fixtureを最初に提出し、C2/C3で同じfixtureを使う。

| 項目 | 要件 |
|---|---|
| 識別 | schema_version=1、workspace_id、project_id、repository_binding_id。公開fixtureでは不透明な合成IDを使う |
| 収集範囲 | 固定ref、期間の始終と境界規則、集計タイムゾーン、collected_at_utc、最終成功時刻 |
| 取得状態 | commit / issue / pull_request / review / ci / deployment / acceptance / manual_observationの各領域についてcomplete・partial・unavailable・not_collectedと理由。completeは指定範囲内だけの完全性 |
| 証跡 | 安定ID、種類、発生日時UTCとその意味、観測日時UTC、要約、出典参照。再観測で重複しない。再オープン等の別の出来事は潰さない |
| 手動記録 | 測定・調査・結果を区別。測定値には対象操作、単位、方法、日時を付ける。記録日時から作業時間を推定しない |
| 対応付け | 証跡IDから既存work_item_idおよびscreen/functionの安定IDへ明示対応。未対応は未分類。ファイル版を記録する |
| 表示 | 全文をエスケープ。参照URLは許可したhttpsのみ。手元の絶対パスや認証情報を表示用要約に含めない |

ローカルGitで取得できるのは固定refから辿れるcommit。PR、レビュー、CI、配備、受入を推測せずnot_collectedにする。commit時刻の意味を明示し、日別表示は指定タイムゾーンで計算する。件数から進捗率、作業時間、生産性、遅延、バグの深刻度、完了状態を推測しない。「どこに証跡が集中するか」は表示できるが、「どこに時間がかかったか」は測定済み時間がある範囲に限る。

空のcompleteだけが0件。未収集、失敗、部分取得を0に置き換えない。失敗時は最後の成功データの時点と現在の失敗を併記する。1証跡を2画面へ対応付けても案件全体では1件と数え、画面別件数の単純合計を案件件数として表示しない。

## 並列工程とファイル所有

| C | 主担当 | 変更候補 / 完了条件 | 依存 |
|---|---|---|---|
| C1 契約固定 | dots統合担当 | 新schema・型・共通fixture・readonly provider契約・API契約を固定し、権限経路と既存構成への追加方法を報告 | 最初に実施 |
| C2 収集とAPI | dotsデータ担当 | Git CLI、JSON検証、集計、provider、本人用GET、権限/欠測テスト | C1後。C3と並列可 |
| C3 案件詳細画面 | dots画面担当 | ヒートマップ、分類、根拠、次の行動。C1 fixtureでUIを作り、広幅/狭幅と操作を確認 | C1後。C2と並列可 |
| C4 統合と検収 | dots統合担当・独立レビュー担当・手元担当 | 実装SHAを固定、検査、独立レビュー、手元の実案件で受入。受入未実施を明記してDraft PR提出 | C2/C3後 |

以下は新設候補であり、既存APIとして扱わない。C1で実sourceと照合して配置を決め、競合のない所有表をPRに残す。

- データ担当: `schema/development_evidence.schema.json`、`core/src/development-evidence*.ts`、新readonly adapter、`scripts/collect-development-evidence.mjs`、関連unit/APIテスト、`docs/reference_development-evidence.md`。
- 画面担当: `core/ui/development-evidence.ts`、案件詳細への組込、関連スタイルとUIテスト。
- 統合担当: 共通fixture、shared型、API/OpenAPI/生成物の同期、共有入口ファイル、看板。共有ファイルを複数担当が同時編集しない。
- 新GET案: `/api/v1/workspaces/:workspace_id/projects/:project_id/development-evidence`。既存案件読み取りと同じ本人認証・案件権限を適用する。C1で人principalの許可ロールを実sourceと照合し、案件読取と同じ許可表に固定する。機械principalはprovider呼出し前に拒否。案件の存在とarchived時の既存読取方針を先に確認し、providerのworkspace/project/repository_bindingが設定した対象と一致しなければ表示しない。未設定providerは取得状態を返す。依頼者がURL/ファイルパスを指定して読み込む入口は作らない。

初回はcanonical DBへの証跡保存、DB migration、既存DTOへの必須フィールド追加をしない。HTTP依存への任意provider注入等、既存の起動構成を壊さない実装をC1で決める。

## 対象外と互換条件

WBS、ガント、順位付け、組織階層、共有開始、外部GitHub API認証、webhook、常駐収集、通知、自動AI実行、工数推定、人事評価、会社アプリへの組込みは後続判断。Git証跡をDesklyの変更履歴として登録したり、外部の状態からDesklyの作業を自動更新したりしない。

未認証・案件読取権限のない人・他workspace/案件・機械tokenから証跡を読めないこと。初回の運用は本人1名であり、共有開始の受入を兼ねない。既存MCPは変更見本が既定、apply=trueのみ書く契約を維持する。テストは合成データと一時DESKLY_HOME。無関係なdirty変更、CI、scanner、Git hook、認証設定を編集しない。新依存が必要なら用途と版を先に報告し、不要な追加を避ける。

## 検証と提出

- 必須例: 収集済み0件、未設定、失敗、partial、期間境界、タイムゾーン境界、重複、複数画面への対応、未分類、調査のみでcommit0件、異常JSON、他案件・機械principal拒否、HTML/URL入力。不存在/削除済み案件、archived案件のC1で固定した方針、JSONのworkspace/project/repository_binding不一致も確認する。
- 既存`core/tests/machine-read-access.test.mjs`等の回帰を確認。`pnpm --dir core install --frozen-lockfile`、`pnpm --dir core run typecheck`、`pnpm --dir core test`を実行し、コマンド・結果・実装SHAを残す。schema変更がRust/Pythonへ波及する場合はその既存検査も実施する。
- UIは合成fixtureでPCと狭い画面を実際に表示し、ヒートマップから根拠と次の行動へ辿る操作を確認する。静的検査だけでUI検収済みにしない。
- 手元の実案件への対応付けと本人認証つき画面検収は手元担当。dotsができない確認を代行済みと書かない。
- Draft PRにdiff起点、実装SHA、検査、既知の制約、未実施受入、停止/継続の判断材料を記す。独立レビューは[REVIEW.md](REVIEW.md)に従う。

## 受付時の返信

番号#10、読んだ指示公開commit、取得した挙動基準、既存PRとの重複、依存取得/実行能力、C2/C3の分担可否、予定、手元担当へ残す検収を返信する。指示が未公開・未送信の間は実装開始済みと記録しない。
