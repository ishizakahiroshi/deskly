---
type: reference
status: draft
tags: [deskly, dots, review]
owner: ishizakahiroshi
review_status: draft
related: []
last_reviewed: 2026-10-04
---

# dots #10 独立レビュー指示

実装担当から独立した担当が[README.md](README.md)を基準にレビューする。実装者の完了文を合格根拠にせず、対象diff・source・テスト・画面の証跡を照合する。

開始時に指示公開commit、diff起点、実装SHAを記録する。レビューしたSHA以降に実装変更があれば再確認する。看板だけの更新はコードのレビューSHAと分ける。

1. 値の意味: 未取得が0にならないか、commit時刻と観測日時を混同しないか、PR/review/時間/進捗を推測していないか。調査のみでcommitがない案件にも意味のある表示があるか。
2. 集計: 固定ref・期間境界・タイムゾーン、重複、複数分類、未分類、失敗後の最終成功データ、取得範囲の完全性を確認する。
3. 権限: 本人認証と案件権限、workspace越境、機械principal拒否を実行経路で確認する。Git CLIがreadonlyであること、任意パス/URL読取・秘密出力・HTML注入がないこと。
4. 互換: 既存のprojects/items機械読取とMCP変更見本/適用、状態語彙、保存/履歴、provider未設定環境を壊していないこと。
5. UI: PC/狭幅、根拠への操作、未収集表示、調査とGit系列の区別。画面を見ていない場合は未検証とする。
6. 実装範囲: migration、CI/scanner/hooks、会社データ、自動通知、工数推定、共有機能が混入していないこと。

所見は重要度、ファイル位置、再現条件、実害、必要な修正で記す。実行できなかった検査、合成データの確認、手元の実案件受入を区別する。重大な権限漏れ・秘密漏れ・誤集計があれば手元試用へ進めない。merge・deployは行わない。
