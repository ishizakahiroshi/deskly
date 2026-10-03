# #7 認証・返却契約（C1）

2026-10-03。固定指示7453e5cと公開候補d498e98を対象とする。C2実装前の契約。実環境の認証・配備検収ではない。

## 基盤と本人境界

開発本線とPR baseはdevelop。旧Python実装・配置は保持し、新版core（TypeScriptサービス/API/UI、SQLite/D1）、rust（CLI/MCP）、schema、deploy/cloudflare-nextを公開候補として統合する。正典schema・生成型・永続化・状態語彙を変更しない。CI/scannerは変更しない。

本人は従来どおり署名済みAccess JWTのsub/emailに対応したactive owner一人。実在membershipの検査と保存・preview・履歴の契約を維持する。機械にmember_id、owner role、account_subjectを生成しない。APPS_CONFIGは機械scopeに流用せず、personal配備では引き続き拒否する。

## 機械認証

- Cloudflare AccessのService AuthポリシーとCF-Access-Client-Id / CF-Access-Client-Secretを用いる。Workerが信用するのはCf-Access-Jwt-Assertion内の署名済みclaimだけ。Client IDヘッダー、Bearer、Cookieだけで機械を認証しない。
- 公式application token仕様のservice形状はtype=app、common_name=サービスのClient ID、sub=""。emailのある本人tokenを機械tokenの代用にしない。共通のRS256署名、信頼issuer、audience、exp/iat/nbf検査後に対応付ける。
- 任意のACCESS_MACHINE_READ_SCOPES bindingをJSON配列として明示設定する。各要素はclient_id、workspace_id、project_idsだけ。workspace_idとproject_idsの各要素だけが既存UUID形式。client_id/common_nameはAccess発行のopaque値（1〜256の可視ASCII文字、空白・制御文字なし）で、UUIDや旧64桁hex形式に限定しない。case変換・trimをせず完全一致で照合する。project_idsは空でない一意な配列。同じclient_idを重複させない。不正/空文字設定は閉じる。未設定または空配列は機械権限なし。mapping削除は次の要求から失効する。
- 独立したmachine-read主体はservice_id、workspace_id、project_idsのみを持つ。外側personalと内側Worker/APIがそれぞれJWTを検証し、サービス層はworkspace/project/itemの範囲を再確認する。署名鍵取得は信頼issuerのcertsだけ、redirectは追わない。

## 許可するAPIと返却

GETの次の4形状だけを許可し、それ以外のmethod/path/queryは拒否する。

- /api/v1/workspaces/{workspace}/projects
- /api/v1/workspaces/{workspace}/projects/{project}
- /api/v1/workspaces/{workspace}/projects/{project}/work-items
- /api/v1/workspaces/{workspace}/projects/{project}/work-items/{item}

Project/WorkItem管理項目の既存型を維持し、担当は安定IDのまま。案件一覧は設定された案件だけをサーバー側で取得・返却し、archived_projectsは空。アーカイブ済み案件と作業は除外する。許可外と不存在のworkspace/project/itemは同じnot_found。機械サービスはmembership/account/contact/case/history/sourceへアクセスせず、書込み/preview・milestones・担当検索・集計・UI・healthは拒否する。データ本文からコマンド実行しない。

## CLI / MCP

既存Bearer設定を維持し、Access設定は明示JSON configのaccess_client_id / access_client_secret、または専用DESKLY_ACCESS_CLIENT_ID / DESKLY_ACCESS_CLIENT_SECRET。argvオプションを作らない。両方式同時、片側だけ、空値、不正header値を拒否し、暗黙fallbackしない。Access環境変数を一つでも指定したら環境変数の完全なペアが必要で、configと混ぜて補完しない。Bearerが別の設定源に残っていてもAccessとの競合として拒否する。

HTTPはredirect禁止、proxy無効、静的error、応答内のClient ID/Secret/Bearer反射拒否を維持する。MCPの `mcp --read-only` 起動ではdeskly_projects / deskly_itemsのみ広告・実行可。Access認証時はこのmodeを自動強制する。広告外toolへの直接tools/callも拒否する。CLIもAccess認証ではprojects/itemsのlist/detailとMCPだけを許可し、my-work/entry/search/counts等の派生読取も通信・ローカル処理前に拒否する。最終的なデータ権限境界はサーバーが持つ。

## 検収境界

合成署名JWTとfixtureで成功・負例・owner回帰を検査する。ライブclaim、Access側の失効、Windows AI/MCP、本人ブラウザ、個人用配備/復元は手元確認待ち。新しい秘密・ポリシー・権限・schema migrationをこの作業で作らない。

公式根拠（2026-10-03確認）:
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
