---
name: review
description: コードレビュー・テストガイドラインチェック・コード品質チェックを同時実行する
---

# Review

コードレビュー・セキュリティレビュー・テストガイドラインチェックを**同時に実行**するセルフレビュースキル。

## 使い方

引数なしで実行すると、main ブランチとの差分をレビューする。

```
/review
/review "セキュリティ面を重点的にチェックして"
```

## ワークフロー

### Step 1: 差分の確認

まず現在のブランチと変更内容を確認する:

```bash
git branch --show-current
git diff --stat main...HEAD
```

変更がない場合（かつ未コミット変更もない場合）はユーザーに通知して終了。
未コミット変更がある場合は `git diff --stat` で確認する。

### Step 2: 3つのチェックを同時実行

以下の3つを **並列に** 起動する（同一メッセージ内で3つの Tool call を発行）:

#### 2a. Codex Review（Bashで実行）

ユーザーから追加の指示（引数）があればそれを PROMPT として渡す。

```bash
# 引数なしの場合
codex review --base main

# 引数ありの場合（例: "セキュリティ面を重点的にチェック"）
codex review --base main "{ユーザーの指示}"
```

コマンドのタイムアウトは5分（300000ms）に設定する。

#### 2b. コードレビュー（Agent ツールで実行）

`subagent_type: "code-reviewer"` の Agent を起動する。以下を必ずレビュー観点に含めるよう指示する。

- **層の配置**: コアロジック層（`shared/` `media/` `processor/`）に `chrome.*` / DOM 参照が混入していないか
- **コンテキスト間の越境**: `background/` `offscreen/` `content/` `popup/` 相互の import がないか
- **Service Worker 非常駐**: 長時間処理が `background/` に残っていないか。状態が storage から復元可能か
- **Popup の状態所有**: Popup が真実の情報源になっていないか
- **エラー処理**: 握りつぶしがないか。`Result<T, E>` で返しているか
- **テスト**: パーサー・正規化・判定ロジックに異常系のテストがあるか

#### 2c. セキュリティレビュー（Agent ツールで実行）

`subagent_type: "security-reviewer"` の Agent を起動する。拡張機能固有の観点を必ず含めるよう指示する。

- メッセージの送信元検証（`sender.id !== chrome.runtime.id`）があるか
- ページ由来の文字列が `innerHTML` / `dangerouslySetInnerHTML` へ渡っていないか
- Cookie / Authorization / URL クエリの認証トークンがログや storage に残っていないか
- 外部ホストへの送信・リモートコード実行が混入していないか
- `manifest.json` の権限が増えていないか。増えているなら正当な理由があるか
- `web_accessible_resources` が不必要に広がっていないか

**重要**: 2a, 2b, 2c は必ず並列（同一メッセージ内で3つの Tool call）で実行すること。

### Step 3: 結果の報告

3つの結果をまとめてユーザーに表示する:

1. **Codex Review 結果**: Codex の出力をそのまま表示
2. **コードレビュー結果**: エージェントの出力をそのまま表示
3. **セキュリティレビュー結果**: エージェントの出力をそのまま表示

## 注意事項

- `codex` CLI がインストール済みであること（`/opt/homebrew/bin/codex`）
- レビュー対象はデフォルトで `main` ブランチとの差分（このリポジトリに `develop` はない）
- `--base` オプションで比較対象を変更可能
- 参照する規約: `docs/アーキテクチャ.md` / `docs/品質チェック・テスト規約.md` / `docs/テストガイドライン.md`
- エージェントが利用できない場合は、該当チェックをスキップして残りを実行する
