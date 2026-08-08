---
name: url-digest
description: URLを渡すと、そのURLの内容を要約してMarkdown形式で表示するスキル
---

# URLダイジェスト（url-digest）

このスキルは、与えられた `URL` の本文・メタ情報を取得し、読みやすいMarkdownで要約して返します。`neta-trend-daily` の出力スタイルに合わせ、短い注目点・要約・重要メタ情報を必ず含めます。

## 目的
- 単一URLの内容を素早く把握できる要約（記事の要点、引用可能な短文、推奨タグ等）を生成する。
- 人的レビューやSNS投稿、内部メモへの転用を想定したMarkdown出力を作る。

## 入力
- 必須: `url` — 要約対象の完全URL（例: https://example.com/article/123）
- オプション:
	- `translate_to_ja` (boolean) — true の場合、英語などの原文を自然な日本語で翻訳して出力する（翻訳は原文の意味を損なわないように行い、必要に応じて原文を括弧内に併記する）。
	- `max_length` (int) — 要約の最大語数（デフォルト: 200）
	- `include_media` (boolean) — 画像/動画のメタ情報を取得するか

## 実行手順（推奨ワークフロー）
- 1) URL検証: スキーマ(https) とドメインの妥当性を確認する。クロスドメインのリダイレクトやpaywallの有無をチェックする。
- 2) 取得: `curl` でヘッダと本文を取得する（User-Agent を指定、タイムアウトを設定）。/tmp の一時利用は可だが実行後は削除する。

	例（bash）:
	```bash
	curl -sSL -A "url-digest/1.0 (+https://example.com)" --max-time 15 "${URL}" -o /tmp/url_digest.html
	```

- 3) 抽出: HTML から `title` / `meta description` / 著者 / 公開日 / main content を抽出する。可能なら Readability / readability-lxml 等を使用し、なければ `meta` タグや本文の最初の段落を利用する。
- 4) 要約: 抽出した本文を要約モデルまたはルールベースで要約（`max_length` を考慮）。重要な箇所（結論、数字、推奨アクション）を3〜6箇条で抽出する。
- 5) エンティティ抽出: ハッシュタグ・固有名詞・ドメイン関係のキーワードを抽出して `suggested_tags` にする。
- 6) 翻訳（オプション）: `translate_to_ja=true` の場合、要約と主要文を日本語に翻訳して併記する。
 - 6) 翻訳（オプション）: `translate_to_ja=true` の場合、要約と主要文を自然な日本語に翻訳して併記する。翻訳時の方針は下記「翻訳方針（英語→日本語）」に従う。

## 翻訳方針（英語→日本語）

- 自然で読みやすい日本語: 機械翻訳風の直訳を避け、読み手（日本語ネイティブ）に違和感のない表現を優先する。
- 専門用語の扱い: 技術用語・固有名詞は原語（英語）を丸括弧で併記可能（例: Transformer（トランスフォーマー） または トランスフォーマー（Transformer））。
- 重要数値・固有表現は原文併記: 数値や引用表現、コマンドなどは原文も括弧で併記して混乱を防ぐ。
- 翻訳の信頼性表示: 翻訳の自信度を `Confidence: 高/中/低` で出力し、不確かな箇所は注記する。
- 引用の最小化: 著作権に配慮し、全文転載は避け、短い引用（"..."）のみを許可する。
- 翻訳実行ポリシー: 翻訳は必ず内部の翻訳モデルまたは事前定義された変換ルールのみを使用する。外部の翻訳サービス、外部スクリプト、外部APIの呼び出し（例: Google Translate API、DeepL API 等）は禁止する。外部APIキーや資格情報をワークスペースに保存してはならない。
 - 翻訳実行ポリシー: 翻訳は必ず内部の翻訳モデルまたは事前定義された変換ルールのみを使用する。外部の翻訳サービス、外部スクリプト、外部APIの呼び出し（例: Google Translate API、DeepL API 等）は禁止する。外部APIキーや資格情報をワークスペースに保存してはならない。翻訳の実行は本リポジトリ内で動作する GitHub Copilot エージェント（ローカルの Copilot/Assistant を想定）が行うものとし、その旨を明記する。

例: 英語タイトル `New MessageFormat standard announced` → 日本語タイトル `MessageFormat の新標準が発表される（New MessageFormat standard announced）`
- 7) 出力: 所定のMarkdownフォーマットで出力し、まず「要約完了。」と返した後、結果を `ideas/daily/$(date +%Y%m%d)-summary.md` に直接書き出す（追記）。/tmp の中間ファイルは削除する。

## 取得／抽出の実装ヒント
- 公開APIがある場合はAPIを優先する（RSS / JSON / oEmbed など）。
- HTMLパースは堅牢に行う（BeautifulSoup, lxml, readability 等）。環境にライブラリが無い場合は `meta[name=description]` / `og:` タグ / first <article> などのフェールバックを用いる。
- 画像や動画のメタは `og:image` / `og:video` / `<figure>` を参照する。
- ペイウォールやJSレンダリング必須のページはユーザに通知する（スクリーンショットやブラウザでの確認を推奨）。

## 出力フォーマット（Markdown）
- 要約は必ずMarkdownで返す。`neta-trend-daily` のフォーマットに合わせるため、以下のフィールドを含めること：

```markdown
# URL Digest — <サイトタイトル or ドメイン> (YYYY-MM-DD)

**タイトル:** サイト記事のタイトル
**要約 (短):** 1行での要点
**要約 (詳細):** 2-4段落の要約（`max_length` 内に収める）
**注目ポイント:**
- ポイント1（数値や結論）
- ポイント2
- ポイント3

**エンティティ / 推奨タグ:** tag1, tag2, tag3
**推奨ツイート (50文字以内):** 短い告知文

**メタ情報:**
- URL: https://...
- サイト名: example.com
- 著者: (あれば)
- 公開日: (あれば)
- 推定語数: XXX
- Confidence: 高/中/低

> 注: 生データ（全文HTMLや画像）は保存しません。
```

- 出力先と保存例: アシスタントは要約を生成したらまず `要約完了。` と返し、結果を `ideas/daily/$(date +%Y%m%d)-summary.md` に追記して保存してください（ワークスペースに中間ファイルを残さないこと）。

  例（Bashで追記）:
  ```bash
  # 要約は標準出力（stdout）に出す想定
  ./run_url_digest "https://example.com/article/123" | sed -n '1,200p' >> ideas/daily/$(date +%Y%m%d)-summary.md
  ```

## 注意事項
- ワークスペースに中間CSV/TSV/JSONファイルを残さないこと。一時的なファイルは削除すること。
- ページの利用規約・著作権を尊重すること。長文の転載を避け、要約と短い引用に留める。
- 非公開コンテンツやログインを要するページは、ユーザに手動で確認してもらうこと。
- PII（個人情報）やセンシティブな情報が含まれる場合はマスクまたは要約を控える。

## 実行例（Bash + Pythonの組合せ）
```bash
# 1) 取得
curl -sSL -A "url-digest/1.0" --max-time 15 "${URL}" -o /tmp/url_digest.html

# 2) 抽出 & 要約（簡易例）
python3 - <<'PY'
import sys,bs4,datetime
from bs4 import BeautifulSoup
html=open('/tmp/url_digest.html','r',encoding='utf-8').read()
s=BeautifulSoup(html,'html.parser')
title=s.title.string.strip() if s.title else 'N/A'
desc=(s.find('meta',{'name':'description'}) or s.find('meta',{'property':'og:description'}))
desc=desc.get('content').strip() if desc and desc.get('content') else ''
print(f"# URL Digest — {title} ({datetime.date.today()})\n")
print("**タイトル:**", title)
print("**要約 (短):**", desc[:200])
PY

rm -f /tmp/url_digest.html
```

## 実行方法（現在の推奨）

ローカルにあるスクリプト群はリポジトリから削除され、ローカルで直接実行する方法は現在提供していません。

代替として、GitHub Actions ワークフロー `/.github/workflows/url-digest-trigger.yml` を用意しています。これによりリポジトリ上で次の方法から実行できます:

- GitHub UI の `Run workflow`（`workflow_dispatch`）から `url` と `translate` を入力して実行
- GitHub API を使って `workflow_dispatch` または `repository_dispatch` を呼び出してリモートからトリガー

ワークフロー実行後、要約は `ideas/daily/$(date +%Y%m%d)-summary.md` に追記されます。

必要であれば、再度ローカル実行用のスクリプトを作り直すか、別のトリガー（Slack/Webhook等）を追加します。どちらを希望しますか？


## テストと検証
- 新しい取得ルールを追加したら、代表的なドメイン（ブログ、ニュース、技術系記事、動画ページ）でサンプル実行し、出力フォーマットが崩れないことを確認する。

## 更新履歴
- 2026-02-16: 作成（`neta-trend-daily` を参考に仕様を作成）

