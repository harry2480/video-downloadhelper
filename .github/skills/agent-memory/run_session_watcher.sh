#!/usr/bin/env bash
# Run session_watcher (Claude + GitHub Copilot)
# Usage: .github/skills/agent-memory/run_session_watcher.sh [--once] [--out-claude PATH] [--out-copilot PATH]
python3 "${PWD}/scripts/session_watcher.py" "$@"