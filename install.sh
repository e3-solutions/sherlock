#!/bin/sh

set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
DEFAULT_ENDPOINT="https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"
CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
PYTHON_BIN=${PYTHON_BIN:-python3}
NAME=""
GITHUB_ID=""
EMAIL=""
HISTORY_MODE="export"
HISTORY_OUTPUT=""
HISTORY_WORKERS=""
UPLOAD_WORKERS="16"
ACKNOWLEDGE_SENSITIVE_DATA="0"

usage() {
  cat <<'EOF'
Usage: ./install.sh --name NAME --github-id LOGIN --email EMAIL \
  [--acknowledge-sensitive-data] [--upload-history | --skip-history]

By default, exports all Codex history to an owner-only ZIP, installs the
Sherlock Codex plugin and collector, and leaves the ZIP in ~/Downloads for an
administrator.
Use --upload-history to upload it after installation or --skip-history to omit
the history export. Exporting requires --acknowledge-sensitive-data.

History options:
  --acknowledge-sensitive-data  Confirm history can contain sensitive data
  --upload-history              Upload the ZIP after installing Sherlock
  --skip-history                Install without exporting Codex history
  --history-output PATH         Override the timestamped owner-only ZIP path
  --history-workers N           Parallel export compression workers (1-32)
  --upload-workers N            Parallel upload workers (1-16; default: 16)

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
    --acknowledge-sensitive-data)
      ACKNOWLEDGE_SENSITIVE_DATA="1"
      shift
      ;;
    --upload-history)
      [ "$HISTORY_MODE" != "skip" ] || { usage >&2; exit 2; }
      HISTORY_MODE="upload"
      shift
      ;;
    --skip-history)
      [ "$HISTORY_MODE" != "upload" ] || { usage >&2; exit 2; }
      HISTORY_MODE="skip"
      shift
      ;;
    --history-output)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      HISTORY_OUTPUT=$2
      shift 2
      ;;
    --history-workers)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      HISTORY_WORKERS=$2
      shift 2
      ;;
    --upload-workers)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      UPLOAD_WORKERS=$2
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

if [ "$HISTORY_MODE" != "skip" ] && [ "$ACKNOWLEDGE_SENSITIVE_DATA" != "1" ]; then
  echo "History export requires --acknowledge-sensitive-data." >&2
  echo "Codex history may contain prompts, responses, tool data, source code, and secrets." >&2
  exit 2
fi

if [ "$HISTORY_MODE" != "skip" ] && [ -n "$HISTORY_WORKERS" ]; then
  case "$HISTORY_WORKERS" in
    *[!0-9]*|'')
      echo "--history-workers must be an integer between 1 and 32." >&2
      exit 2
      ;;
  esac
  if [ "$HISTORY_WORKERS" -lt 1 ] || [ "$HISTORY_WORKERS" -gt 32 ]; then
    echo "--history-workers must be an integer between 1 and 32." >&2
    exit 2
  fi
fi

if [ "$HISTORY_MODE" = "upload" ]; then
  case "$UPLOAD_WORKERS" in
    *[!0-9]*|'')
      echo "--upload-workers must be an integer between 1 and 16." >&2
      exit 2
      ;;
  esac
  if [ "$UPLOAD_WORKERS" -lt 1 ] || [ "$UPLOAD_WORKERS" -gt 16 ]; then
    echo "--upload-workers must be an integer between 1 and 16." >&2
    exit 2
  fi
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

if [ "$HISTORY_MODE" != "skip" ]; then
  if [ -z "$HISTORY_OUTPUT" ]; then
    HISTORY_DIRECTORY="$HOME/Downloads"
    mkdir -p "$HISTORY_DIRECTORY"
    HISTORY_TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
    HISTORY_OUTPUT="$HISTORY_DIRECTORY/sherlock-codex-history-$HISTORY_TIMESTAMP.zip"
    HISTORY_SUFFIX=1
    while [ -e "$HISTORY_OUTPUT" ]; do
      HISTORY_OUTPUT="$HISTORY_DIRECTORY/sherlock-codex-history-$HISTORY_TIMESTAMP-$HISTORY_SUFFIX.zip"
      HISTORY_SUFFIX=$((HISTORY_SUFFIX + 1))
    done
  fi
  set -- \
    --codex-home "$CODEX_HOME" \
    --output "$HISTORY_OUTPUT" \
    --acknowledge-sensitive-data
  if [ -n "$HISTORY_WORKERS" ]; then
    set -- "$@" --workers "$HISTORY_WORKERS"
  fi
  SHERLOCK_COLLECTOR_SOURCE="$REPO_ROOT/packages/telemetry-collector/src" \
    "$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/export_history.py" "$@"
fi

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install.py" \
  --endpoint "$ENDPOINT" \
  --codex-home "$CODEX_HOME" \
  --name "$NAME" \
  --github-id "$GITHUB_ID" \
  --email "$EMAIL"

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/install_marketplace.py" \
  --codex-bin "$CODEX_BIN" \
  --repo-root "$REPO_ROOT"
"$CODEX_BIN" plugin add sherlock@sherlock --json >/dev/null

"$PYTHON_BIN" "$REPO_ROOT/plugins/sherlock/scripts/trust_hooks.py" \
  --codex-bin "$CODEX_BIN" \
  --codex-home "$CODEX_HOME" \
  --cwd "$REPO_ROOT"

if [ "$HISTORY_MODE" = "upload" ]; then
  if ! "$PYTHON_BIN" "$CODEX_HOME/sherlock/bin/upload-history" \
      --codex-home "$CODEX_HOME" \
      --workers "$UPLOAD_WORKERS" \
      "$HISTORY_OUTPUT"; then
    echo "Sherlock history upload failed; the verified archive was kept: $HISTORY_OUTPUT" >&2
    echo "Retry with the installed command: $CODEX_HOME/sherlock/bin/upload-history $HISTORY_OUTPUT" >&2
    exit 1
  fi
  echo "Sherlock history upload completed: $HISTORY_OUTPUT"
elif [ "$HISTORY_MODE" = "export" ]; then
  echo "Sherlock history archive ready for administrator handoff: $HISTORY_OUTPUT"
fi

echo "Sherlock is installed. Start a new Codex task to load its hooks."
