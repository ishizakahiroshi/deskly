# 個人用の新版を Cloudflare で動かす

旧 `deploy/cloudflare-personal` の稼働先・D1を残し、新版は別 Worker・別 D1・別の専用 HTTPS ホストで検証します。会社のデータ・VPS・認証には接続しません。実際の接続値、本人メール、Access subject、SQL控えは追跡対象へ保存しません。

## ビルドと設定

リポジトリルートで `pnpm --dir core run build` を実行します。`wrangler.toml.example` の main は生成された個人用入口を参照します。UIは同じビルドからWorker内へ埋め込まれ、ASSETS binding は不要です。

設定を追跡外の私用ファイルにコピーし、専用 Worker・新しい D1・専用ホストの PUBLIC_ORIGIN・Access issuer/audience・レビュー済みソースの REVISION を設定します。既存の個人サイトの Worker 設定には触りません。workers.dev と preview URL は無効のままにします。検証ホスト全体へ Access の本人メールだけを許可するポリシーを先に設定し、Everyone や Bypass は使いません。既存ポリシーを変更する前に他アプリとの共有を確認します。

`ACCESS_IDENTITIES`、`CONFIRMATION_SECRET`、`CASE_SETTINGS` はsecret bindingへ設定します。ACCESS_IDENTITIES は配列で、本人の Access subject/email と Principal の workspace_id/member_id/account_subject/role/active を結びます。ちょうど1人のactive ownerだけを許します。3つのIDは安定したUUIDとして初期D1の行と一致させます。CONFIRMATION_SECRET は32 UTF-8 bytes以上のランダム値で、再配備でも同じ値を保ちます。CASE_SETTINGS は `core/config/case-settings.example.toml` を基にし、個人用は member_access.enabled=false を維持できます。本人以外を招かなくても所有者は受付を操作できます。この個人入口はAPPS_CONFIGを拒否し、外部送信アプリのBearerキーでは利用できません。

## 新D1の準備

ビルド後 `node deploy/cloudflare-next/scripts/export-schema.mjs <新規SQL出力先>` で正典migrationとchecksumをSQLへ生成します。既存出力を上書きしません。新しい空D1へ管理者が明示的に適用します。途中のSQLエラー時は使い続けず、新しい空D1でやり直します。旧D1には適用しません。生成はネットワーク接続せず、WorkerのHTTP要求でもmigrationは実行しません。

schemaだけでは使えません。初期 workspace（schema_version=3）、account、workspace owner membership を管理者が用意します。旧データの変換と初期IDの対応は移行道具の検査結果に従います。旧4表をそのまま新版schemaへ重ねて読み込まないでください。

## 検証と切り替え

個人入口はUI・JS/CSS・API・health全経路で Access JWT の署名・issuer・audience・期限・本人subject/emailを検査します。別originを拒否し、認証や設定の問題では閉じます。本人の GET /healthz は `{ "revision": "..." }` のみを返し、HEADは本文なしです。これはソース版の確認であり、DB復旧や全機能の成功を証明しません。

配備後に未認証の画面/API/health遮断、本人の画面と受付保存・再読込・更新・履歴、別本人拒否、409、health revision、D1 bindingを確認します。静的テストは `node --test core/tests/cloudflare-personal.test.mjs` です。実際の画面・Access・D1検証は別途行います。

Access の証明鍵取得は `redirect: "manual"` を使い、成功応答だけを受け付けます。Workers の実行環境では `redirect: "error"` が例外になるため使用しません。転送は追跡せず拒否します。鍵取得を差し替えた静的試験だけでなく、Cloudflare の実行環境でも確認してください。

既存の別Workerが使う本番Custom Domainへ切り替えるときは、対象ホストと現在のserviceを読み戻してから、新Workerの私用Wrangler設定に `custom_domain = true` のrouteを明示して配備します。一般のdomains PUTだけでは既存割り当てとの競合で409になる場合があります。保持する検証ホストも設定に明示します。本番originへ切り替えたWorkerは検証originを拒否するため、利用するURLは本番へ統一します。管理APIのOAuth期限が切れた場合はWranglerで認証を更新してから読み戻しをやり直します。

旧D1のSQL控えと旧Worker版を私用領域へ保存し、新D1への移行・照合・復元試験が成功してから個人本番ホストを切り替えます。旧版へ戻す場合は旧Workerと旧D1の組に戻します。切り替え後に新版へ書いた行を旧版へ自動で戻す機能はありません。戻す前に書き込みを止め、新版のSQL控えも取得して差分を保全します。D1 export の取得URLやデータを含むログは共有しません。

## ローカルAIの最小読取scope

本人owner一人の設定は維持したまま、独立した機械主体を追加できます。本人email/subを空にしたり、機械をACCESS_IDENTITIESへ追加しないでください。管理者はAccessのService Authポリシーを設定し、発行済みService TokenのClient IDを `ACCESS_MACHINE_READ_SCOPES` にworkspace/project IDと明示対応付けます。BypassやEveryoneは使用しません。設定の形とCLI手順は [読取設定](../../docs/reference_local-agent-read-access.md) を参照してください。

WorkerはClient IDヘッダーではなく署名検証済みJWTの `common_name` を照合します。公式のservice token形状（type=app、sub空文字）を使い、外側personal・内側API・service認可の各段階で制限します。実環境のclaimを手元で確認するまでは接続検収完了としません。機械はUI/health、本人情報、previewを含む変更、履歴、連絡・受付・外部sourceへアクセスできません。

`ACCESS_MACHINE_READ_SCOPES` 未設定/空配列は機械権限なし。不正JSON・不正ID・部分設定は503で閉じます。mapping削除は次の要求から有効で、既存JWTでも該当scopeを使えません。Access側Service Tokenの無効化後、発行済みJWTがいつ失効するかはJWT期限やAccess動作も含めて実機確認してください。ローカルテストだけで即時のAccess側失効を保証しません。
