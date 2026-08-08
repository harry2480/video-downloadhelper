---
name: x-post-details
description: "Xポストを開いてGrokで解析し、詳細をMarkdownで表示するスキル"
---

# Xポスト詳細表示スキル（x-post-detail）

X（旧Twitter）の投稿URLまたは投稿テキストを渡すと、指定したブラウザで該当投稿を開き、同時に Grok を叩いて投稿の詳細（本文解析・エンティティ抽出・リンクプレビュー・感情・スレッド要約 等）を取得してMarkdownで表示する。

## 目的
- 人間がブラウザで投稿を確認しながら、Grok による機械的な解析結果（詳細メタデータ）を即座に得られるようにする。

## 入力
- 必須: `x_post_url`（例: `https://x.com/username/status/1234567890`）または `x_post_text`（生テキスト）
- 任意: `browser`（例: `Brave Browser`, `Safari`, `Brave`。未指定時は既定ブラウザを使用）
- オプションフラグ:
  - `translate_to_ja` (boolean) — 投稿本文を日本語に翻訳して出力する
  - `include_thread` (boolean) — リプライ/スレッド要約を含める
  - `media_meta` (boolean) — 画像/動画のメタデータを取得する

## 実行手順（アシスタントが行うこと）
1. 入力検証: `x_post_url` が与えられた場合はURL形式を確認する。投稿が非公開/削除済みの場合はユーザに通知する。
2. 指定ブラウザで投稿を開く（OSに応じたコマンドを使用）。例（macOS）:

   `open -a "Brave Browser" "https://x.com/username/status/1234567890"`

3. ブラウザで Grok の検索ページを開き、投稿URLまたは投稿本文で検索して解析結果を参照する（UIベースの操作）。

   手順（例、macOS）:
   - 指定ブラウザで Grok の検索ページを開く:
     `open -a "Brave Browser" "https://grok.com/search"`
   - 検索ボックスに投稿URL（例: `https://x.com/username/status/1234567890`）または投稿本文を貼り付けて検索を実行する。
   - 検索結果の該当エントリを開き、Grok が表示する解析（entities、sentiment、link preview、thread summary、media metadata など）を確認する。
   - ブラウザ自動操作ツール（例: Puppeteer / Playwright）を使う場合は、UI上の検索ボックスにクエリを注入して検索を実行してかまわない。ただしブラウザ上の生データ（HTML/画像等）はワークスペースに保存しないこと。
   - Grok の UI がログインを要する場合は、ユーザのブラウザにログイン済みであることを前提とする（自動ログインは行わない）。

### Grok 呼び出し手法（URL 構造の例）
- Grok には検索UIを使う方法のほか、クエリパラメータで直接解析ページを指定できる場合がある。本スキルでは以下の2つの呼び出し形式をサポートする（環境により利用可否は異なるため、まずは検索ページを開き、必要に応じて以下の形式を開く）。

- ポストID指定（post_id）
  - 例: `https://x.com/i/grok?post_id=1234567890`
  - 説明: 投稿の内部IDを指定して Grok の解析ページを直接開く。投稿IDがわかる場合はこの方法で直接該当ページに飛べる。

- URL直接指定（url）
  - 例: `https://x.com/i/grok?url=https://x.com/user/status/1234567890`
  - 説明: 投稿の公開URLをそのまま渡して解析を行う。ユーザが共有している投稿URLを使う場合に便利。

- 実行フロー（推奨）:
  1. 入力に `x_post_url`（投稿の公開URL）が含まれている場合は、まず `https://grok.com/search` を開かずに直接 `url` 形式の Grok 呼び出しを試行する。

    例（macOS）:
    ```bash
    # POST_URL は実際の投稿URL（適切にURLエンコードして渡すことを推奨）
    open -a "Brave Browser" "https://x.com/i/grok?url=https://x.com/user/status/1234567890"
    ```

    - 補足: 必要に応じて元の投稿ページも別タブで開くと、ユーザが投稿内容を同時に確認できる。

  2. `x_post_url` が与えられていないが `post_id` が指定されている場合は、`post_id` 形式で直接開く:

    ```bash
    open -a "Brave Browser" "https://x.com/i/grok?post_id=1234567890"
    ```

  3. 上記いずれも指定されていない場合は、従来通り `https://grok.com/search` を開いてUI検索を行う。

  4. ブラウザで表示された解析結果を参照し、必要なフィールドを抽出してMarkdownを生成する。

注意: Grok の動作や受け付けるクエリパラメータはサービス側の仕様に依存する。上記URL形式が利用できない場合はUI検索を優先すること。

4. Grok のページに表示された情報を抽出し、以下のフォーマットでMarkdownを生成してユーザへ返す。
5. （`translate_to_ja=true` の場合）本文と要約を日本語に翻訳して併記する。

## 出力フォーマット（Markdown）
- アシスタントの応答は**必ず Markdown**で行うこと。出力サンプル:

```markdown
# X Post Detail — @username (2026-02-16T10:00:00Z)

**本文 (EN):** This is the original tweet text...
**本文 (JA):** （自動翻訳）これは投稿の日本語訳です。

**エンティティ:** #hashtag, @mention, URL
**感情:** Neutral (score: 0.02)
**リンクプレビュー:** [Example Domain](https://example.com) — "Example site description"
**メディア:** 画像 x 2 (alt: ...), 動画 x1 (duration: 12s)
**スレッド要約:** 主要な反応・論点を3行で要約

**推奨タグ:** AI, セキュリティ
**短いTL;DR（ツイート向け）:** 50文字以内のまとめ

> 生データは保存しません（要約・抽出結果のみ表示）。
```

### 必須出力フィールド
- original_url, author_handle, posted_at, text_en, text_ja (オプション), entities, hashtags, mentions, link_previews, media_meta, sentiment, thread_summary, suggested_tags, confidence

## 自動化要件（必須）
- ブラウザ起動 → Grok 解析 → Markdown 表示 の一連処理をユーザの一操作（入力）で完了する。
- ワークスペースに原文のHTML/画像/メディアの生ファイルを保存しない（/tmp の一時利用は可だが直ちに破棄する）。
- Grok はブラウザの検索UIを用いて解析を行う（API呼び出しではない）。Grok の UI がログインを要する場合はユーザのブラウザにログイン済みであることを前提とし、自動的な認証情報の注入は行わない。
- `translate_to_ja` は自動翻訳ツール（内部の翻訳API／モデル）を使って行う。翻訳は原文の意味を損なわないよう自然な日本語にする。

## セキュリティと注意事項
- 非公開アカウント・DM・個人情報を含む投稿は解析しない、あるいは解析前にユーザに確認すること。
- X/Twitter の利用規約・API利用規約に従うこと。
- 解析結果を公開する前には**PII**（メール・電話番号・住所など）をマスクするか削除する。
- NSFWや違法コンテンツが含まれる場合、要約を行わずユーザへ警告する。

## 例（ユーザとの対話フロー）
- ユーザ: `x-post-detail https://x.com/ryota/status/12345 browser=Brave translate_to_ja=true`
- アシスタント:
  1) 指定のブラウザでURLを開く
  2) Grok に解析を投げる
  3) 結果をMarkdownで表示（本文の日本語訳を含む）

## 実装メモ（開発者向け）
- macOS: `open -a "<Browser Name>" "<URL>"`
- Linux: `xdg-open "<URL>"`
- Windows: `start <URL>`
- Grok から得た JSON の各フィールドは必ずスキーマ検証を行い、欠損値には `N/A` を設定する。

## 出力例（短い）
- 返答はMarkdownで、まず1行で処理完了を伝え、その下に解析結果を表示する。

> 例: `解析完了 — 投稿をブラウザで開き、Grokの解析結果を以下に表示します.`

---

## 注意
- このスキルは「投稿の閲覧補助」と「解析結果の提示」を目的とします。投稿内容の自動共有・公開は行わないでください。
