#!/usr/bin/env bash
# Usage: .github/skills/agent-memory/run_skill.sh [--since DAYS] [--limit N] [--query KEYWORD]
# By default write suggestions JSON to /tmp/suggestions.json and print grouped MD.
python3 "${PWD}/scripts/suggest_issues_from_summaries.py" --out-json /tmp/suggestions.json --limit 50 "$@"