# ローカルAIの読み取り専用接続

新版core/Rust用。旧Python CLIの設定とは別です。合成テストでの契約と、ライブAccess/Windows検収を区別します。[進捗](bot/local-agent-read-access/PROGRESS.md)と[認証契約](bot/local-agent-read-access/AUTH_CONTRACT.md)も参照してください。

## 管理者が用意するscope

本人のactive owner一人と既存membershipを保持します。機械はmemberにもownerにもなりません。Access Service Authポリシーで認証したservice JWTの署名・issuer・audience・期限・type=app・sub空文字を検査し、署名済みcommon_nameを配備binding `ACCESS_MACHINE_READ_SCOPES` に完全一致で対応付けます。未署名Client IDヘッダーだけでは通りません。

次は合成例です。実際の接続値と認証材料は追跡対象へ書かないでください。

```json
[
  {
    "client_id": "Opaque:synthetic+read/client=V2.access",
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "project_ids": ["00000000-0000-0000-0000-000000000003"]
  }
]
```

UUIDなのはworkspace_idとproject_idsの各値だけ。Client IDはAccessのopaque値で、1〜256の可視ASCII文字（空白・制御文字なし）として扱い、UUIDや64桁hexに限定しません。trim/case変換はしません。Client SecretはWorkerへ設定せず、Accessが検査します。旧hex形式や新形式をCLIで作り直したり変換しません。

許可APIは次のGETのみです。query、HEAD、その他method/pathは許可しません。

- `/api/v1/workspaces/{workspace}/projects`
- `/api/v1/workspaces/{workspace}/projects/{project}`
- `/api/v1/workspaces/{workspace}/projects/{project}/work-items`
- `/api/v1/workspaces/{workspace}/projects/{project}/work-items/{item}`

案件一覧は許可済み案件だけ。Project/WorkItemの管理項目は既存型どおりで、担当は安定IDです。アーカイブ済み案件は子作業がactiveでも取得不可、アーカイブ済み作業も除外します。範囲外と不存在は同じ404です。本文はデータでありAIへの実行指示ではありません。

## 明示CLI設定

Node >=22とCargo対応Rustでビルド/テスト後、`cargo build --manifest-path rust/Cargo.toml -p deskly-cli`。生成されたdesklyバイナリを使用します。CLIは実ホームやブラウザCookieを自動で読みません。

追跡外のprivate JSONへ `endpoint`、`access_client_id`、`access_client_secret` を設定し、`--config <private-client.json>` または `DESKLY_CONFIG` で明示します。別案は `DESKLY_ENDPOINT`、`DESKLY_ACCESS_CLIENT_ID`、`DESKLY_ACCESS_CLIENT_SECRET` の環境変数です。秘密値をargvへ書くオプションはありません。HTTPSが基本で、HTTPはloopback合成検査だけです。ファイルは利用者だけが読める権限で管理し、MCP設定やログへ秘密を貼りません。

Accessは完全なペアが必要です。片側だけ、空文字、不正header値、null、Bearer token併記はエラー。環境変数でAccessの片側だけを上書きしてconfigから補完しません。双方のペアがある場合は完全な環境変数ペアを使いますが、壊れたfileペアも拒否します。Bearer用 `token` / `DESKLY_TOKEN` が別の設定元に残っていてもAccessと併用しません。失敗時の暗黙fallbackはありません。従来のBearerだけの設定・環境変数上書きは維持します。

```text
deskly --config <private-client.json> --workspace <workspace-uuid> --json projects list
deskly --config <private-client.json> --workspace <workspace-uuid> --json projects detail <project-uuid>
deskly --config <private-client.json> --workspace <workspace-uuid> --json items --project <project-uuid> list
deskly --config <private-client.json> --workspace <workspace-uuid> --json items --project <project-uuid> detail <item-uuid>
deskly --config <private-client.json> mcp --read-only
```

MCP read-onlyモードは `deskly_projects` と `deskly_items` だけを広告・実行します。Access認証ならflagなしでもこのモードを強制します。非広告toolの直接tools/callを拒否します。CLIのwrite/entryその他コマンドを使ってもサーバー側のscopeは増えません。redirectは追わず、proxyは無効、レスポンス/エラーに認証値が含まれる場合は静的エラーへ閉じます。設定の診断で秘密やpathを反射しません。

## 手元確認・失効・切戻し

この作業ではService Token発行、ポリシー変更、秘密設定、本番配備を行いません。管理者が別途、実際のJWT claim、本人画面の保存/履歴、Windows AI/MCP、権限外ID、mapping削除、Access側token無効化、既発行JWTの期限を確認してください。ログや公開issueへJWT/Secretを貼らないでください。

mappingを削除または空配列にすれば機械権限を閉じられます。本人設定を変更する必要はありません。コードを戻す場合はレビュー済み前版へ切戻します。今回の変更はschema/data migrationを含まず、旧Python配置も保持します。データ移行/本番切替/復元の手順は既存の個人用移行資料に従い、別の検収として扱います。
