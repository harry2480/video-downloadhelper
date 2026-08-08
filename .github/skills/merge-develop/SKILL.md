---
name: merge-develop
description: develop ブランチをローカルに合流させるスキル。git fetch → merge を自動実行し、conflict 時は通知。実行: `/merge-develop`
keywords: [git, merge, develop, workflow]
---

# Merge Develop

develop ブランチの最新コードをローカルブランチに合流させるスキルです。

## 概要

`/merge-develop` コマンドを実行すると以下の処理を自動実行します：

1. **リモートから最新を取得** (`git fetch origin develop`)
2. **マージ実行** (`git merge origin/develop --no-commit --no-ff`)
3. **結果通知**
   - ✅ 成功時: マージが完了し、push 可能な状態に
   - ⚠️ Conflict 時: 競合内容を表示し、手動解決を指示

## 使用例

```bash
/merge-develop
```

## 処理フロー

```
開始
  ↓
git fetch origin develop
  ↓
merge 実行？ → Yes → git merge origin/develop --no-commit --no-ff
  ↓              ↓
  ├─ FF可能  → 自動commit → 完了 ✅
  ├─ Conflict → 通知 ⚠️ (手動解決)
  └─ エラー   → エラー通知 ❌
```

## オプション

- `--auto-commit`: conflict がない場合自動 commit して push（デフォルト: 確認ダイアログ）
- `--force-resolve`: 同名ファイルは develop 側を採用（危険）

## エラーハンドリング

### Conflict 発生時

```bash
# 発生メッセージ例:
# [!] Conflict detected in: src/foo.ts, lib/bar.ts
# → 手動で解決して: git add . && git commit
```

### ネットワークエラー

自動で再試行（最大3回）します。

## 関連コマンド

- `git status`: 現在のマージ状態確認
- `git diff --name-only --diff-filter=U`: conflict ファイル一覧
- `git merge --abort`: マージ中止
