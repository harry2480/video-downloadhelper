---
description: データベースにテーブルを追加・変更する。Prismaスキーマ変更 + マイグレーション + Repository生成
---

# DB テーブル追加・変更スキル

ユーザーが「〇〇テーブルを追加して」「〇〇カラムを追加して」と指示したときに適用する。

## 手順

### 1. Prisma スキーマ変更

`apps/webapp/prisma/schema.prisma` を編集:

- テーブル名は `@@map("snake_case_plural")` でスネークケース複数形にマッピング
- カラム名は `@map("snake_case")` でスネークケースにマッピング
- `id` は `@id @default(cuid())` を使用
- タイムスタンプは `@db.Timestamptz()` を付与
- 日時カラムには `@map("snake_case")` を付ける

### 2. マイグレーション作成

```bash
pnpm db:migrate
```

マイグレーション名の入力を求められたら、変更内容を簡潔に英語で入力する（例: `add_jokes_table`）。

### 3. Repository 生成

- **Interface** (`src/backend/domain/repositories/{name}.repository.ts`)
  - ドメインモデル型のみ使用
- **実装** (`src/backend/infrastructure/repositories/prisma-{name}.repository.ts`)
  - Prisma Client 経由で CRUD
  - ORM 型 ↔ ドメインモデル変換を担当

### 4. Domain Model 生成

`src/backend/domain/models/{name}.model.ts`:
- Rich Domain Model（ファクトリメソッド `create()` + `reconstruct()`）
- バリデーションはモデル自身で行う

## ルール

- `prisma db push` は使用禁止（必ず `prisma migrate dev` を使う）
- Repository interface にORM型を出さない
- 変更後に `pnpm verify` を実行
