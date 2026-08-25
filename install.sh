#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
MARKETPLACE_ROOT=${SHERLOCK_MARKETPLACE_ROOT:-$REPO_ROOT}
DEFAULT_ENDPOINT="https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"
CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
PYTHON_BIN=${PYTHON_BIN:-python3}
NAME=""
GITHUB_ID=""
EMAIL=""

usage() {
  cat <<'EOF'
Usage: ./install.sh --name NAME --github-id LOGIN --email EMAIL

Installs the Sherlock Codex plugin, collector runtime/config, and trusts only
the installed Sherlock hooks.

Environment overrides:
  CODEX_BIN             Codex executable to use
  CODEX_HOME            Codex state directory (default: ~/.codex)
  PYTHON_BIN             Python 3 executable (default: python3)
  SHERLOCK_INGEST_URL    Collector endpoint
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

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/validate_install_email.py" \
  --email "$EMAIL" \
  --collector-home "$CODEX_HOME"

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

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install.py" \
  --endpoint "$ENDPOINT" \
  --codex-home "$CODEX_HOME" \
  --name "$NAME" \
  --github-id "$GITHUB_ID" \
  --email "$EMAIL"

RUNTIME_ROOT="$CODEX_HOME/sherlock/runtime"
if [ -n "${PYTHONPATH:-}" ]; then
  COLLECTOR_PYTHONPATH="$RUNTIME_ROOT:$PYTHONPATH"
else
  COLLECTOR_PYTHONPATH="$RUNTIME_ROOT"
fi
if BACKFILL_RESULT=$(PYTHONPATH="$COLLECTOR_PYTHONPATH" "$PYTHON_BIN" \
  -m sherlock_collector.cli \
  --provider codex \
  --codex-home "$CODEX_HOME" \
  --state-root "$CODEX_HOME/sherlock/telemetry" \
  --config "$CODEX_HOME/sherlock/collector.json" \
  backfill --lookback-seconds 86400); then
  echo "Codex 24-hour backfill: $BACKFILL_RESULT"
  case "$BACKFILL_RESULT" in
    *'"status": "complete"'*) ;;
    *)
      echo "Warning: Codex backfill was partial; later SessionStart hooks will resume it." >&2
      ;;
  esac
else
  echo "Warning: Codex backfill could not start; plugin installation will continue and SessionStart will retry it." >&2
fi

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install_marketplace.py" \
  --codex-bin "$CODEX_BIN" \
  --repo-root "$MARKETPLACE_ROOT"
"$CODEX_BIN" plugin add sherlock@sherlock --json >/dev/null

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/trust_hooks.py" \
  --codex-bin "$CODEX_BIN" \
  --codex-home "$CODEX_HOME" \
  --cwd "$MARKETPLACE_ROOT"

echo "Sherlock is installed. Start a new Codex task to load its hooks."
