# dots #7 独立レビュー結果

## 対象と結論

- 固定指示: `7453e5c3e3e19d714ebb432754c7069dbfd18431` の README / REVIEW を全文確認。
- 公開基盤差分: `b0c3202b7a691471afdb4eebaef06fb8e7f7929d` → `d498e98c55274d1f9dfc622b95ab46f0e0746384`。
- 最終review対象: `08539a8db37c264e135b9410ecb121389218667d`。連携実装差分は固定指示 → このSHA。
- 初回実装 `d1990179764584130d6f2bec46535ef13e92b52c` で P2 を1件確認。`fbc54a0688fd10f882f68c703aadc275b3842217` の修正をソース・テスト・独立合成再現で検証し、最終 `08539a8` でも再確認した。未解消のfindingなし。
- `08539a8` は所有者が追加したPython test fixtureの1行修正のみ。production source、core/Rust/schema/deployは `fbc54a0` と完全一致することを確認。最終SHAの追加差分・Python全検査・機械scope/CLI probeを再検査した。

これは公開PR差分とLinux上の合成検査についての結論であり、本番・Windows接続の検収ではない。

## Finding と修正確認

### P2 / 解消: Access認証のCLIで許可外の派生操作が成功する

初回実装ではMCPだけに明示allowlistがあり、CLIの `my-work` は許可済み案件・作業のGETから担当別結果を生成できた。`entry show` も作業GETのみから入口を生成でき、案件が空なら `search` / `counts` も禁止APIへ到達せず成功し得た。これは「案件・作業の一覧と詳細だけ」という操作範囲との不一致。許可外案件のデータ漏えいや書込みは確認していない。

修正 `fbc54a0` は `main.rs` のdispatch前に、Access認証を案件・作業の `list` / `detail` とMCPだけへ限定する。新しいコマンドも既定で拒否され、変更入力ファイルを読む前に停止する。Bearer時の既存経路は維持する。

独立したCLI → 合成Access edge → signed-JWT personal Worker → serviceの検査で、許可4操作の成功、許可外11コマンドのHTTPなし拒否、許可外project/itemの同一404、合成fixture snapshot・履歴の不変を確認。実際のCloudflare edgeを用いた検査ではない。

## 確認範囲

- RS256署名、信頼issuer、audience、exp/iat/nbf、service形状 `type=app` / `sub=""` / emailなし、署名済みcommon_nameの完全一致。未署名Client ID、Bearerだけ、未知mapping、不正claimは認証不可。opaque IDの1/256文字境界・大小文字・空白・非UUID値も検査。
- 外側personal、内側Worker/API、serviceの各境界。機械は独立principalのままで、owner/member/accountへ変換しない。本人active owner一人、実在membership、APPS_CONFIG拒否を維持。
- 明示4 GET形状のみ。案件発見は許可IDを個別取得し、client側filterで代替しない。他workspace/project/item、archived親とactive子、archived子、不正adapter返却行を拒否。禁止API、全mutation/preview、history/contact/case/member/account/source、UI/health、queryとorigin異常を確認。
- MCPのtools/listと非広告toolの直接tools/call。CLIのdeny-by-default dispatch、Bearer互換、設定元の競合・partial/empty/null、不正header値、redirect/proxy、認証材料の反射拒否を確認。
- Memory/SQLite/D1契約、生成型・正典schema整合、本人UIの認証・preview・save・history回帰。追加owner検査はmachine scopeを同時設定した状態で実行。
- 基盤は境界に関係するsource、構成・manifest/lock・生成経路・永続化/復旧契約・配備入口と公開説明を重点確認。旧Python/旧Workerを保持。Cargo licenseは既存AGPL-3.0-or-laterを両crateが継承し、LICENSE本文は不変。
- 固定指示以降、schema・生成型・lockfile・CI workflow・secrets-scanは不変。基盤candidateに含まれる既存CI追加と、今回の実装変更を区別した。

## 独立実行の証跡

環境: Node 24.19.0 / pnpm 11.19.0 / Rust・Cargo 1.90.0 / Python 3.12.14。合成データのみ、DESKLY_HOMEは一時領域。Rustはjobs=2、debug=0、incremental無効。

`fbc54a0688fd10f882f68c703aadc275b3842217` で:

- `pnpm --dir core run typecheck`: exit 0。
- `pnpm --dir core run test`: exit 0、402 pass / 0 fail / 0 skip。
- `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`: exit 0。
- `cargo test --manifest-path rust/Cargo.toml --all --locked --offline`: exit 0、92 pass / 0 fail / 0 ignore。
- `cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked --offline -- -D warnings`: exit 0。
- `node --test 'deploy/cloudflare-personal/tests/*.test.cjs'`: exit 0、7 pass。
- reviewer所有の追加合成probe `node --test independent-machine-probes.mjs`: exit 0、11 pass。claim負例、origin/query/path変形、adapter行取り違え、許可IDだけの案件取得、opaque ID境界、鍵取得redirect拒否、machine設定併用時のowner保存・履歴を検査。
- reviewer所有の追加合成probe `node independent-cli-end-to-end.mjs`: exit 0。許可4 read、HTTPなし拒否11 command、scope拒否2 read、snapshot/history不変。
- `git diff --check` および保護対象ファイルの差分確認: exit 0。

依存はfrozen-lockfile・offlineで取得済みcacheから構成。初回のローカルrunner設定（pnpm既定store不存在、build前probe）は失敗したが、ソースや期待値を変えず、独立checkoutで上記最終検査を実行した。

## 所有者のPython fixture修正と最終SHAの再検査

旧 `tests/test_shared_cli.py` の `_setup` は既定modeでhomeを作り、POSIXの通常umaskでは0755となる一方、変更されていない `_resolve_home` はgroup/other権限を拒否する。このPython source/testsは `fbc54a0` まで `b0c3202` と不変だった。

所有者commit `08539a8db37c264e135b9410ecb121389218667d` の唯一の変更は `home.mkdir(mode=0o700, parents=True)`。独立checkoutへ取得し、production側の権限検査・CI/scanner・依存・他sourceが不変であることを確認。合成homeの0700受入・0755拒否も独立に確認した。

最終 `08539a8` で追加実行:

- `python -m pytest -q`: exit 0、327 pass / 1 skip。skipは `tests/test_dashboard_ui.py:352` の `hatchling.build` 未導入による既存packaging検査。skipを追加・拡大していない。
- `python -m ruff check deskly tests`: exit 0。
- `python -m mypy deskly`: exit 0、31 source files。
- `node --test core/tests/machine-read-access.test.mjs` とreviewerの `independent-machine-probes.mjs`: exit 0、計24 pass / 0 fail / 0 skip。
- `node independent-cli-end-to-end.mjs`: exit 0。許可4 read、HTTPなし拒否11 command、scope拒否2 read、snapshot/history不変を再確認。
- `git diff --exit-code fbc54a0 08539a8 -- core rust schema deploy deskly .github scripts LICENSE` と `git diff --check`: exit 0。

## GitHub CIの独立読戻し

最終 `08539a8` に関連付いた [CI run 37115293262](https://github.com/ishizakahiroshi/deskly/actions/runs/37115293262) と [secrets-scan run 37115293244](https://github.com/ishizakahiroshi/deskly/actions/runs/37115293244) をread-only APIで確認。Python・core・Rust・旧Worker・scanの5 jobsはsuccess。coreのtypecheck/test、Rustのfmt/clippy/test、Pythonのpytest/ruff/mypyが実際に実行されており、検出条件によるjob省略ではない。`Skip notice` stepがskipされたことと、検査自体の省略を混同していない。

scanはCI上の構造検査のみで、手元KB/family台帳込み検査ではない。CI成功と独立ローカル検査・本番検収はそれぞれ別の証跡。

## 未検証・引継ぎ

ライブAccess claim、Cloudflareでの実認証・失効、Windows AI/MCP、本人の実ブラウザ、本番配備・復元、秘密発行/権限設定は未実施。ローカルでskipされたpackaging検査と、手元KB/family台帳込み秘密検査は未検証。merge・deploy・releaseは実施していない。
