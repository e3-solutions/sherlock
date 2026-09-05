#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
MARKETPLACE_ROOT=${SHERLOCK_MARKETPLACE_ROOT:-$REPO_ROOT}
DEFAULT_ENDPOINT="https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"
CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
PYTHON_BIN=${PYTHON_BIN:-python3}
NAME=""
GITHUB_ID=""
EMAIL=""
BACKFILL_HOURS=72

usage() {
  cat <<'EOF'
Usage: ./install-claude.sh --name NAME --github-id LOGIN --email EMAIL [--backfill-hours HOURS]

Installs Sherlock's Claude Code plugin and its owner-only collector runtime.
Supported platforms: macOS and Linux.

Environment overrides:
  CLAUDE_BIN            Claude executable to use
  CLAUDE_CONFIG_DIR     Claude state directory (default: ~/.claude)
  PYTHON_BIN            Python 3 executable (default: python3)
  SHERLOCK_INGEST_URL   Collector endpoint

Options:
  --backfill-hours      Initial Claude transcript lookback (default: 72; max: 744)
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
    --backfill-hours)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      BACKFILL_HOURS=$2
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

case "$BACKFILL_HOURS" in
  # Canonical decimal only: reject octal-looking values and overflow before
  # either test(1) or shell arithmetic can interpret the input.
  ''|0*|*[!0-9]*|????*)
    echo "--backfill-hours must be an integer from 1 to 744." >&2
    exit 2
    ;;
esac
if [ "$BACKFILL_HOURS" -lt 1 ] || [ "$BACKFILL_HOURS" -gt 744 ]; then
  echo "--backfill-hours must be an integer from 1 to 744." >&2
  exit 2
fi
BACKFILL_SECONDS=$((BACKFILL_HOURS * 60 * 60))

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 is required." >&2
  exit 1
fi

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/validate_install_email.py" \
  --email "$EMAIL" \
  --collector-home "$CLAUDE_CONFIG_DIR"

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

REPLAY_BIN_DIR="$CLAUDE_CONFIG_DIR/sherlock/bin"
mkdir -p "$REPLAY_BIN_DIR"
install -m 0700 \
  "$REPO_ROOT/plugins/sherlock-claude-code/scripts/replay_history.py" \
  "$REPLAY_BIN_DIR/replay-history"

RUNTIME_ROOT="$CLAUDE_CONFIG_DIR/sherlock/runtime"
if [ -n "${PYTHONPATH:-}" ]; then
  COLLECTOR_PYTHONPATH="$RUNTIME_ROOT:$PYTHONPATH"
else
  COLLECTOR_PYTHONPATH="$RUNTIME_ROOT"
fi
if BACKFILL_RESULT=$(PYTHONPATH="$COLLECTOR_PYTHONPATH" "$PYTHON_BIN" \
  -m sherlock_collector.cli \
  --provider claude_code \
  --claude-home "$CLAUDE_CONFIG_DIR" \
  --state-root "$CLAUDE_CONFIG_DIR/sherlock/telemetry" \
  --config "$CLAUDE_CONFIG_DIR/sherlock/collector.json" \
  backfill --lookback-seconds "$BACKFILL_SECONDS"); then
  echo "Claude Code ${BACKFILL_HOURS}-hour backfill: $BACKFILL_RESULT"
  case "$BACKFILL_RESULT" in
    *'"excluded_by_cutoff": 0'*) ;;
    *)
      echo "Coverage note: Claude transcript candidates older than the configured cutoff were not selected. Use $REPLAY_BIN_DIR/replay-history for an explicit UUID or date-range replay." >&2
      ;;
  esac
  case "$BACKFILL_RESULT" in
    *'"status": "complete"'*) ;;
    *)
      echo "Warning: Claude Code backfill was partial; rerun this installer with the same --backfill-hours value or use replay-history." >&2
      ;;
  esac
else
  echo "Warning: Claude Code backfill could not start; plugin installation will continue. Rerun this installer or use replay-history." >&2
fi

"$CLAUDE_BIN" plugin validate "$MARKETPLACE_ROOT/plugins/sherlock-claude-code"
"$CLAUDE_BIN" plugin validate "$MARKETPLACE_ROOT"
# Refresh the local marketplace registration so reruns update an existing install.
"$CLAUDE_BIN" plugin marketplace remove sherlock >/dev/null 2>&1 || true
"$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_ROOT"
"$CLAUDE_BIN" plugin install sherlock-claude-code@sherlock

echo "Sherlock for Claude Code is installed. Bounded transcripts were queued for upload; start a new Claude Code session to load its hooks."
echo "Historical replay: $REPLAY_BIN_DIR/replay-history --session-id UUID or --start RFC3339 --end RFC3339"
