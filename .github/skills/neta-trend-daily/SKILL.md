---
name: neta-trend-daily
description: "トレンドネタ収集"
---

# トレンドネタ収集

[はてなブックマークIT人気エントリーとHacker News、Qiita、Zennの人気記事を収集し、`ideas/daily/YYYYMMDD-trend.md` に保存する。](https://www.itmedia.co.jp/aiplus/subtop/news/index.html)

## 実行手順

**実行ポリシー:** `neta-trend-daily` の実行中は、内部で `*.sh` や `*.py` スクリプトを自動で起動します。実行の都度ユーザ許可を求めません（ワークスペース内で実行されることに同意している前提です）。


### 0. ユーザープロファイル読み込み

`Claude.md` を読み込み、以下の興味領域を理解する：
- AI（開発とセキュリティへの応用）
- Webセキュリティ/ハッキング（OWASP、脆弱性、サプライチェーン攻撃）
- OSS開発/コミュニティ
- 個人開発/SaaS運営（Technical SEO、グロースハック、収益化）
- キャリア/人生哲学（経済的自由、外資転職、Build in Public）
- JavaScript/TypeScript技術スタック

### 1. トレンド情報の収集

以下のサイトから最新のトレンド情報を取得：

**日本市場（はてブIT）**
- https://b.hatena.ne.jp/hotentry/it
- https://b.hatena.ne.jp/hotentry/it/%E3%83%97%E3%83%AD%E3%82%B0%E3%83%A9%E3%83%9F%E3%83%B3%E3%82%B0
- https://b.hatena.ne.jp/hotentry/it/AI%E3%83%BB%E6%A9%9F%E6%A2%B0%E5%AD%A6%E7%BF%92
- https://b.hatena.ne.jp/hotentry/it/%E3%81%AF%E3%81%A6%E3%81%AA%E3%83%96%E3%83%AD%E3%82%B0%EF%BC%88%E3%83%86%E3%82%AF%E3%83%8E%E3%83%AD%E3%82%B8%E3%83%BC%EF%BC%89
- https://b.hatena.ne.jp/hotentry/it/%E3%82%BB%E3%82%AD%E3%83%A5%E3%83%AA%E3%83%86%E3%82%A3%E6%8A%80%E8%A1%93
- https://b.hatena.ne.jp/hotentry/it/%E3%82%A8%E3%83%B3%E3%82%B8%E3%83%8B%E3%82%A2
- 各エントリーの**タイトル、元記事URL、ブックマーク数**を必ず取得すること
- はてブのエントリーページURLではなく、リンク先の元記事URLを抽出

### 追加ソース（国内外メディア）

以下のサイトを追加で取得することを推奨します: `WIRED`, `Gigazine`, `gori.me`, `ITmedia News`, `Watch Impress`。
取得方針は「フィードがあればRSS/Atomを優先」「フィードが無い／不安定な場合は記事一覧ページを取得してHTMLから抽出」の順です。以下は具体的な取り方例。

- WIRED（英語サイト）: フィードが提供されている場合は RSS/Atom を取得。ない場合は `https://www.wired.com/` のカテゴリページや `latest` ページを取得して、`<article>` やカード要素（例: `.card`）からタイトルとリンクを抽出してください。

- Gigazine: 多くの場合 RSS を提供（例: `https://gigazine.net/news/rss_2.0/`）。フィードの `<item>` からタイトルとリンクを取得するのが確実です。

- gori.me: フィードまたはカテゴリ一覧ページから記事リンクを抽出。ページ構造が変わりやすいため、CSS セレクタ（`article a` など）で取得する方法を推奨します。

- ITmedia News: フィードが利用可能なら優先して利用。無ければ `https://www.itmedia.co.jp/news/` 等の一覧ページをスクレイピングして各記事のタイトル/URLを取得してください。

- Watch Impress: `https://watch.impress.co.jp/` のRSS/カテゴリ一覧から取得。`og:` メタや `<article>` 要素を使うと安定して抽出できます。

例1 — RSS/Atom を使った取得（汎用・Python）:

```bash
curl -s "${FEED_URL}" -o /tmp/feed.xml
python3 - <<'PY'
import sys,xml.etree.ElementTree as ET
doc=ET.fromstring(open('/tmp/feed.xml','r',encoding='utf-8').read())
items=doc.findall('.//item') or doc.findall('.//entry')
for it in items[:10]:
  title = (it.find('title').text or '').strip()
  link = ''
  l = it.find('link')
  if l is not None:
    link = (l.text or l.attrib.get('href') or '').strip()
  print(f"- [{title}]({link})")
PY
rm -f /tmp/feed.xml
```


例2 — HTML一覧ページをスクレイピングして抽出（BeautifulSoup 推奨）:

```bash
curl -s -A "neta-trend-collector/1.0" "${LIST_URL}" -o /tmp/list.html
python3 - <<'PY'
from bs4 import BeautifulSoup
html=open('/tmp/list.html','r',encoding='utf-8').read()
s=BeautifulSoup(html,'html.parser')
anchors = s.select('article a') or s.select('.entry-title a') or s.select('.newsList a')
for a in anchors[:10]:
  title=a.get_text(strip=True)
  href=a.get('href')
  if href and href.startswith('/'):
    href = f"https://{s.find('base').get('href','').strip('/')}{href}" if s.find('base') else href
  print(f"- [{title}]({href})")
PY
rm -f /tmp/list.html

### 各メディア（取り方・優先方法 — 追加サイト）
以下は指定されたサイト群を確実に取得するための具体的手順と優先順です。まず *フィード（RSS/Atom）* を探し、なければ一覧ページをHTMLから抽出してください。

- WIRED.jp（`https://wired.jp/`, `https://wired.jp/business/`, `https://wired.jp/gear/`）
  - 優先: ページ上の `<link rel="alternate" type="application/rss+xml">` を探索して feed を取得（`/feed` を試す）。
  - フィードがない場合: カテゴリページを取得して `article a`, `.p-entry__title a`, `.entry-card__title a` のようなセレクタでタイトル/リンクを抽出。
  - 例（フィード）:
    ```bash
    curl -s https://wired.jp/feed/ | python3 -c "import sys,xml.etree.ElementTree as ET; doc=ET.fromstring(sys.stdin.read()); print('\n'.join([f'- [{i.find(\'title\').text}]({i.find(\'link\').text})' for i in doc.findall('.//item')][:10]))"
    ```

- Gigazine（`https://gigazine.net/`, カテゴリ: `C4`, `C48`, `C12`, `C37`, `C5`, `C6`）
  - 優先: 公式RSS（例: `https://gigazine.net/news/rss_2.0/`）をパース。
  - カテゴリページを直接取得する場合は `article a` や `.entry-title a` を利用。

- gori.me（`https://gori.me/` と各カテゴリ: `/iphone`, `/mac` 等）
  - 優先: サイトフィード `https://gori.me/feed` を確認・利用。
  - フィードが無い/不安定な場合: カテゴリ一覧ページを取得し `article a` / `.entry-title a` で抽出。

- ITmedia AI+（`https://www.itmedia.co.jp/aiplus/` と `genai` / `dataanalytics` セクション）
  - 優先: セクション専用のRSSがないか確認（サイト全体RSSもチェック）。
  - セクションページをHTMLから取る場合は `main article a` / `.listBox a` 等のセレクタを探索してタイトルとリンクを取得。

- Watch Impress（`https://www.watch.impress.co.jp/category/tech/`）
  - 優先: `https://watch.impress.co.jp/data/rss/feeds.rss` のようなフィードを利用。
  - フィードが無い場合: カテゴリページで `<article>` / `.box-article a` などから抽出。

共通の実装方針（短く）
- まずフィードを自動探索（`<link rel="alternate" type="application/rss+xml">` を確認）→ 見つかればXMLをパースして記事を取得。
- 見つからない場合はカテゴリページのHTMLを取得 → `<article>` 内の先頭リンク、もしくは `.entry-title a` のようなタイトル要素を抽出。
- 抽出時は `is_asset_url()`（拡張子や `/static/` パス）でアセットを除外すること。
- 取得優先度: RSS/Atom → セクションページの `<article>` → 汎用アンカー抽出（最終手段）。

出力フォーマット: 追加ソースから取得した記事も **はてブ/HN と同様の表形式** に変換して `ideas/daily/YYYYMMDD-trend.md` の「追加ソース」セクションに追加してください（例: `| タイトル | ソース | 興味度 | カテゴリ | メモ |`）。
```

運用上の注意:
- 各サイトの利用規約と `robots.txt` を確認すること。アクセス頻度は控えめに（秒間リクエスト数を制限）。
- フィードURLやセレクタはサイト更新で変わるため、エラー時はトップページのフェールバック取得を試行すること。
- 追加ソースは既存の `ideas/daily/YYYYMMDD-trend.md` の末尾（追加ソースセクション）に追記し、セクション順は `はてブ → Hacker News → Reddit → 追加ソース` としてください。
 
### 注目トピックとフィルタリング方針

指定した各メディア（上のURL群）から取得する際は、以下のトピック領域を優先的に抽出・タグ付けしてください。各エントリについて該当トピックを1つ以上割り当て、関係度に応じて「興味度（★★★/★★/★）」を付与します。日本語化が必要なタイトルは翻訳して出力してください。

**機械学習 / AI**
- モデル学習・最適化、ハイパーパラメータ、トレーニング基盤
- 深層学習（CNN/RNN/Transformer 等）
- 大規模言語モデル（LLM）、ファインチューニング、LoRA/PEFT、プロンプト工学
- 生成AI（テキスト/画像/音声/動画）、生成評価、合成コンテンツ検出
- マルチモーダルモデル、クロスモーダル学習
- 自己教師あり学習、メタラーニング、Few-shot 学習
- 強化学習、シミュレーション環境、報酬設計
- モデル圧縮・効率化（量子化・蒸留・プルーニング）
- モデル評価・ベンチマーク、再現性

**ソフトウェアアーキテクチャ / 開発**
- バックエンド/フロントエンド設計

**セキュリティ / プライバシー**
- アプリ・インフラセキュリティ、脆弱性管理（SAST/DAST）
- クラウドセキュリティ、IAM、秘密管理
- サプライチェーンセキュリティ（SBOM、SLSA）
- AIセキュリティ（敵対的攻撃、データ毒性、モデル窃盗）
- プライバシー（差分プライバシー、匿名化）、法規対応

**観測性 / テスト / 品質**
- ロギング、トレーシング、メトリクス（OpenTelemetry）
- E2E/統合/ユニットテスト、自動化テスト、テストインフラ
- 可用性/SLI/SLO、インシデント対応、Chaos Engineering

**ネットワーク / 通信 / Edge**
- 低遅延通信、5G、WebRTC、リアルタイム処理
- CDN、プロキシ、キャッシュ戦略、ネットワーク可観測性

**ハードウェア / 半導体 / エッジデバイス**
- IoT、エッジデバイス、半導体関連ニュース

**組織 / プロダクト / ビジネス**
- プロダクトマネジメント、KPI設計、ロードマップ
- SaaS 運営、PLG、価格設計、チャーン管理
- 技術マーケティング、テクニカルSEO、コミュニティ運用
- 投資・M&A・スタートアップ動向、VCトレンド

**オープンソース / コミュニティ**
- OSSガバナンス、ライセンス、メンテナンス負荷

実装上の注意:
- 取得した各エントリに対して、上のトピックいずれかにマッチするか判定し、`suggested_tags` として付与すること。
- マッチングはキーワード照合＋簡易分類ルールで良い（例: 記事本文/タイトルに `LLM|Transformer|LoRA` があれば `機械学習 / AI` にマッチ）。
- 関連度が高い（記事が明確に当該領域を扱っている）場合は `★★★`、やや関連する場合は `★★`、軽微な関連は `★` を付与する。出力に `興味度` カラムを含めること。
- 可能なら `summary` において、なぜそのトピックに割り当てたかを短く一文で補足する。

このセクションを追加することで、日次の `ideas/daily/YYYYMMDD-trend.md` は単に一覧を並べるだけでなく、当リポジトリで重要視するトピックに沿ってフィルタ・優先付けされたレポートになります。

**Qiita（日本）**
- Qiitaの人気記事（またはタグ別の人気エントリー）を取得する。取得方法はQiitaの公開APIかタグRSSを利用する。
- 取得必須項目：タイトル、記事URL、可能であればいいね/stock等のリアクション数
 - タイトルは日本語なので翻訳は不要だが、出力は**はてブ/HN と同様のテーブル形式**で統一してください（例: `| タイトル | 反応 | 興味度 | カテゴリ | メモ |`）。
- 取得例（Bashで直接Markdown追記）:
```bash
# Qiita API例（ページングで上位を取得）
curl -s "https://qiita.com/api/v2/items?page=1&per_page=20" \
  -H "Accept: application/json" | \
  jq -r '.[] | "- [\(.title | gsub("\n";" "))](\(.url))  — \(.likes_count // .stock_count // 0) reactions"' \
  >> ideas/daily/$(date +%Y%m%d)-trend.md
```

**Zenn（日本）**
- ZennはAtom/RSSフィードが利用可能なため、フィードをパースして人気記事を取得するのが簡単。取得必須項目：タイトル、記事URL、可能であればリアクション数（ある場合）
- 出力は**はてブ/HN と同様のテーブル形式**で統一してください（例: `| タイトル | 興味度 | カテゴリ | メモ |`）。
- 取得例（フィードをパースして直接Markdownへ）:
```bash
# Zenn Atomフィード例
curl -s "https://zenn.dev/feed" | \
  # XMLパーサが使えない環境では小さなPythonスニペットで処理することを推奨
  python3 -c "import sys,xml.etree.ElementTree as ET; print('\\n'.join(['- ['+e.find('title').text.strip()+']('+e.find('link').attrib.get('href')+')' for e in ET.fromstring(sys.stdin.read()).findall('.//entry')]))" \
  >> ideas/daily/$(date +%Y%m%d)-trend.md
```

**グローバル（Hacker News）**
- https://news.ycombinator.com/
- 各記事の**タイトル、HNコメントページURL（`https://news.ycombinator.com/item?id=XXXXX`形式）、ポイント数**を取得
- **元記事URLではなくHNのコメントページURLを使用すること**（コメントも確認できるようにするため）
- **タイトルは実行時に自動で日本語に翻訳して出力（`--translate`）。** スクリプト内の辞書＋ルールで自然な日本語表現を生成し、必要に応じて原題を括弧で併記します。

**セキュリティ（追加ソース）**
- https://www.aikido.dev/blog - セキュリティ研究開発者向けのセキュリティ情報
- https://www.wiz.io/blog - クラウドセキュリティ
- 最新1-3記事をチェックし、興味度★★★のものがあれば注目トピックに含める

**Reddit（13サブレッド）**
- **重要**: WebFetchツールはreddit.comをブロックするため、**Bashツールでcurlコマンドを使用**すること
- 各サブレッドから `/hot.json?t=day&limit=10` で上位10件を取得
- **old.reddit.com**を使用（www.reddit.comではない）
- User-Agentヘッダーを設定: `"User-Agent: neta-trend-collector/1.0 (trend analysis tool)"`
- 各記事の**タイトル、Redditコメントページの完全URL、投票数（ups）、コメント数**を取得
- **タイトルは実行時に自動で日本語に翻訳して出力（`--translate`）。** スクリプト内の辞書＋ルールで日本語化し、必要に応じて原題を括弧で併記します。

取得例（Bashツールで実行 - 直接Markdown出力）:
```bash
# Reddit：JSON → 直接Markdown出力（CSV/TSVを作らずにそのままファイルに追記）
curl -s -H "User-Agent: neta-trend-collector/1.0 (trend analysis tool)" \
  "https://old.reddit.com/r/programming/hot.json?t=day&limit=10" | \
  jq -r '.data.children[] | "- [\(.data.title | gsub("\\n";" "))](https://www.reddit.com\(.data.permalink))  — \(.data.ups) ups, \(.data.num_comments) comments"' \
  >> ideas/daily/$(date +%Y%m%d)-trend.md

# Hacker News：Firebase APIを使って直接Markdown出力（コメントページURLを使用）
curl -s https://hacker-news.firebaseio.com/v0/topstories.json | jq -r '.[0:30][]' | \
  xargs -I{} sh -c "curl -s https://hacker-news.firebaseio.com/v0/item/{}.json | jq -r '\"- [\(.title | gsub("\\n";" "))](https://news.ycombinator.com/item?id=\(.id))  — \(.score) pts, \(.descendants // 0) comments\"'" \
  >> ideas/daily/$(date +%Y%m%d)-trend.md
```

データ構造:
- `data.children[].data.title`: タイトル
- `data.children[].data.ups`: 投票数
- `data.children[].data.num_comments`: コメント数
- `data.children[].data.permalink`: パス（`https://www.reddit.com` + permalink で完全URL）

セキュリティ系（2サブレッド）:
- r/netsec
- r/cybersecurity

AI系（11サブレッド）:
- r/OpenAI
- r/ChatGPT
- r/LocalLLaMA
- r/ClaudeCode
- r/google
- r/ArtificialIntelligence
- r/PromptEngineering
- r/GeminiAI
- r/AIAssisted
- r/NotebookLM

コア技術系（3サブレッド）:
- r/programming
- r/technology
- r/SEO

OSS/個人開発系（9サブレッド）:
- r/opensource
- r/indiehackers
- r/webdev
- r/javascript
- r/UXDesign
- r/UI_Design
- r/iOSProgramming
- r/typescript
- r/FlutterDev

### 自動化要件（必須）
- 一度の実行で「収集 → 翻訳 → Markdown生成（保存）」を完了させること（手動ステップや別スクリプトを要求しない）。
- `neta-trend-daily` はデフォルトで**サマリを自動生成しません**。興味ある URL を手動で選んで `url-digest` を実行してください。自動でサマリを作る必要がある場合はオプション `--summary` を付けて実行できます（推奨は手動運用）。

手動サマリ生成の例:
```bash
# 個別URLを要約（翻訳あり）
.github/skills/url-digest/run_skill.sh "https://news.ycombinator.com/item?id=47045612" --translate
# または直接スクリプトを呼ぶ
python3 scripts/url_digest.py "https://zenn.dev/frsk/articles/ai-pentesting-tools-2026" --translate
```

- 理由: 日次の `-trend.md` を見てユーザが興味ある URL を選び、`url-digest` で高品質な要約を得るワークフローを想定しています。
- **ワークスペースにCSV/TSV/中間JSONファイルを保存しないこと。最終出力は必ず `ideas/daily/YYYYMMDD-trend.md` に直接書き出す。** (/tmp の一時利用は可だが実行後は削除すること)
- Hacker Newsの取得は可能ならFirebase API（https://hacker-news.firebaseio.com）を使い、`topstories`→`item`で情報を取得して**HNコメントページURL（https://news.ycombinator.com/item?id=XXXXX）を必ず出力**すること。
- HN と Reddit の `title` は実行時に `--translate` を付けることで自動的に日本語化します（内部ルール＋用語辞書を使用）。原文の併記は任意ですが、日本語タイトルが出力に含まれていることが必須です。
- 最終Markdownのフォーマット・セクション順（はてブ → Hacker News → Reddit）と必須フィールド（タイトル／URL／カウント／興味度）を厳守すること。

### 2. 分析

収集した情報を以下の観点で分析：

**興味領域マッチング（最優先）**
- 各記事を興味領域と照合し、関連度を評価
- 高関連度の記事を「注目トピック」の最上位に配置
- 特に注目すべきトピック：
  - AI関連（開発ツール、セキュリティ、倫理）
  - セキュリティ関連（脆弱性、攻撃手法、防御策）
  - OSS/個人開発関連（成功事例、マーケティング、収益化）
  - JavaScript/TypeScript関連（新技術、ツール、フレームワーク）

**はてブIT**
- 日本のエンジニアに刺さりやすい話題
- 議論を呼びそうなトピック
- 技術トレンド（AI、開発手法、ツール等）
- キャリア・働き方関連

**Hacker News**
- グローバルで話題の技術トレンド
- スタートアップ・プロダクト関連
- セキュリティ関連（脆弱性、攻撃手法、インシデント）
- 議論を呼んでいるトピック（ポイント数が高い）

**Reddit（13サブレッド）**
- セキュリティ系：最新の脅威、実践的な攻撃・防御手法
- AI系：OpenAI、ローカルLLM、Claude Code関連
- OSS/個人開発系：OSSプロジェクト、個人開発、Web開発
- 投票数（ups）とコメント数でコミュニティの反応を評価
- 議論が活発なトピック（コメント数が多い）を優先

### 3. 出力

**まず「ネタ収集完了。」というメッセージを返してから、結果を `ideas/daily/YYYYMMDD-trend.md` に保存。**

以下のフォーマットで出力：

```markdown
# トレンドネタ: YYYY-MM-DD

## はてブIT（日本市場）

### 注目トピック

| タイトル | ブクマ数 | 興味度 | カテゴリ | メモ |
|---------|---------|--------|---------|------|
| [タイトル](元記事URL) | XXX users | ★★★/★★/★ | AI/開発/キャリア等 | 発信に活用できるポイント |

**興味度の定義**:
- ★★★: 興味領域に直接関連（AI×セキュリティ、OSS、個人開発、キャリアなど）
- ★★: 間接的に関連（技術トレンド全般、エンジニアリング文化）
- ★: 一般的なIT/技術ニュース

### 全エントリー

1. [タイトル](元記事URL) (XXX users) - 概要
2. ...

## Hacker News（グローバル）

### 注目トピック

| タイトル | ポイント | 興味度 | カテゴリ | メモ |
|---------|---------|--------|---------|------|
| [タイトル](HNコメントページURL) | XXXpt | ★★★/★★/★ | AI/Security/Dev等 | 発信に活用できるポイント |

### 全エントリー

1. [タイトル](HNコメントページURL) (XXXpt) - 概要
2. ...

## Reddit（13サブレッド）

### 注目トピック

| タイトル | 投票数 | コメント数 | 興味度 | カテゴリ | サブレッド | メモ |
|---------|--------|-----------|--------|---------|-----------|------|
| [タイトル](Redditコメントページ完全URL) | XXX ups | XXX | ★★★/★★/★ | Security/AI/OSS等 | r/subreddit | 発信に活用できるポイント |

### カテゴリ別エントリー

#### セキュリティ系
1. [タイトル](RedditコメントページURL) (XXX ups, XXX comments) - r/netsec - 概要
2. ...

#### AI系
1. [タイトル](RedditコメントページURL) (XXX ups, XXX comments) - r/OpenAI - 概要
2. ...

#### OSS/個人開発系
1. [タイトル](RedditコメントページURL) (XXX ups, XXX comments) - r/opensource - 概要
2. ...

#### キャリア/実践系
1. [タイトル](RedditコメントページURL) (XXX ups, XXX comments) - r/cscareerquestions - 概要
2. ...
```

## 注意事項

- **重要**: ワークスペースにCSV/TSV/中間JSONファイルを作成しないこと。最終出力は必ず `ideas/daily/YYYYMMDD-trend.md` に直接書き出す（/tmp の一時利用は可だが、実行後は削除する）。
- WebFetchツールを使用して情報を取得
- **すべての記事にURLリンクを必ず含める（リンクなしは不可）**
- **はてブは元記事のURLを必ず取得**（はてブページURLではなく）
- **Hacker NewsはHNコメントページURL（`item?id=`形式）を使用**（元記事URLではなく）
- **Hacker Newsのタイトルは日本語に翻訳**（翻訳は自然な日本語、専門用語は括弧で原語併記して可）
- **RedditはRedditコメントページの完全URL（`https://www.reddit.com/r/subreddit/comments/...`形式）を使用**
- **Redditのタイトルは日本語に翻訳**（必須）
- Reddit APIレート制限に注意（1分あたり60リクエスト程度）
- 投票数（ups）/コメント数が高い記事を優先
- ポイント数/ブックマーク数が高い記事は特に注目
- 出力ファイルのYYYYMMDDは実行日の日付を使用
