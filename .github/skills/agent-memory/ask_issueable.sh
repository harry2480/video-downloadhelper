#!/usr/bin/env bash
# Run the agent-memory suggestion skill and print grouped MD to stdout
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
bash "${SCRIPT_DIR}/run_skill.sh" "$@"
