---
allowed-tools: Bash(git:*)
description: mainブランチに戻ってリモートと同期する
---

## 現在の状況

- 現在のブランチ: !`git branch --show-current`
- 変更状態: !`git status --short`

## タスク

以下の手順で main ブランチに同期してください：

1. **コミット状態の確認**: `git status` で未コミットの変更がないか確認する。変更がある場合はユーザーに報告して終了する（stash するか、コミットするか確認を取る）。

2. **リモートの取得**: `git fetch origin` でリモートの最新状態を取得する。

3. **main へ切り替え**: `git checkout main` で main ブランチに切り替える。

4. **最新化**: `git pull origin main` で main を最新化する。

5. **完了報告**: 同期後の状態を報告する。

## 注意事項

- このリポジトリのベースブランチは `main`（`develop` は存在しない）
- マージ済みのローカルブランチが残っている場合は、削除するかユーザーに確認を取る
