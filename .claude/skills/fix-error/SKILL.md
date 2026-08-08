---
description: エラーを修正する。エラーメッセージから原因を特定し、アーキテクチャルールに従って修正する
---

# エラー修正スキル

ユーザーがエラーメッセージを貼り付けて「直して」と指示したときに適用する。

## 手順

1. **エラーメッセージを解析** — エラーの種類と発生箇所を特定
2. **原因を特定** — コードを読んで根本原因を調査
3. **修正を実施** — アーキテクチャルールに違反しない形で修正
4. **検証** — `pnpm verify` で全チェックがパスすることを確認

## よくあるエラーと対処

### 型エラー（TypeScript）
- `tsc --noEmit` で確認
- 型の不一致を修正。`any` は使わない

### 依存方向違反（dependency-cruiser）
- `pnpm depcruise` で確認
- 依存方向: `presentation → application → domain ← infrastructure`
- application から infrastructure を直接 import している場合 → Gateway interface 経由に修正
- presentation/loaders,actions から domain,infrastructure を import している場合 → composition 経由に修正

### Prisma エラー
- スキーマ変更後に `pnpm --filter webapp prisma generate` を忘れている場合が多い
- マイグレーションが必要な場合は `pnpm db:migrate`

### lint エラー
- `pnpm lint:fix` で自動修正

## ルール

- 修正時もアーキテクチャルール（依存方向、命名規約）を守る
- 修正後は必ず `pnpm verify` を実行
- エラーの根本原因を修正する（場当たり的な回避策は避ける）
