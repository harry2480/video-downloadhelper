---
description: 新しい機能を追加する。ユーザーが機能の説明をしたとき、DDD4層に従って全レイヤーのファイルを生成する
---

# 機能追加スキル

ユーザーが「〇〇な機能を作って」と指示したときに適用する。
DDD 4層アーキテクチャに従い、以下のファイルを一括生成する。

## 生成するファイル

1. **Domain Model** (`src/backend/domain/models/{name}.model.ts`)
   - Rich Domain Model として設計（ファクトリメソッド `create()` + `reconstruct()`）
   - バリデーションはモデル自身で行う
   - エラーは `Result<T, E>` 型で返す

2. **Repository Interface** (`src/backend/domain/repositories/{name}.repository.ts`)
   - ドメインモデル型のみ使用（ORM型を出さない）

3. **Gateway Interface**（必要な場合: `src/backend/domain/gateways/{name}.gateway.ts`）
   - 外部API連携がある場合のみ

4. **UseCase** (`src/backend/application/usecases/{action}-{name}.usecase.ts`)
   - クラスベース + コンストラクタ DI
   - `execute()` メソッドで公開

5. **Repository 実装** (`src/backend/infrastructure/repositories/prisma-{name}.repository.ts`)
   - Prisma 経由。ORM型 ↔ ドメインモデル変換を担当

6. **Gateway 実装**（必要な場合）
   - 本番: `src/backend/infrastructure/adapters/{provider}-{name}.adapter.ts`
   - Stub: `src/backend/infrastructure/adapters/stub-{name}.adapter.ts`

7. **Composition** (`src/backend/presentation/composition/{name}.composition.ts`)
   - DI組み立て。環境変数でStub/本番を切り替え

8. **Loader** (`src/backend/presentation/loaders/{name}.loader.ts`)
   - データ取得用

9. **Action** (`src/backend/presentation/actions/{name}.action.ts`)
   - `'use server'` 付き。副作用用

10. **ページ** (`src/app/{path}/page.tsx`)
    - Server Component。loader を呼んでデータ表示

11. **Unit テスト**
    - `test/unit/domain/models/{name}.model.test.ts`
    - `test/unit/application/usecases/{action}-{name}.usecase.test.ts`

## Prisma スキーマ

必要に応じて `prisma/schema.prisma` にモデルを追加し、`pnpm db:migrate` でマイグレーションを作成する。

## ルール

- ファイル命名は kebab-case + レイヤーサフィックス
- 依存方向: presentation → application → domain ← infrastructure
- application から infrastructure を直接 import しない
- presentation/loaders, actions から domain, infrastructure を直接 import しない
- 関数エクスポートでサービスを実装しない（クラスベース必須）
- 生成後に `pnpm verify` を実行して全パスすることを確認

## サンプル（参考）

既存の Joke 機能（`joke.model.ts`, `generate-joke.usecase.ts` 等）を参考にする。
