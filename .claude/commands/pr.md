---
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npm:*)
argument-hint: [追加の指示]
description: フィーチャーブランチを作成してPRを出す
---

## 現在の状況

- 現在のブランチ: !`git branch --show-current`
- 変更ファイル: !`git status --short`
- 追加の指示: $ARGUMENTS

## タスク

以下の手順でPRを作成してください：

1. **現在の状態を確認**: `git status` と `git diff` で変更内容を確認し、PRに含める変更を把握する。変更がない場合はユーザーに報告して終了する。

2. **目的（Why）の明確化**: このPRが必要な理由を明確にする。以下のいずれかの形式で言語化できるようにする：
   - 「（対象者）が（困っている状態）を解消するため」
   - 「（対象者）が（嬉しい状態）になるため」

   目的が明確でない場合は、必ずユーザーに質問して確認を取ること。PRのdescriptionに目的として記載する。

3. **ブランチ決定**:
   - 現在のブランチが main の場合: 変更内容に基づいて適切なブランチ名を自分で決定し、新しいブランチを作成してチェックアウトする（例: `feature/hls-fmp4-support`, `fix/badge-not-updating`, `refactor/extract-url-normalizer`）
   - 既にフィーチャーブランチにいる場合: 変更内容がブランチ名と合致していればそのまま使用する。合致していない場合は main から新しいブランチを作成して変更を持ち越す

4. **品質チェック**: ソースコード（`.ts`、`.tsx`、`.js`、`.jsx`ファイル）への変更がある場合のみ、プロジェクトルートで以下を実行する。ドキュメントや設定ファイルのみの変更の場合はスキップ可。
   - `pnpm verify`（lint → typecheck → unit test → depcruise → build）
   - `pnpm knip`（未使用コード検出）
   エラーがあれば修正してから次に進む。

5. **コミット**: 変更内容を確認し、適切なコミットメッセージでコミットする。コミットメッセージは変更内容を反映した簡潔なものにする。

6. **コンフリクト確認**: `git fetch origin` して、main とのマージ可能性を確認する（`bash -c 'git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main'` でコンフリクトの有無を確認）。コンフリクトがある場合はユーザーに報告し、続行するか確認を取る。

7. **プッシュ**: リモートにプッシュする（`git push -u origin <branch-name>`）

8. **PR作成**: `gh pr create` でPRを作成する。`--base` オプションは付けない（デフォルトのベースブランチを使用）。

9. **完了報告**: 作成したPRのURLを報告する。

## 注意事項

- main への直接 push は禁止。
- `src/manifest.json` の権限（`permissions` / `host_permissions`）を追加・変更する場合は、PRを出す前にユーザーに確認を取る。Chrome Web Store の審査とインストール時の警告文言に直結するため。
- UI 変更を含む場合は、`pnpm build` して `chrome://extensions` から読み込んだポップアップのスクリーンショットを PR 本文に添付する。
