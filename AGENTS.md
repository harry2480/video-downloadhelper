# Video Download Helper AIエージェントへの指針 (AGENTS.md)

このファイルは、このリポジトリでコードを操作する AI エージェント（Claude Code / Codex / Copilot 等）へのルールを提供します。

**設計ルールの詳細は [CLAUDE.md](CLAUDE.md) と `docs/` を単一の情報源とします。** このファイルはそれを重複させず、リポジトリ運用上のルールのみを扱います。

## プロジェクト概要

Chrome / Chromium 系ブラウザ向けの動画ダウンロード支援拡張機能（Manifest V3）。
pnpm workspace monorepo で、`apps/extension/` に Vite + React + TypeScript の拡張機能が入ります。
**サーバーサイド・データベースは存在しません。** 永続化は `chrome.storage`、通信はコンテキスト間メッセージのみです。

## 必須ルール

### 要件定義が最上位

`docs/要件定義.md` が仕様の最上位の情報源です。実装方針に迷ったら推測せず、まずこれを読むこと。
要件定義と矛盾する実装・ドキュメントを書かないこと。矛盾に気づいた場合は勝手に解釈せず、ユーザーに確認する。

### 権限の追加は要確認

`apps/extension/src/manifest.json` の `permissions` / `host_permissions` を追加・変更する場合は、**実装前にユーザーへ確認する**。
Chrome Web Store の審査結果とインストール時の警告文言に直結し、後から戻すのが難しいためです。

### コアロジックの純粋性を壊さない

`src/shared/` `src/media/` `src/processor/` で `chrome.*` / `document` / `window` / `Blob` を参照しないこと。
ここが崩れると Unit テストが Node.js 上で動かなくなり、テスト戦略全体が破綻します。
副作用が必要な場合は Port interface として宣言し、実行コンテキスト層から注入する。

### 外部送信の禁止

閲覧 URL・メディア URL・ページタイトルを外部へ送信するコードを書かないこと。テレメトリも同様です。
リモートコード（外部 CDN のスクリプト・WASM）を読み込まないこと。Chrome Web Store ポリシー違反になります。

### Push前の必須チェック

`git push` する前に以下を実行し、全てパスすることを確認する：

1. `pnpm verify` - lint → typecheck → unit test → depcruise → build
2. `pnpm knip` - 未使用コード検出

いずれかが失敗した場合は修正してから push すること。
depcruise の違反を設定変更で回避しないこと。モジュールの配置を見直すのが正しい対処です。

### ベースブランチ

このリポジトリのベースブランチは `main`（`develop` は存在しない）。main への直接 push は禁止。

## 作業ルール

### 要件定義・実装計画

依頼された場合は、最初に論点を洗い出してユーザーに質問しながらクリアにし、マークダウンでドキュメントを作成すること。

### ドキュメント管理

- 保存場所: `docs/` 以下
- ファイル名: 日本語の内容名（既存の `アーキテクチャ.md` 等に揃える）
- フォーマット: Markdown

### GitHub Issue作成

- プラン内容を簡略化せず、そのまま issue に記載する
- コード例、型定義などの詳細な実装内容を含める
- 検証方法を具体的に記載する

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `pnpm dev` | Vite dev server（`chrome://extensions` から `apps/extension/dist/` を読み込む） |
| `pnpm build` | 本番ビルド |
| `pnpm verify` | 品質チェック一式 |
| `pnpm test:unit` | Unit テスト |
| `pnpm test:integration` | Integration テスト（要ビルド済み `dist/`） |
| `pnpm test:e2e` | E2E テスト（Playwright） |

## ディレクトリ構造

```text
apps/extension/src/
├── background/    # Service Worker（検出の集約、状態の所有）
├── offscreen/     # Offscreen Document（セグメント取得、Blob 生成、ffmpeg）
├── content/       # Content Script（DOM 監視）
├── popup/         # React UI（状態を所有しない購読者）
├── processor/     # コアロジック（純粋）
├── media/         # コアロジック（純粋）— 検出・HLS/DASH 解析
├── shared/        # コアロジック（純粋）— 型・メッセージ・ports・storage
└── manifest.json
```

依存方向: `background/offscreen/content/popup → processor → media → shared`
実行コンテキスト同士の import は禁止（別バンドルのため成立しない）。通信はメッセージ経由のみ。
