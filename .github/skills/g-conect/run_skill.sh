#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 \"<日本語のやりたいこと>\" [--execute] [--account EMAIL]"
  exit 1
fi

intent="$1"
shift || true
EXECUTE=false
ACCOUNT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=true; shift ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --account=*) ACCOUNT="${1#--account=}"; shift ;;
    *) shift ;;
  esac
done

# Map simple Japanese intents to gws commands
CMD=""
if echo "$intent" | grep -qE "メール|受信|受信箱|受信トレイ|トリアージ"; then
  CMD="gws gmail +triage"
elif echo "$intent" | grep -qE "ドライブ|ファイル|Drive"; then
  CMD="gws drive files list --params '{\"orderBy\": \"modifiedTime desc\", \"pageSize\": 10}'"
elif echo "$intent" | grep -qE "予定|カレンダー|Calendar|アジェンダ"; then
  CMD="gws calendar +agenda"
elif echo "$intent" | grep -qE "返信|返事|メール返"; then
  read -p "返信先メールアドレス: " TO
  read -p "件名 (省略可): " SUBJECT
  echo "本文を入力してください。終わったら Ctrl-D を押してください。"
  BODY=$(cat)
  if [ -z "$TO" ]; then
    echo "宛先が指定されていません。中止します。"; exit 1
  fi
  CMD="gws gmail +send --to \"$TO\""
  [ -n "$SUBJECT" ] && CMD="$CMD --subject \"$SUBJECT\""
  CMD="$CMD --body \"${BODY}\""
else
  echo "サポートされている操作例:"
  echo "  - メール見る / トリアージ"
  echo "  - ドライブ見る / ファイル見る"
  echo "  - 予定見る / カレンダー見る"
  echo "  - メール返信"
  exit 0
fi

echo "-----"
echo "解釈: $intent"
echo "実行コマンド (dry-run):"
echo "$CMD"
echo "-----"

if [ "$EXECUTE" = true ]; then
  echo "実行中..."
  eval "$CMD"
fi
