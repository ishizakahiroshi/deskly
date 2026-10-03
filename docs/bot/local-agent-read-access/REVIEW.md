---
type: reference
status: draft
tags: [deskly, review]
owner: ishizakahiroshi
review_status: draft
related: [README.md, PROGRESS.md]
last_reviewed: 2026-10-03
---

# dots #7 独立レビュー

実装担当とは別のreviewerがREADMEの契約と実差分を確認する。2026-10-03に外部担当向け指示として用意した。

基盤差分はdevelop基準 `b0c3202b7a691471afdb4eebaef06fb8e7f7929d` → 新版候補oracle `d498e98c55274d1f9dfc622b95ab46f0e0746384`。連携実装は初回指示公開commit → 最新code SHA。両方を区別して対象にする。

必須確認:

- 本人owner境界、外側personalと内側APIの認証、実際のservice認可まで通して読む。機械資格情報がownerや偽memberへ変換されない。
- JWT署名/issuer/audience/期限/サービス主体と設定scopeを照合し、新しい機械読取経路ではClient IDだけ・Bearerだけ・不明なJWTで通らない。既存の対応アダプターでのBearer利用は維持する。
- project/itemsの明示範囲だけ読める。他workspace/project/item、archived、history/contact/case/membership/account、preview含む変更が拒否される。
- 全件取得後のクライアント絞込で権限を代替しない。存在を漏らすレスポンス差を作らない。
- MCP tools/listと直接tools/call、CLI別コマンド、API直呼びの全経路を検査する。
- 秘密の反射、redirect転送、proxy、自動設定読込、資格情報方式の競合・fallback、失効と設定不備を検査する。
- 既存Project/WorkItem型・旧Bearer利用・本人UI保存/履歴・生成型・永続化契約が維持される。
- 公開基盤のREADME/CLAUDEと実sourceが一致し、私用設定・ホームパス・実データ・資格情報が公開差分にない。CI/scannerを弱めていない。
- テストが負の経路を検査しており、実装の写しや成功例だけになっていない。CIのskipと実行済みを区別する。

提出はreview対象code SHA、重大度付きfinding、再現条件、確認コマンド/exit code、未検証範囲。指摘なしの場合も確認範囲を示す。修正後の新SHAを再検査し、古いPASSを引き継がない。

Windows実機、ライブAccess claim、個人用本番配備、失効、本人ブラウザは手元担当。dots側にその環境がなければ未検証と明記する。
