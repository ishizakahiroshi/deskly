# 個人用 Deskly: Cloudflare Workers + D1

個人の開発案件をリポジトリの公開・非公開を問わず管理する独立インスタンスです。既存の個人サイトは Cloudflare Workers の静的 assets 配信で、別の Worker をサブドメインへ割り当てられます。会社用 Deskly の VPS、認証、SQLite、控えには接続しません。ここに実際の案件データや認証値を書かないでください。

## 実装範囲

Access で保護された 1 人用の画面と API です。案件名・目的・リポジトリ URL・個人/兼用区分、各案件のマイルストーンと次の行動・状態・確認日を D1 に保存します。次の行動は同じ案件のマイルストーンに紐付けられます。変更は D1 trigger で履歴へ記録し、更新は `expected_version` が一致した場合だけ通します。JSON 控えは `/api/export` から手動保存できます。会社案件の情報や連絡台帳を自動で読み込む機能はありません。

既存 Python/SQLite workspace の完全移植ではありません。外部 source、連絡集約、担当・共有権限、CLI/MCP はこの Worker の API にありません。C2 の実データを移す際は、項目の対応と読み取り専用の控えを確認したうえで別の移行手順が必要です。現時点で既存 workspace の正本を D1 へ切り替えません。

## Cloudflare の準備

1. 個人アカウントで Worker 用の D1 を作成し、D1 の ID を取得します。会社の D1 やデータを使わないでください。
2. `wrangler.toml.example` を Git 追跡外の `wrangler.toml` へコピーし、`database_id`、`PUBLIC_ORIGIN`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL` を設定します。`PUBLIC_ORIGIN` は専用サブドメインの HTTPS origin です。`OWNER_EMAIL` は Access にログインする本人のメールです。`.gitignore` がローカル設定を除外します。
3. Cloudflare Access の self-hosted application をそのサブドメイン全体に作り、本人だけを許可します。Workers 側の Access 保護も有効にし、プレビューを含め公開経路を塞ぎます。Worker はリクエストごとに `Cf-Access-Jwt-Assertion` の署名・issuer・audience・期限・本人メールを再検証します。
4. `wrangler d1 migrations apply deskly-personal --local` でローカル台帳を作れます。`wrangler dev` の標準 URL は HTTP の localhost なので、公開 origin に固定した現行 Worker はそのままでは画面を返しません。ローカル認証の合成確認方法は別途整備します。実画面の受入は Access と HTTPS の専用サブドメインを設定したあとに行います。
5. 実機反映時は実際の D1 に migration `0001`・`0002` を適用してから Worker を反映します。D1 Time Travel の復旧可能期間と控えを確認し、実データを登録する前に別 D1 で復旧手順を確かめます。実機の migration・公開はこの文書作成時には行っていません。

`workers_dev = false` と `preview_urls = false` は別 URL からのアクセスを減らすためです。DNS とカスタムドメインの割り当ては Cloudflare 側で行います。現行の個人サイト本体の `site/wrangler.toml` は変更しません。

## 控えと復元

Cloudflare 標準の `wrangler d1 export deskly-personal --remote --output=<非公開の保存先>.sql` が、スキーマ・データを含む主な控えです。Cloudflare 公式の [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) に従い、新しい D1 へ SQL を読み戻します。稼働中の D1 へ重ねて読み込まないでください。Time Travel は提供期間内だけ使える補助の復旧手段です。

画面の JSON 控えを戻す場合は、`node restore-json.mjs <控え.json> <リポ外の出力.sql>` で復元 SQL を作ります。この道具は JSON の形式・各 ID・所属案件・入力値を検査し、出力ファイルの上書きとリポジトリ内への保存を拒否します。新しい空の D1 に migration を先に適用し、`wrangler d1 execute <新しいDB名> --remote --file=<出力.sql>` で読み込みます。復元後に projects、milestones、work_items、events の件数と代表案件の内容・履歴を控えと照合してください。生成 SQL には実データが入るため、私用領域で保管し、不要になったら安全に片付けます。SQL 生成・実 D1 復元は未実行です。

どちらの復旧方法も個人 Cloudflare アカウントの新しい D1 に限定します。専用 Worker の D1 binding `DB` がその新しい database ID を指すことを確認してから切り替えます。会社の D1・VPS 台帳には結び付けません。

## 公開前の確認

- Access が未認証の画面・API を遮断すること
- 所有者以外、誤った issuer/audience、期限切れ JWT が 401 となること
- 同時更新で 409、変更履歴に actor と前後の値が残ること
- 案件・行動・履歴の JSON 控えが取得でき、別の D1 で復元できること
- 個人サイト本体の表示に影響がないこと

## 設計根拠

- Cloudflare Workers の [Static Assets](https://developers.cloudflare.com/workers/static-assets/) と [Worker-first routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- Cloudflare Access の [JWT 検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) と [Workers 上の Access 制約](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- Cloudflare D1 の [binding API](https://developers.cloudflare.com/d1/worker-api/) と [migration](https://developers.cloudflare.com/d1/reference/migrations/)
