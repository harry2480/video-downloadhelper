# スターターテンプレート

Claude Code や GitHub Copilot などの AI エージェントへの指示だけで高品質なプロダクトを構築できるスターターキットです。
また、本リポジトリは**プロジェクト横断で利用可能なドキュメントテンプレート**や**AIエージェント向けの共通スキル・コマンド**を集約するハブとしても機能しています。

## ハーネスエンジニアリングとは

このスターターキットは、**ハーネスエンジニアリング**の考え方に基づいて設計されています。

ハーネスエンジニアリングとは、AIエージェントが正しく力を発揮できるように情報やルールを整えることを指します。`CLAUDE.md` による共通ルールの注入、Skills（スラッシュコマンド）による定型作業の標準化、dependency-cruiser による依存方向の機械的な検証など、**複数のガードレールを多重に敷くことで、AIが書くコードの品質を構造的に担保**します。

これにより、AIエージェントを複数セッション並列で回しても、設計が崩れにくい開発が可能になります。

詳しい背景と実践事例については、以下の記事をご覧ください。

### このスターターキットに組み込まれたガードレール

| ガードレール | 仕組み |
|---|---|
| **設計ルールの注入** | `CLAUDE.md` や `docs/templates/` 配下にアーキテクチャ・命名規約・依存ルールを明文化し、AIにコンテキストを供給 |
| **共通Skillsとプロンプト** | `.claude/skills/` や `.claude/commands/` にプロジェクト横断の定型作業コマンドを集約し、品質のばらつきを抑制 |
| **依存方向の機械的検証** | dependency-cruiser で「domain は外部に依存しない」等のルールを CI で自動チェック |
| **レイヤー別テスト戦略** | domain/application は Unit テスト、infrastructure は Integration テスト。テスト方針もドキュメント化 |
| **統合CI/CD** | `.github/workflows/` に集約されたワークフローにより、型チェックやlint、テストを一元的に自動化 |

## テンプレートとドキュメント管理

本リポジトリの `docs/` には、新しいプロジェクトを立ち上げる際や新しい機能を設計する際にそのまま使える汎用テンプレートが用意されています。
AIに「`docs/` の〇〇を使って新しい機能の要件定義をして」と指示するだけで、ベストプラクティスに基づいた仕様書が生成されます。

**収録テンプレートの例:**
- アーキテクチャ設計規約
- フロントエンド規約
- スタイルガイド
- 品質チェック・テスト規約
- AIチャット機能要件定義 / 実装計画
- AIエージェント運用ガイド

## 技術スタック (標準構成)

- Next.js 15 (App Router) + Vercel
- Supabase PostgreSQL + Prisma
- shadcn/ui + Tailwind CSS
- vitest + dependency-cruiser
- Biome (lint/format)
- AIツール: Vercel AI SDK, Streamdown

## はじめかた

### セットアップ

AIエージェント（Claude Code 等）を開き、`/init-pj` を実行してください。前提ツールのインストールからDB構築まで自動で行います。

## 使い方

AIに自然言語で指示するだけで、テンプレートやルールに沿った機能追加が可能です。

**コマンド例:**
```
「ユーザー管理機能を作って」
「お気に入り機能を追加して」
「/articles ページを作って」
「○○テーブルにstatusカラムを追加して」
「このエラーを直して: [エラーメッセージ]」
```

## 開発コマンド一覧

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバー起動 |
| `pnpm verify` | 品質チェック（lint → typecheck → test → depcruise） |
| `pnpm test:unit` | Unit テスト実行 |
| `pnpm lint:fix` | 自動フォーマット・Lint適用 |
| `pnpm db:migrate` | DBマイグレーション |
| `pnpm knip` | 未使用コード検出 |

## プロジェクト構成

```text
starter-templete/
├── .claude/                # プロジェクト横断のAI SkillsとCommands
├── .github/workflows/      # 統合CI/CDワークフロー（型チェック、ビルド、テスト等）
├── docs/                   # プロジェクト横断で使えるドキュメント・定義テンプレート
└── apps/webapp/src/        # メインアプリケーション
    ├── app/                # ページ（Next.js App Router）
    ├── backend/            # バックエンド全体
    │   ├── application/    # ユースケース
    │   ├── domain/         # ビジネスルール（モデル、インターフェース）
    │   ├── infrastructure/ # DB・外部API実装
    │   └── presentation/   # DI組み立て、データ取得、Server Actions
    ├── frontend/           # フロントエンド・UI全体
    └── lib/                # 共有ライブラリ
```

## サンプル実装について

初期状態では Claude API を使ったジョーク生成機能がサンプルとして含まれています。
`ANTHROPIC_API_KEY` を設定すると API 経由で動作し、未設定の場合は Stub（固定値）で動作します。

```bash
echo 'ANTHROPIC_API_KEY="your-api-key"' >> apps/webapp/.env.local
```
