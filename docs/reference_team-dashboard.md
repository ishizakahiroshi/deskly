---
type: reference
status: draft
tags: [team-dashboard, architecture]
owner: ishizakahiroshi
review_status: draft
related: []
last_reviewed: 2026-09-27
---

# チームダッシュボードへの拡張設計

2026-09-27採用の設計。個人の初回運用とチーム共有の責務を定めた。C2の個人用workspaceは実装・commit済みで、個人運用を開始した。C3の共有Web（アカウント単位の認証・cookieセッション・案件権限）も実装・commit済みで、会社用ホストへ反映した。ただし2アカウント・2案件での受入、実際の利用者による操作、共有環境の復旧は未実施で、共有の開始条件はまだ満たしていない。実装と検証の境界は末尾に記す。現在の連絡機能と読み取り画面は維持して段階的に追加する。

## 原本と案件の境界

| 情報 | 原本・更新先 | Desklyでの扱い |
|---|---|---|
| Desklyで管理を始める案件、目標、マイルストーン、担当、次の行動、確認日 | 新設するworkspace台帳 | 画面を主入口に共通サービスから更新する |
| 既存連絡の管理欄・下書き・返信要約・6状態・履歴 | 既存のlocal/server連絡台帳 | 既存ID・形式・更新経路を保持し、案件から明示参照する |
| 外部案件の状態・承認・期限、外部作業・工数、メール・チャット・予定 | 元サービス | 読み取りのみ。取得時点と取得状態を表示し、所有する管理項目へコピーしない |
| 設計判断・実装結果・検証証跡 | 元の作業md・成果物 | 安定した参照と必要な短い説明を持つ。本文を複製せず、案件の運用状態と技術的な検収状態を区別する |

案件は「同じ目的・担当範囲・閲覧範囲で運営する単位」。分野やリポジトリの数から自動作成しない。初回は1案件とし、その下に目標・マイルストーン・作業を置く。閲覧範囲が違う資料・商談は同じ案件へ入れず、別案件に分ける。段階的な実装のため、C2では非公開の一部項目だけを同じ案件内で隠す権限を作らない。

既存mdから運用を移す際は項目ごとに、元参照、照合日時、未確認の箇所、運用項目の正本切替を記録する。切替後の次の行動・担当・確認日はDesklyを正本とし、元mdの対応箇所を参照にする。設計・検証結果とその検収は元mdに残す。切替前はmdを正本とし、Deskly側は確認用の表示に限定する。自動同期・全件取り込み・完了状態の推測はしない。

## 個人から共有へ進める単位

| 段階 | 導入するもの | 利用境界 |
|---|---|---|
| C2 個人の初回運用 | Python標準ライブラリ、別SQLite、既存HTML/CSS/JavaScript、既存loopback HTTPの拡張 | 1 workspace・1 member・1案件。既存の単一パスワードを個人用の入口に限って使う。共有公開しない |
| C3 共有開始 | 既存の本人認証基盤との接続、共通管理サービス、全入口の案件権限 | 2人・2案件で受入後に共有。認証製品・接続先・公開経路は対象環境を確認して決める |
| C4 改善 | 日常作業で観測した困りごとの改善 | 営業の詳細機能・通知・集計等は実害を根拠に追加する |

新しいWebフレームワーク、クラウドDB、外部契約はC2の前提にしない。SQLiteはサーバー側の単一の保存先として使い、チーム端末からDBファイルを直接開かせない。クラウド同期フォルダへDBを置かない。共有用の認証基盤が未選定でもC2は進められるが、C3の共有開始条件は満たせない。

## 今後の構想: Google連携と社内ポータル

将来的には、GmailとGoogleカレンダーをDesklyから参照できるよう連携し、案件管理を入口に関連するメール・予定・作業を確認できる社内ポータル的な使い方を目指す。これはC3の初回共有には含めず、C3の認証・案件権限と共有運用が成立した後の別段階で扱う。Google側を各情報の正本として保ち、Desklyは許可された情報の参照を基本とする。具体的な同期範囲、操作権限、Google認証方式、保存・保持方針は導入時に別途設計し、現在のC3の完了条件には含めない。

## ID・関係・最小データ

以下は新設する論理モデル。IDは表示名から作らず、生成したUUIDを固定する。全ての親子参照は同じworkspaceであることを保存時に検査する。時刻はUTC、確認日はworkspaceのタイムゾーンで解釈する日付とする。

| 対象 | 最小の項目・関係 |
|---|---|
| workspace | ID、表示名、timezone。組織・チームの保存と権限の境界。C2は明示的な初期化で1件だけ作る |
| member | ID、workspace ID、表示名、active、role。C2はlocal ownerを1人。C3の本人対応は認証基盤のissuer/subjectと結ぶ。表示名・メール一致で本人を決めない |
| project | ID、workspace ID、名前、目的、owner member ID、状態（未確認・進行中・保留・終了）、version |
| project membership | workspace ID、project ID、member ID、role（editor / viewer）。ownerはworkspace内を管理。所属は閲覧許可を自動付与しない |
| milestone | ID、project ID、目標、受入条件、担当member ID、確認日、状態、version |
| work item | ID、project ID、任意のmilestone ID、kind（開発 / 営業 / 運営）、題名、担当member ID、次の行動、確認日、待ち理由、状態、version |
| reference | ID、project ID、任意のmilestone/work item ID、種別、参照先、照合日時。元md・成果物・連絡・外部案件を明示的に結ぶ |
| event | 操作ID、対象ID、変更前後、UTC日時、member ID、実行経路、実行者、理由。対象更新と同じトランザクションで追加する |

projectのowner member IDは業務上の主担当を示す。担当への指定だけでworkspace roleのownerや全案件の管理権限を付与しない。

マイルストーンとwork itemの状態は「未確認・未着手・進行中・待ち・完了・取りやめ」。待ちは理由と確認日を必須、完了は証跡参照と確認した人を必須とする。マイルストーンの完了は子の件数だけから推定せず受入条件との照合を残す。連絡の6状態とは別の型・検査にする。

営業の最初の単位は「提案を準備する」「返答後の次の行動を決める」等のwork itemとする。商談の受注・失注・金額をwork itemの完了から推定しない。外部にある商談状態は参照表示し、独自の商談台帳・売上予測は初回運用の観測後に必要性を決める。

既存連絡は `(workspace_id, source_id, contact_id)`、外部案件は `(workspace_id, source_id, external_id)` で参照する。`source_id`は接続設定名の変更に影響されない登録済みのIDで、台帳や外部接続への対応を保持する。接続URL、token、DBパスを参照キーにしない。`Contact.project`や外部案件番号は候補照合と表示にだけ使い、同名を自動結合しない。連絡未紐付け・接続未設定・参照先不明は別の状態として残す。

## 保存・共通API・更新

C2の新設台帳は `DESKLY_HOME/workspaces/<workspace-id>.sqlite3`。既存の `ledger/<name>.sqlite3` とスキーマを分け、既存の `SCHEMA_VERSION = 1` や `Contact` を案件用に拡張しない。workspace設定が無い既存環境は従来画面で動き続ける。GETでDBやownerを自動作成せず、初期化操作で保存先とlocal ownerを明示する。

新しい共通管理サービスが、認証済みprincipalの解決、workspace/案件権限、入力検査、version照合、履歴を担当する。C2は同一プロセス内のサービスを画面HTTPから呼び、C3でCLI/MCP・共有APIを同じサービスへ接続する。UIだけの非表示を権限検査にしない。

新規APIの契約（C2の個人用routeと、C3の共有Webでの同じrouteを実装済み。共有Webでは下記の案件権限を毎回検査する）:

- GET `/api/workspaces/<wid>/projects`、`/api/workspaces/<wid>/projects/<pid>`、`/api/workspaces/<wid>/my-work`: 閲覧可能なデータだけ返す。`my-work`のmemberは認証情報から決める。全体件数も権限適用後に計算する。
- POST `/api/workspaces/<wid>/commands/preview`: 操作、対象ID、変更内容、既読versionを受け、差分と対象を返す。保存しない。
- POST `/api/workspaces/<wid>/commands/apply`: 確認済みの同じ操作ID・差分・既読versionで適用する。権限とversionを再検査する。クライアントがmember IDやactorを名乗っても採用しない。
- GET `/api/workspaces/<wid>/projects/<pid>/history`: 同じ案件閲覧権限を必要とする。初回の操作は案件・マイルストーン・work itemの作成/更新、参照追加、アーカイブに限定する。

作成にはクライアント操作IDによる重複防止を付け、同じID/同じ入力の再送は同じ結果、違う入力は拒否する。更新は整数version必須、SQLの条件付き更新と履歴挿入を同一トランザクションに置く。古いversionは409にし、入力を保持して最新との差分を見せ、再確認後にだけ適用する。最後の書き込みを無言で採用しない。古いプレビュー・権限取消後の適用も拒否する。

既存 `store.py` のWAL・busy timeout・`BEGIN IMMEDIATE`・履歴同時保存を参考にする。ただし既存Storeではversion指定が任意で、既存APIのactorは呼び出し側入力なので、そのまま新サービスの本人確認に流用しない。新画面はHost/Origin・セッション・JSON型とサイズ・許可フィールドの検査を更新routeにも適用し、出力は既存のtextContent方針を保つ。

## member・権限・既存入口の境界

| 操作 | owner | project editor | project viewer |
|---|---|---|---|
| 所属と許可案件の閲覧・履歴 | workspace内 | 許可案件 | 許可案件 |
| 目標・行動・担当・確認日の更新 | workspace内 | 許可案件、担当は当該案件のactive memberのみ | 不可 |
| 案件新規作成・member管理・権限付与・接続登録・復旧 | 可 | 不可 | 不可 |
| 別workspaceの参照・更新 | 不可 | 不可 | 不可 |

離脱時はactiveを外し、セッション/利用トークンを無効化する。履歴中のmember IDは削除せず、未完了の担当をownerが引き継ぐ。最後のactive ownerの削除は拒否する。C2では他memberの登録や招待を提供しない。

連絡・外部参照の権限は案件所属だけで拡大しない。C2は本人が設定したsourceから、明示リンクした連絡の最小項目だけを読む。連絡本文の表示・更新は既存の個人向け連絡操作を使い、新3画面には持ち込まない。C3ではsource利用権限と案件権限の両方を満たす参照だけ返す。共有対象へ結ぶ行為はownerが確認し、参照先の権限が保証できなければ表示しない。

C3の対象には一覧・詳細・検索・件数・履歴・export・import・CLI・MCPを含む。現在の全台帳集約やBearerだけのAPIを共有用に直接公開しない。個人用入口は個人環境内に置き、共有データに到達する経路は同じ権限検査を通す。MCPの`apply=true`は適用意思であり、本人認証や案件権限の代わりにはならない。人の依頼者、実行経路（画面/CLI/MCP）、AI等の実行者を履歴上で分ける。

## 最小の3画面

| 画面 | 見るもの | 初回に更新できるもの |
|---|---|---|
| 全体 | workspace、案件ごとに目的・次のマイルストーン・担当・次の行動・確認日・待ち理由・未確認件数 | 案件作成。既存案件の編集は詳細へ進む |
| 案件詳細 | 目標、マイルストーン、開発/営業/運営の作業、関連連絡と資料、変更履歴。取得できない外部情報は理由と取得時点 | 目標、作業、担当、次の行動、確認日、待ち理由、状態、参照。保存前に差分を確認する |
| 自分の仕事 | 自分が担当する未完了作業を、期限超過・確認日・待ちで並べ、案件名を常に添える | 次の行動・待ち理由・確認日・状態。保存後に詳細と全体へ同じ結果を反映する |

3画面は既存のstatic資産に追加し、専用フロントエンド基盤は導入しない。未確認・空・未接続・取得失敗を区別する。ローカルmd参照はファイル名/相対参照とコピー操作を出し、ブラウザーから任意ファイルを読むAPIを作らない。許可したHTTPS資料リンクのみリンク化し、秘密付きURLを受け付けない。

管理項目の「再読込」はDeskly台帳を読み直す。外部情報の「取得」は設定済みadapterへ実際に問い合わせ、source別の取得時点と成否を更新する。画面生成時刻をデータの観測時刻として扱わない。未保存入力があるときは再読込前に確認し、失敗時にゼロ件や完了へ置き換えない。

## 履歴・バックアップ・復旧

更新とeventを同じトランザクションで保存し、通常操作から履歴を編集/削除できなくする。削除の初回実装はアーカイブのみ。復元・アーカイブ解除も新しいeventとして残す。これはアプリの変更記録であり、DBを直接操作できる管理者に対する改ざん不能の証明ではない。

C2ではworkspace全体（ID、membership、source参照、全管理項目、version、event）を同じ読取トランザクションから版付きJSON Linesへ書き出す。既存連絡のexport形式とは別の形式として識別し、既存backupの所有印・ハッシュ・世代保持を使う場合も名前空間を分ける。DBファイルを開いたままコピーしない。接続token・パスワードはバックアップ本文に入れない。

復旧は空の別workspaceファイルへ行い、版・全件数・ID・親子参照・履歴・versionを照合する。不正行なら全体をロールバック。アプリ版・schema版・ハッシュ・作成時刻をmanifestに残す。既存連絡台帳は別のバックアップ単位なので、同時点の控えとは主張しない。切替前に連絡参照を照合し、未解決参照は印を付けて更新を止める。元ファイルと直前の控えを保持し、合成データで復旧を確認してから実データ切替を扱う。

日常運用は作業終了時に控えを作る。schema変更前には必ず控えと復旧先を確保する。控えより後の変更は失われ得るため、復旧画面/手順で最終保存時刻を示す。自動スケジュール、保存先の外部共有、破壊的移行は初回導入へ含めない。

## 実コードによる出発点

| 現在のファイル・シンボル | 確認できた点 | 新設時の扱い |
|---|---|---|
| `model.py: Contact`、`store.py: LedgerStore / SqliteStore` | Contact.projectは文字列。連絡・変更履歴・schema版のみ。更新時刻による競合検査は任意 | 既存台帳は互換維持。新台帳のID・必須versionとは分離 |
| `ledgers.py: LedgerCollection.find_contact`、`views.py: build_waiting_rows / build_case_view` | 同一contact IDの曖昧性は拒否。案件集約/外部案件との結合は文字列 | 新しい画面の結合はworkspace/source/対象IDの明示参照 |
| `dashboard.py: get_dashboard_payload` | 全台帳を集約、本文・IDを除く表示用allowlist、取得失敗の区別 | 新画面用projectionを分け、権限適用後に最小ID・項目を返す |
| `dashboard_server.py: DashboardHTTPServer / do_POST` | 単一パスワードと期限付きsession。POSTはlogin/logoutのみ。Host/Origin検査あり | 個人向け更新routeを追加。共有認証の代用品にしない |
| `api_server.py: _post / _put`、`mcp_server.py: MCP_ACTOR` | 台帳全体のBearer、actorは入力値、MCP actorは固定mcp | 共有境界へ直接流用せず、principalを解決する共通サービスへ接続 |
| `commands.py: backup_rows`、`store.py: export_rows / import_rows` | 所有印付きJSON Lines、同一トランザクションの書出し/取込 | 新台帳の形式と復旧照合を追加する。既存連絡の控えを変更しない |
| `case_service.py: get_case_result`、`issuepost.py: IssuepostClient`、`worklog.py: get_worklog_result` | GETによる外部案件、設定済みCLIによる工数読取 | optional接続のまま保持。新workspaceの原本にしない |
| `static/index.html / app.js / app.css`、`pyproject.toml` | 既存3資産を配布。標準ライブラリ本体、UIはtextContentで描画 | 3画面を同じ資産に追加。依存追加・配布変更を前提にしない |

既存のUIテストは旧画面の読取routeと連絡ID非表示を確認している。C2では別のworkspace画面スクリプトと合成データのサービス・HTTPテストを追加した。連絡本文・token・個人パスを新画面へ返さない契約は継続する。

## C2実装と検証の境界（2026-09-27）

`deskly workspace init --name <表示名> --owner <表示名>` が `DESKLY_HOME/workspaces/<UUID>.sqlite3` と `DESKLY_HOME/workspace.json` を明示作成する。画面のGETは作成しない。既存の単一パスワードのloopback画面へ個人用の「全体」「案件詳細」「自分の仕事」を追加した。案件・マイルストーン・作業・資料参照・source登録をpreviewで確認し、applyで版を再検査して保存する。操作IDの再送は同じ結果を返し、変更とeventは同一トランザクションで記録する。アーカイブ解除もversionと履歴を伴う。

sourceはworkspace内の安定IDで登録し、接続設定名をbindingとして保持する。連絡と外部案件の参照はsource IDと対象IDを明示して結ぶ。取得ボタンは設定済みの連絡台帳またはissuepostを実際に読み、参照した対象だけの最小項目を返す。連絡本文・token・接続パスは返さない。取得成否と試行・成功時刻はworkspace内の観測項目とeventへ記録し、元サービスの内容は複製しない。隔離ブラウザー受入では設定済み実連絡台帳を読み、許可されたsummary項目のみを表示した。issuepostは未設定で未確認。管理項目の再読込は未保存入力を確認し、読込失敗時は入力を保持する。

`deskly workspace backup --dest <新規ファイル>` は版・件数・ハッシュ付きの専用JSON Linesを出力する。`DESKLY_HOME`を空の別フォルダへ切り替えて `deskly workspace restore --source <控え>` を使う。同じworkspace IDの保存先が存在すれば拒否する。合成データの別保存先復旧ではID・親子関係・version・履歴の一致を確認した。既存の連絡台帳の控えではない。

C2の個人運用開始を確認した。42項目を元資料へ照合し、非公開表を作成した。実案件1件の計画mdへ切替時点とDeskly項目の記録を残し、個人workspaceへ初回案件・マイルストーン・H1完了・H2待ちを登録した。workspaceの版付き控えは作成後に件数とハッシュを照合した。

ブラウザー受入は隔離した一時workspaceで実施した。source表示、連絡台帳からの明示リンク取得、履歴更新、アーカイブ解除、未保存入力の再読込キャンセルを確認した。設定済み実連絡台帳の読取りでは許可項目のみ表示し、取得前後の台帳サイズと更新時刻に変化がなかった。issuepostは未設定で未検証。案件から参照した別の公開成果物について、公開中の版と保存済みの配信記録の照合が成功した。これはその時点の公開状態の確認で、以後の変更を検証したものではない。

ブラウザー確認に使った一時フォルダーは、自動レビューが削除を拒否したため残っている。サーバー停止とタブ終了は確認済み。C2はローカル実装・検証、個人運用への切替、commitまで完了した。個人用workspaceは既存の単一パスワードのloopback画面からだけ使い、共有Webへは公開しない。

## C3実装と検証の境界（2026-09-28）

共有権限用のschema v2と`WorkspaceAccess`を追加した。既存のschema v1は`deskly workspace upgrade-access --backup <新規ファイル>`を明示実行した場合だけ、控えを作ってから更新する。2026-09-27時点で、個人の実workspaceにこの操作は実行していない。v1とv2の控えはそれぞれの版で空の別保存先へ復旧できる。

memberは認証基盤のissuerとsubjectの組で解決し、表示名・メール一致や台帳全体のBearerで本人を決めない。ownerがmemberを追加し、案件のeditor/viewerとsourceの利用許可を版付きで付与・取消する。案件一覧・詳細・自分の仕事・履歴・参照取得・preview/applyは共通サービス内で権限を再確認し、古い権限やversionの適用を拒否する。外部参照を共有案件へ結ぶ操作はownerに限る。参加者の無効化では未完了の担当をactive ownerへ移し、変更を履歴へ残す。

共有Webは個人用画面とは別の入口（`python -m deskly.shared_server`）として実装した。認証は外部の認証製品ではなく、共有Web専用の資格情報DB（`deskly/shared_auth.py`）で行う。アカウントごとにscryptでハッシュしたパスフレーズを持ち、issuerは公開originの値、subjectはアカウントごとに生成したUUIDとする。ログインするとSecure・HttpOnly・SameSite=Strictのcookieセッションを発行し、パスフレーズ変更とアカウント無効化で既存セッションは次の要求から無効になる。ログイン失敗は接続元とログイン名の組ごとに回数を制限する。更新要求はHost・Origin・Sec-Fetch-Siteを検査する。案件一覧・詳細・履歴は許可された案件だけを返し、viewerの更新は拒否する。ownerは画面から案件権限の付与・取消と参加者の無効化を行う。最初のownerと追加アカウントは運用者が`python -m deskly.shared_admin`（`bootstrap` / `add-member`）で対話的に作る。手順は`deploy/README.company-web.md`。

共有Webで提供しないもの（実装が無いもの）: 連絡台帳・外部案件のsource登録と取得（共有Webでは参照種別をmdとHTTPSリンクに限り、外部情報は未接続として返す）、共有環境でのCLI/MCP（`deskly/shared_mode.py`が起動を拒否し、共有workspace用のCLI/MCP認証経路は無い）、それに伴う「操作を依頼した人とAI等の実行者」の共有経路での区別、旧Bearer APIと全台帳集約画面の共有への公開。

反映と検証の状況: 共有Webを会社用ホストへ反映し、公開の`/healthz`が200を返すことを確認した。自動テストでは合成データで、アカウント別の本人確認、許可の無い案件の非表示、viewerの更新拒否、パスフレーズ変更と無効化によるセッション失効を確認している。一方、2アカウント・2案件での受入、実際の利用者による画面操作、共有環境の控えからの復旧は未実施。これらを満たすまで実案件のデータを共有Webへ入れない。
