---
name: g-connect
description: gws CLI (Google Workspace CLI) の主要コマンドを日本語で説明するスキル。エージェントが Google Workspace にアクセスする際の参照用。
keywords: [gws, Google Workspace, Gmail, Calendar, Drive, Docs, Sheets, auth]
---

# 概要

`gws` は Google Workspace API をターミナルから操作するための公式 CLI です。本ドキュメントは主要コマンド群の日本語訳（説明・使用例）を簡潔にまとめたものです。

# セットアップ

```bash
# 認証
gws auth login

# デフォルトアカウント設定
gws config set account <email>
```

# 主要コマンド（日本語訳）

## Gmail 操作

**最新メール確認:**
```bash
gws gmail +triage                    # 優先度付きメール一覧
```

**メール検索:**
```bash
gws gmail users messages list --params '{"q": "検索クエリ"}'
# 例: 指定期間内のメール
gws gmail users messages list --params '{"q": "newer_than:7d"}'
```

**メール詳細取得:**
```bash
gws gmail users messages get --params '{"id": "MESSAGE_ID"}'
```

**メール送信:**
```bash
gws gmail +send --to "宛先@example.com" --subject "件名" --body "本文"
```

## Calendar 操作

**予定確認:**
```bash
gws calendar +agenda               # 今日・明日の予定
```

**予定追加:**
```bash
gws calendar +insert --summary "会議名" --start "2026-03-17T10:00:00Z" --end "2026-03-17T11:00:00Z"
```

## Drive / ファイル操作

**最近のファイル一覧:**
```bash
gws drive files list --params '{"orderBy": "modifiedTime desc", "pageSize": 10}'
```

**ファイル検索:**
```bash
gws drive files list --params '{"q": "name contains '\''検索語'\''"}'
```

**ファイルダウンロード:**
```bash
gws drive files get <fileId> --out <ローカルパス>
```

**ファイルアップロード:**
```bash
gws drive files create --file <ローカルパス> --parents <親フォルダID>
```

## Sheets 操作

**スプレッドシート読取:**
```bash
gws sheets values get <sheetId> --range 'Sheet1!A1:Z100'
```

**データ書込:**
```bash
gws sheets values update <sheetId> --range 'Sheet1!A1' --input '[["データ1", "データ2"]]'
```

## Docs 操作

**ドキュメント取得:**
```bash
gws docs documents get <docId>
```

**エクスポート:**
```bash
gws drive files export <fileId> --mimeType "application/pdf" --out <パス>.pdf
```

# 共通オプション

```bash
--params '{JSON}'        # API パラメータを JSON で指定
--output json|table|text # 出力形式の指定
--pretty                 # 見やすく整形
```

# 実行ルール

1. **出力形式**: `gws` は JSON を返します。必要に応じて `jq` で整形してください
2. **安全第一**: 削除操作の前には必ずユーザーに確認を取ってください
3. **認証エラー**: `gws auth login` を実行してください

# 参考

- ヘルプ: `gws --help`
- グループヘルプ: `gws <group> --help`
