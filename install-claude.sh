#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
DEFAULT_ENDPOINT="https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"
CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
PYTHON_BIN=${PYTHON_BIN:-python3}
NAME=""
GITHUB_ID=""
EMAIL=""

usage() {
  cat <<'EOF'
Usage: ./install-claude.sh --name NAME --github-id LOGIN --email EMAIL

Installs Sherlock's Claude Code plugin and its owner-only collector runtime.
Supported platforms: macOS and Linux.

Environment overrides:
  CLAUDE_BIN            Claude executable to use
  CLAUDE_CONFIG_DIR     Claude state directory (default: ~/.claude)
  PYTHON_BIN            Python 3 executable (default: python3)
  SHERLOCK_INGEST_URL   Collector endpoint
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      NAME=$2
      shift 2
      ;;
    --github-id|--github_id)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      GITHUB_ID=$2
      shift 2
      ;;
    --email)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      EMAIL=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$NAME" ] || [ -z "$GITHUB_ID" ] || [ -z "$EMAIL" ]; then
  usage >&2
  exit 2
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 is required." >&2
  exit 1
fi

if [ -n "${CLAUDE_BIN:-}" ]; then
  if [ ! -x "$CLAUDE_BIN" ]; then
    echo "CLAUDE_BIN is not executable: $CLAUDE_BIN" >&2
    exit 1
  fi
else
  CLAUDE_BIN=$(command -v claude || true)
  if [ -z "$CLAUDE_BIN" ]; then
    echo "Claude Code CLI was not found." >&2
    exit 1
  fi
fi

ENDPOINT=${SHERLOCK_INGEST_URL:-$DEFAULT_ENDPOINT}

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install.py" \
  --endpoint "$ENDPOINT" \
  --collector-home "$CLAUDE_CONFIG_DIR" \
  --name "$NAME" \
  --github-id "$GITHUB_ID" \
  --email "$EMAIL"

"$CLAUDE_BIN" plugin validate "$REPO_ROOT/plugins/sherlock-claude-code"
"$CLAUDE_BIN" plugin validate "$REPO_ROOT"
# Refresh the local marketplace registration so reruns update an existing install.
"$CLAUDE_BIN" plugin marketplace remove sherlock >/dev/null 2>&1 || true
"$CLAUDE_BIN" plugin marketplace add "$REPO_ROOT"
"$CLAUDE_BIN" plugin install sherlock-claude-code@sherlock

echo "Sherlock for Claude Code is installed. Start a new Claude Code session to load its hooks."
