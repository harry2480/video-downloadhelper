#!/usr/bin/env bash
set -euo pipefail

# Usage: run_skill.sh <URL> [--translate]
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/url_digest.py"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <URL> [--translate]" >&2
  exit 2
fi

URL="$1"
shift || true
ARGS=("$URL")
if [ "${1-}" = "--translate" ]; then
  ARGS+=("--translate")
fi

python3 "$SCRIPT" "${ARGS[@]}"
