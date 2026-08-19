#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
PYTHON_BIN=${PYTHON_BIN:-python3}
CLAUDE_BIN=${CLAUDE_BIN:-claude}
RUNTIME="$CLAUDE_CONFIG_DIR/sherlock/runtime"

"$CLAUDE_BIN" plugin validate "$REPO_ROOT/plugins/sherlock-claude-code"
"$CLAUDE_BIN" plugin validate "$REPO_ROOT"
"$CLAUDE_BIN" plugin marketplace list
"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock-claude-code/scripts/verify_install.py"

PYTHONPATH="$RUNTIME${PYTHONPATH:+:$PYTHONPATH}" \
  "$PYTHON_BIN" -m sherlock_collector.cli \
  --provider claude_code \
  --claude-home "$CLAUDE_CONFIG_DIR" \
  --state-root "$CLAUDE_CONFIG_DIR/sherlock/telemetry" \
  --config "$CLAUDE_CONFIG_DIR/sherlock/collector.json" \
  health

echo "Local verification only: this does not prove upload, normalization, or dashboard visibility."
