---
description: UIコンポーネントを作成・修正する。shadcn/ui + Tailwindでデザインを実装する
---

# UI デザインスキル

ユーザーが「〇〇な画面を作って」「デザインを変えて」と指示したときに適用する。

## 使用するUIスタック

- **shadcn/ui**: `src/frontend/components/ui/` に配置
- **Tailwind CSS**: スタイリング
- **Lucide React**: アイコン（`lucide-react` からインポート）

## shadcn/ui コンポーネントの追加

新しい shadcn/ui コンポーネントが必要な場合:

```bash
cd apps/webapp && npx shadcn@latest add {component-name}
```

## コンポーネント配置

| 種類 | 配置先 |
|---|---|
| shadcn/ui 基本コンポーネント | `src/frontend/components/ui/` |
| 機能固有コンポーネント | `src/frontend/components/{feature}/` |

## ルール

- **Server Component がデフォルト。** `'use client'` は必要な場合のみ
  - `'use client'` が必要: onClick, onChange, useState, useEffect 等を使う場合
  - 不要: データ表示のみのコンポーネント
- カスタム CSS は原則不要（Tailwind で解決）
- `frontend/` から `backend/presentation/` 以外の backend コードを import しない
- レスポンシブデザインを考慮する（`md:` ブレークポイント等）
