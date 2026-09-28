# 個人用 Deskly: Cloudflare Workers + D1

個人の開発案件をリポジトリの公開・非公開を問わず管理する独立インスタンスです。既存の個人サイトは Cloudflare Workers の静的 assets 配信で、別の Worker をサブドメインへ割り当てられます。会社用 Deskly の VPS、認証、SQLite、控えには接続しません。ここに実際の案件データや認証値を書かないでください。

## 実装範囲

Access で保護された 1 人用の画面と API です。案件名・目的・リポジトリ URL・個人/兼用区分、各案件のマイルストーンと次の行動・状態・確認日を D1 に保存します。次の行動は同じ案件のマイルストーンに紐付けられます。変更は D1 trigger で履歴へ記録し、更新は `expected_version` が一致した場合だけ通します。JSON 控えは `/api/export` から手動保存できます。会社案件の情報や連絡台帳を自動で読み込む機能はありません。

既存 Python/SQLite workspace の完全移植ではありません。外部 source、連絡集約、担当・共有権限、CLI/MCP はこの Worker の API にありません。C2 の実データを移す際は、項目の対応と読み取り専用の控えを確認したうえで別の移行手順が必要です。現時点で既存 workspace の正本を D1 へ切り替えません。

## Cloudflare の準備

1. 個人アカウントで Worker 用の D1 を作成し、D1 の ID を取得します。会社の D1 やデータを使わないでください。
2. `wrangler.toml.example` を Git 追跡外の `wrangler.toml` へコピーし、`database_id`、`PUBLIC_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL` を設定します。`PUBLIC_ORIGIN` は専用サブドメインの HTTPS origin です。`OWNER_EMAIL` は Access にログインする本人のメールです。`.gitignore` がローカル設定を除外します。
3. Cloudflare Access の self-hosted application をそのサブドメイン全体に作り、下記のどちらかの方法で本人だけを許可します。Workers 側の Access 保護も有効にし、プレビューを含め公開経路を塞ぎます。Worker はリクエストごとに `Cf-Access-Jwt-Assertion` の署名・issuer・audience・期限・本人メールを再検証します。
4. `wrangler d1 migrations apply deskly-personal --local` でローカル台帳を作れます。`wrangler dev` の標準 URL は HTTP の localhost なので、公開 origin に固定した現行 Worker はそのままでは画面を返しません。ローカル認証の合成確認方法は別途整備します。実画面の受入は Access と HTTPS の専用サブドメインを設定したあとに行います。
5. 実機反映時は実際の D1 に migration `0001`・`0002` を適用してから Worker を反映します。D1 Time Travel の復旧可能期間と控えを確認し、実データを登録する前に別 D1 で復旧手順を確かめます。反映先ごとに migration の状態と Worker の binding を確認してください。

`workers_dev = false` と `preview_urls = false` は別 URL からのアクセスを減らすためです。DNS とカスタムドメインの割り当ては Cloudflare 側で行います。現行の個人サイト本体の `site/wrangler.toml` は変更しません。

`assets.html_handling = "none"` は必須です。Worker が `/` を `/index.html` に読み替えるため、既定の HTML 正規化で `/index.html` を `/` に戻すと転送ループになります。

### Access の接続元 IP 制限を選ぶ

Access の本人確認と接続元 IP 制限は別の条件です。どちらの構成でも本人のメールアドレスだけを許可し、Worker 側でも `OWNER_EMAIL` を検査します。接続元 IP を制限するかどうかは配備ごとに選びます。Deskly の画面に選択スイッチはありません。Cloudflare Zero Trust の Access ポリシーで設定します。

| 構成 | Access の Allow ポリシー | 使いどころ |
|---|---|---|
| IP 制限なし（通常はこちら） | `Include: Emails = <本人のメール>`。IP 条件は付けない | 外出先や回線を変えても、本人が認証すれば利用できる |
| IP 制限あり | `Include: IP ranges = <許可する固定グローバル IP>` と `Require: Emails = <本人のメール>` | 接続元が固定されており、その回線からだけ使いたい |

`Include` に複数の IP を入れると、そのいずれかに一致する接続元が対象になります。IP 制限ありの構成では、許可外の回線からは本人でも Access の 403 で遮断されます。家庭の回線や IPv6 のアドレスが変わると、同じ端末でも使えなくなるため、固定 IP を確認できない場合は IP 制限なしを選びます。IP 制限を後から外す場合も、`Include` を本人の `Emails` に置き換え、本人の条件が残っていることを保存前に確認します。`Everyone` や `Bypass` を本人専用の許可に使わないでください。

既存のポリシーを編集する前に、そのポリシーを使用しているアプリを確認します。複数アプリで共有されている場合は、その場で変更せず、Deskly 専用ポリシーを作って割り当てます。設定後は未ログインの画面と API が遮断され、本人のログイン後に画面と API が使えることを実際の URL で確認します。`Include` と `Require` の評価方法は [Cloudflare Access の公式説明](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) に従います。

## 控えと復元

Cloudflare 標準の `wrangler d1 export deskly-personal --remote --output=<非公開の保存先>.sql` が、スキーマ・データを含む主な控えです。Cloudflare 公式の [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) に従い、新しい D1 へ SQL を読み戻します。稼働中の D1 へ重ねて読み込まないでください。Time Travel は提供期間内だけ使える補助の復旧手段です。

データ入りの SQL 控えでは、`work_items` の挿入が参照先 `milestones` の作成より先になり、復元に失敗する場合があります。元の控えを残したコピーで、全テーブルの作成を先にし、データを `projects` → `milestones` → `work_items` → `events` の順に配置します。履歴 trigger はデータの後に作成し、SQL 文の追加・削除をせず順序だけを変えてください。別 D1 への復元後に全行・スキーマ・外部キーを照合します。`PRAGMA defer_foreign_keys` の指定だけでは、参照先の未作成を解決できません。[Cloudflare の関連報告](https://github.com/cloudflare/workers-sdk/issues/5683)

`wrangler d1 export` は控えを取得できる期限付き URL を出力するため、実行ログをそのまま共有しないでください。ブラウザの組織ポリシーで JSON のダウンロードが禁止されている場合、画面からの保存は未確認として扱い、管理ポリシーを変更して回避しないでください。

画面の JSON 控えを戻す場合は、`node restore-json.mjs <控え.json> <リポ外の出力.sql>` で復元 SQL を作ります。この道具は JSON の形式・各 ID・所属案件・入力値を検査し、出力ファイルの上書きとリポジトリ内への保存を拒否します。新しい空の D1 に migration を先に適用し、`wrangler d1 execute <新しいDB名> --remote --file=<出力.sql>` で読み込みます。生成 SQL は最初に全テーブルの自己重複チェックを行い、既存行があれば一意制約エラーで復元データの挿入や履歴削除より前に停止します。復元後に projects、milestones、work_items、events の件数と代表案件の内容・履歴を控えと照合してください。生成 SQL には実データが入るため、私用領域で保管し、不要になったら安全に片付けます。SQL 生成・実 D1 復元は未実行です。

どちらの復旧方法も個人 Cloudflare アカウントの新しい D1 に限定します。専用 Worker の D1 binding `DB` がその新しい database ID を指すことを確認してから切り替えます。会社の D1・VPS 台帳には結び付けません。

## 公開前の確認

保存後のフォーム処理、変更履歴表示、JSON復元の回帰試験は、リポジトリのルートから `node --test deploy/cloudflare-personal/tests/app-submit.test.cjs deploy/cloudflare-personal/tests/history-ui.test.cjs deploy/cloudflare-personal/tests/restore-json.test.cjs` で実行できます。画面操作と実 D1 の受入は別途必要です。

- Access が未認証の画面・API を遮断すること
- 所有者以外、誤った issuer/audience、期限切れ JWT が 401 となること
- 同時更新で 409、変更履歴に actor と前後の値が残ること
- 案件・行動・履歴の JSON 控えが取得でき、別の D1 で復元できること
- 個人サイト本体の表示に影響がないこと

## 設計根拠

- Cloudflare Workers の [Static Assets](https://developers.cloudflare.com/workers/static-assets/) と [Worker-first routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- Cloudflare Access の [JWT 検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) と [Workers 上の Access 制約](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- Cloudflare D1 の [binding API](https://developers.cloudflare.com/d1/worker-api/) と [migration](https://developers.cloudflare.com/d1/reference/migrations/)
