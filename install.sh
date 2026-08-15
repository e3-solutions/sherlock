#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
DEFAULT_ENDPOINT="https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"
CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
PYTHON_BIN=${PYTHON_BIN:-python3}
TOKEN_STDIN=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--token-stdin]

Installs the Sherlock Codex plugin, collector runtime/config, and trusts only
the installed Sherlock hooks.

Environment overrides:
  CODEX_BIN             Codex executable to use
  CODEX_HOME            Codex state directory (default: ~/.codex)
  PYTHON_BIN             Python 3 executable (default: python3)
  SHERLOCK_INGEST_URL    Collector endpoint
  SHERLOCK_INGEST_TOKEN  Collector token (otherwise prompted without echo)
EOF
}

case "${1:-}" in
  "") ;;
  --token-stdin)
    TOKEN_STDIN=1
    shift
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

if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 is required." >&2
  exit 1
fi

if [ -n "${CODEX_BIN:-}" ]; then
  if [ ! -x "$CODEX_BIN" ]; then
    echo "CODEX_BIN is not executable: $CODEX_BIN" >&2
    exit 1
  fi
else
  CODEX_BIN=""
  if command -v codex >/dev/null 2>&1; then
    CANDIDATE=$(command -v codex)
    if "$CANDIDATE" --version >/dev/null 2>&1; then
      CODEX_BIN=$CANDIDATE
    fi
  fi
  if [ -z "$CODEX_BIN" ] && [ -x /Applications/ChatGPT.app/Contents/Resources/codex ]; then
    CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
  fi
  if [ -z "$CODEX_BIN" ]; then
    echo "Codex CLI was not found. Install or open the Codex desktop app first." >&2
    exit 1
  fi
fi

ENDPOINT=${SHERLOCK_INGEST_URL:-$DEFAULT_ENDPOINT}

if [ "$TOKEN_STDIN" -eq 1 ]; then
  "$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install.py" \
    --endpoint "$ENDPOINT" \
    --codex-home "$CODEX_HOME" \
    --token-stdin
else
  "$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install.py" \
    --endpoint "$ENDPOINT" \
    --codex-home "$CODEX_HOME"
fi

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install_marketplace.py" \
  --codex-bin "$CODEX_BIN" \
  --repo-root "$REPO_ROOT"
"$CODEX_BIN" plugin add sherlock@sherlock --json >/dev/null

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/trust_hooks.py" \
  --codex-bin "$CODEX_BIN" \
  --codex-home "$CODEX_HOME" \
  --cwd "$REPO_ROOT"

echo "Sherlock is installed. Start a new Codex task to load its hooks."
