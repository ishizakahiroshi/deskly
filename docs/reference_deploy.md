# deskly をサーバーへ置く・配る・戻す

deskly を 1 台の Linux サーバーに、同じ機械のほかのアプリと分けて置くための手順。Docker と Docker Compose（v2.24 以上）がある前提。

## 置き場

| パス | 中身 |
|---|---|
| `/opt/deskly/app/compose.yaml` | compose（配るたびに置き直す。正本はリポジトリの `deploy/compose.yaml`） |
| `/opt/deskly/app/install-release.sh` | 反映のスクリプト（同じく配るたびに置き直す。正本は `deploy/install-release.sh`） |
| `/opt/deskly/app/.env` | 秘密の値（API のトークンなど）。`root:root 600`。無くても起動する |
| `/opt/deskly/release/current/` | 今の版（`Dockerfile`・`RELEASE`・（あれば）`dist/*.whl`） |
| `/opt/deskly/backup/release.prev/` | 直前の版 |
| `/opt/deskly/backup/release.failed/` | `healthz` を返さずに戻した版（調べるために残す） |

compose のプロジェクト名は `deskly` で固定している。コンテナは `deskly-app-1`、網は `deskly_default`、台帳のボリュームは `deskly_data` になる。

## 外には出さない

deskly は `127.0.0.1:8765` だけで待ち受ける。手元からは SSH のポート転送で読む。

```
ssh -N -L 18765:127.0.0.1:8765 <user>@<server>
curl http://127.0.0.1:18765/healthz
```

メモリは compose の `mem_limit`（256MB）を上限にする。同じ機械のほかのアプリ（とくにデータベース）を押し出さないため。

## release

release は次を固めた tar.gz。

- `Dockerfile`（リポジトリの `deploy/Dockerfile`）
- `RELEASE`（1 行の JSON。`revision` が必須。例: `{"app":"deskly","revision":"abc1234","built_at":"...","source":"..."}`）
- `dist/*.whl`（deskly の wheel。仮の中身のときは無い）

改行は LF にする（リポジトリの `.gitattributes` で `deploy/**` と `*.sh` を LF に固定している）。

## 配る

release を固めてサーバーの `/tmp` へ送り、root で次を流す。

```
install -d -m 755 /opt/deskly /opt/deskly/app /opt/deskly/release /opt/deskly/backup
install -m 644 compose.yaml /opt/deskly/app/compose.yaml
install -m 755 install-release.sh /opt/deskly/app/install-release.sh
/opt/deskly/app/install-release.sh /tmp/deskly-release.tar.gz
```

`install-release.sh` は、展開 → 今の版を `release.prev` へ退避して置き換え → build と起動 → `healthz` が新しい `revision` を返すまで最大 60 秒待つ。**起動しただけでは成功にしない。**

新しい版が `healthz` を返さなければ、自動で前の版へ戻し、終了コード 1 で終わる。失敗した版は `release.failed` に残る。**自動で戻したあとは `release.prev` が空になる**（前の版を今の版へ戻すのに使うため）。そこからもう一段戻したいときは、戻したい版をもう一度配る。

## 戻す・今の版を見る

```
/opt/deskly/app/install-release.sh rollback   # 直前の版へ戻す（もう一度流すと、戻す前の版へ戻る）
/opt/deskly/app/install-release.sh status     # 今の版・直前の版・healthz
```

## 配ったあとに確かめること

- `/opt/deskly/app/install-release.sh status` の `healthz` が、配った `revision` を返している
- `ss -ltn` で 8765 番が `127.0.0.1` だけで待ち受けている
- 同じ機械のほかのアプリが、配る前と同じに動いている（それぞれの死活確認の手段で）
- 空きメモリの減りが `mem_limit` の内に収まっている

## 作者の環境では

手元の PC から、リポジトリの外に置いたスクリプト（接続情報を実行のたびに作者の秘密の置き場から引く）で、固める・送る・反映するまでを 1 回で行っている。接続先に依存するため、このリポジトリには入れていない（`scripts/local/` は追跡しない）。
