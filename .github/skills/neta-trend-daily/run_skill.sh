#!/usr/bin/env bash
set -euo pipefail

# Simple wrapper: run scripts/trend_collect.py from workspace root and pass args through
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1
python3 scripts/trend_collect.py "$@"
