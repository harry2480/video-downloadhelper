#!/bin/bash

# merge-develop skill runner
# develop ブランチをローカルに合流させる

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../" && pwd)"
cd "$PROJECT_ROOT"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Options
AUTO_COMMIT=false
FORCE_RESOLVE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --auto-commit) AUTO_COMMIT=true; shift ;;
    --force-resolve) FORCE_RESOLVE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo -e "${BLUE}🔄 Merge develop ブランチを開始します${NC}"
echo ""

# Current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📍 現在のブランチ: $CURRENT_BRANCH"

# Fetch latest
echo ""
echo -e "${BLUE}📥 リモートから develop を取得中...${NC}"
if ! git fetch origin develop; then
  echo -e "${RED}❌ Fetch 失敗${NC}"
  exit 1
fi

# Check if we're ahead/behind
AHEAD=$(git rev-list --count origin/develop..HEAD 2>/dev/null || echo "0")
BEHIND=$(git rev-list --count HEAD..origin/develop 2>/dev/null || echo "0")

echo "  現在のブランチ vs develop:"
echo "    - 先行: $AHEAD commits"
echo "    - 後進: $BEHIND commits"

if [ "$BEHIND" -eq 0 ]; then
  echo -e "${GREEN}✅ すでに最新です（マージ不要）${NC}"
  exit 0
fi

# Merge
echo ""
echo -e "${BLUE}🔀 マージ実行中...${NC}"

if git merge origin/develop --no-commit --no-ff; then
  # Success - no conflict
  echo -e "${GREEN}✅ マージ成功（競合なし）${NC}"
  echo ""

  if [ "$AUTO_COMMIT" = true ]; then
    git commit -m "Merge develop into $CURRENT_BRANCH"
    echo -e "${GREEN}✅ コミット完了${NC}"
  else
    # Show what would be committed
    echo "📊 マージされた変更:"
    git diff --cached --name-status | head -10
    echo ""
    echo -e "${YELLOW}💭 /merge-develop の後、\"git add\" → \"git commit\" → \"git push\" を実行してください${NC}"
  fi
else
  # Conflict detected
  echo -e "${RED}⚠️  競合が発生しました${NC}"
  echo ""

  CONFLICT_FILES=$(git diff --name-only --diff-filter=U)
  echo "競合ファイル:"
  echo "$CONFLICT_FILES" | sed 's/^/  - /'
  echo ""

  if [ "$FORCE_RESOLVE" = true ]; then
    echo -e "${YELLOW}🔧 --force-resolve で develop 側を採用します${NC}"
    git checkout --theirs $CONFLICT_FILES
    git add $CONFLICT_FILES
    git commit -m "Merge develop (auto-resolved with theirs) into $CURRENT_BRANCH"
    echo -e "${GREEN}✅ 競合を自動解決してコミット完了${NC}"
  else
    echo -e "${YELLOW}📝 手動でファイルを編集して競合を解決してください${NC}"
    echo ""
    echo "解決後:"
    echo "  1. git add <files>"
    echo "  2. git commit -m \"Merge develop into $CURRENT_BRANCH\""
    echo "  3. git push"
    exit 1
  fi
fi

echo ""
echo -e "${GREEN}✨ merge-develop 完了${NC}"
