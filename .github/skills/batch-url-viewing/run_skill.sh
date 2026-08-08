#!/usr/bin/env bash
# Wrapper to open meta URLs from a summary file using run.py
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <summary-file-path>"
  exit 2
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE" >&2
  exit 2
fi

# Call run.py in meta-only open-only mode
python3 "$(dirname "$0")/run.py" "$FILE" --meta-only --open --open-only
