#!/usr/bin/env bash
set -euo pipefail
# Wrapper to save today's agent memory into ideas/daily
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
PY="$ROOT_DIR/scripts/save_today_agent_memory.py"

if [ ! -f "$PY" ]; then
  echo "Missing script: $PY" >&2
  exit 1
fi

python3 "$PY"
