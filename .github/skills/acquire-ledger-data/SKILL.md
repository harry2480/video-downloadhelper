---
name: acquire-ledger-data
description: "ledger の private-transaction.csv から購入データを取得して自然文で返すスキル"
---

# acquire-ledger-data

このスキルは、`harry2480/ledger` リポジトリの `data/private-transaction.csv` を取得し、ユーザが指定したクエリにマッチする購入履歴を抽出して "yyyy年mm月dd日に購入しました" のような自然文で出力します。

目的:
- `acquire-ledger-data <検索語>` を叩くと、該当する購入行を日付付きの自然文で返す。
- 内部では `gh` CLI（存在すれば）でリポジトリのファイルを取得し、なければ raw.githubusercontent の URL を使ってフェールバック取得します。

入力:
- 必須: クエリ文字列（例: `iPhone14`、`airpods`、`Nintendo Switch` など）。

出力:
- マッチする行があれば行ごとに以下のような一行評価文を出力します。日本語表記で日付を整形します。
  - 例: `2023年05月12日に iPhone14 を購入しました — ¥120,000 — https://...`
- マッチが無ければ `No matching purchase found.` を出力して終了コード 1 を返します。

動作方針:
- まず `gh api repos/harry2480/ledger/contents/data/private-transaction.csv` を試し、base64 の content をデコードして解析します。
- `gh` が無い、API アクセスで失敗する場合は `https://raw.githubusercontent.com/harry2480/ledger/feat/add-purchase-url/data/private-transaction.csv` を `curl` で取得します。
- CSV のヘッダから日付/金額/説明(URL) 列を推測し、クエリは行内の任意の列に対して大文字小文字を区別せず部分一致で判定します。
- 出力は端末向けの短い自然文を優先します（外部 API での翻訳や LLM 呼び出しは行いません）。

実行例:

```bash
# 単一クエリ
.github/skills/acquire-ledger-data/run_skill.sh "iPhone14"

# 例: 出力
# 2023年05月12日に iPhone14 を購入しました — ¥120,000 — https://...
```

注意事項:
- プライベートなリポジトリや認証が必要な場合、`gh` の認証トークンに依存します。`gh auth login` が済んでいることを前提とします。
- 取得した CSV の中身は表示するが、スキルはファイルをワークスペースに保存しません（/tmp を一時利用するのみ）。
- 本スキルはあくまでローカルで簡易に検索して自然文で返すユーティリティです。より高度な自然文生成（Copilot/Claude への自動送信等）を組み込む場合は、追加の承認と API 設定が必要です。

実装ファイル:
- `/.github/skills/acquire-ledger-data/run_skill.sh` — 実行スクリプト（Bash + Python ヘルパ）

更新履歴:
- 2026-02-18: 初版作成
