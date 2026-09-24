#!/bin/sh
set -eu
REPO_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "${PYTHON_BIN:-python3}" "$REPO_ROOT/plugins/sherlock-cursor/scripts/install.py" "$@"
