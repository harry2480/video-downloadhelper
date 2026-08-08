#!/usr/bin/env bash
# Convenience wrapper: prompts for a short Japanese intent and runs run_skill.sh
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
read -p "やりたいこと（例: メール見る / ドライブのファイルを見る / メール返信）: " INTENT
echo "Dry-run を表示します。実行する場合は --execute を付けてください。"
"${SCRIPT_DIR}/run_skill.sh" "$INTENT" "$@"
