---
name: batch-url-viewing
description: "sumamryの中に入っているメタ情報URLを一括で開く"
---

# Batch URL Viewing スキル

指定した `ideas/daily/YYYYMMDD-summary.md` または類似の Markdown ファイルに含まれる URL を一括で検査・表示するためのスキル仕様。

目的
- 日次サマリやまとめファイルの中に記載された複数の URL を迅速に検証し、死んだリンク／リダイレクト／コンテンツ種別の把握を行う。
- 人的レビューのためにブラウザで開く URL をまとめて指定したり、要約ツール（`url-digest`）へバッチで渡すワークフローを支援する。

要件（高レベル）
- 対象ファイルから URL を抽出する（Markdown のリンクと裸 URL の両方）
- 各 URL へ HEAD/GET を行い HTTP ステータス、最終URL（リダイレクト先）、Content-Type を取得する
- オプションで URL をデフォルトブラウザで開く（macOS: `open`、Linux: `xdg-open`）
- オプションで各 URL に対して既存の `scripts/url_digest.py` を順次実行して要約を取得・追記する
- robots.txt とサイト利用規約に留意し、リクエストレートを制限する（デフォルト: 1 req/sec）
- ワークスペースに中間CSV/JSONを残さない（/tmp の一時利用は許可、実行後は削除）

入力
- 必須: `date` または summary ファイルパス（例: `20260221` → `ideas/daily/20260221-summary.md` を対象）
- オプションフラグ:
  - `--open` : 抽出した URL をブラウザで順次開く
  - `--digest` : 各 URL に対して `python3 scripts/url_digest.py <url> --translate` を実行して要約を取得して追記する
  - `--fail-only` : ステータスコードが 400 以上 / タイムアウト の URL のみを出力/開く
  - `--concurrency N` : 並列実行数（デフォルト 1）
  - `--rate R` : リクエスト間隔（秒, デフォルト 1）

出力
- 端末へのサマリ表（Markdown 互換）またはファイル `ideas/daily/YYYYMMDD-url-check.md` への追記:

```
# URL Check — YYYY-MM-DD

| URL | Status | Final URL | Content-Type | Note |
|-----|--------|-----------|--------------|------|
| https://example.com | 200 | https://example.com | text/html | OK |
```

- `--digest` を指定した場合、`ideas/daily/YYYYMMDD-summary.md` に `URL Digest — <domain>` の要約が追記される（`url-digest` の仕様に従う）。

実行手順（実装ヒント）
1. 対象ファイルを開き、正規表現で `https?://...` を抽出（Markdown の `[text](url)` と裸 URL の両方をサポート）
2. 抽出 URL を一意化してリスト化
3. 各 URL に対して `curl -I -L --max-time 10 -A "batch-url-viewer/1.0"` を実行し、HTTP ステータスと `Content-Type`、`Location` ヘッダ（リダイレクト）を取得
4. 取得結果をテーブル化して出力/保存
5. `--open` が指定されていれば `open` / `xdg-open` で順次開く（開く前に `--fail-only` の条件を適用）
6. `--digest` が指定されていれば、各 URL ごとに `python3 scripts/url_digest.py "${URL}" --translate` を呼び出す（実行間隔は `--rate` を尊重）

短い実装例（bash）
```bash
FILE=ideas/daily/${1}-summary.md
grep -Eo "https?://[^)\s]+" "$FILE" | sort -u > /tmp/urls.txt
while read -r url; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 10 -A "batch-url-viewer/1.0" "$url")
  final=$(curl -s -I -L --max-time 10 -A "batch-url-viewer/1.0" "$url" | awk '/^Location:/{print $2}' | tail -1 | tr -d '\r')
  echo "| $url | $status | ${final:--} |" >> ideas/daily/${1}-url-check.md
  sleep 1
done < /tmp/urls.txt
rm -f /tmp/urls.txt
```

注意事項 / ポリシー
- robots.txt を尊重する（スクレイピング禁止のサイトは通知のみ行いアクセスを控える）
- リクエストレートはデフォルトで低めに設定する。大量 URL を処理する際は `--concurrency` と `--rate` を調整すること
- 実行ログや中間データはワークスペースに残さない（/tmp を使う場合は削除する）
- 認証が必要なページや paywall ページは自動処理の対象外。手動確認を促すメッセージを出す
- すべての外部リクエストはユーザーの同意のもとで行われるものとする（ローカル実行前に注意喚起を表示）

例: コマンドライン
```bash
# 検査のみ
python3 .github/skills/batch-url-viewing/run.py 20260221

# 死んでるURLだけ開く
python3 .github/skills/batch-url-viewing/run.py 20260221 --open --fail-only

# 要約も自動で取る（注意: url-digest を呼ぶため実行時間が長くなる）
python3 .github/skills/batch-url-viewing/run.py 20260221 --digest --concurrency 2 --rate 0.5
```

拡張案
- ブラウザのタブをまとめて開く UI（macOS の `osascript` を使った制御）
- 既存 `ideas/daily/*-summary.md` の URL と `ideas/daily/*-trend.md` を差分比較して、新規/消滅した URL をハイライト
- `--digest` 実行時に `url-digest` の成功/失敗をまとめて報告

この SKILL.md は仕様書です。実行スクリプト（`run.py` / `run.sh`）が必要なら実装しますか？
---
name: batch-url-viewing
description: 指定したyyyymmdd-summary.mdの中のURLを一括で確認するためのスキルです。
---
