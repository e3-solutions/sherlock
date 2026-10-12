from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Mapping

from .config import ConfigurationError, default_claude_home, load_config
from .discovery import CLAUDE_DEFAULT_LOOKBACK_SECONDS
from .spool import _atomic_json, secure_lock


CATCHUP_INTERVAL_SECONDS = 60
CATCHUP_EVENTS = {"SessionStart", "PostToolUse", "Stop"}
IDENTITY_ENVIRONMENT = {
    "SHERLOCK_CONFIG_PATH", "SHERLOCK_NAME", "SHERLOCK_GITHUB_ID",
    "SHERLOCK_EMAIL", "SHERLOCK_INSTALLATION_ID", "SHERLOCK_INGEST_URL",
}


def schedule_claude_catchup(
    event_name: str,
    *,
    codex_config: Path,
    environment: Mapping[str, str],
    claude_home: Path | None = None,
) -> str:
    """Wake Claude's own replay/drain from Codex, without inventing lineage."""
    if event_name not in CATCHUP_EVENTS:
        return "unsupported_hook"
    if environment.get("SHERLOCK_CLAUDE_CATCHUP_ENABLED", "1") != "1":
        return "disabled"
    home = Path(claude_home or default_claude_home()).expanduser().resolve()
    config = home / "sherlock" / "collector.json"
    try:
        if not codex_config.is_file() or not config.is_file():
            return "not_configured"
        codex = load_config(codex_config, use_environment=False)
        claude = load_config(config, use_environment=False)
        if codex.identity.email != claude.identity.email:
            return "identity_mismatch"
        settings_path = home / "settings.json"
        if settings_path.exists():
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            if settings.get("enabledPlugins", {}).get("sherlock-claude-code@sherlock") is False:
                return "disabled"
        root = home / "sherlock" / "telemetry"
        state = root / "codex-claude-catchup.json"
        with secure_lock(root / "codex-claude-catchup.lock") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return "busy"
            now_ns = time.time_ns()
            try:
                previous = json.loads(state.read_text(encoding="utf-8"))
                last = previous.get("last_scheduled_ns")
            except (OSError, ValueError, AttributeError):
                last = None
            if event_name != "Stop" and isinstance(last, int) and not isinstance(last, bool):
                elapsed = now_ns - last
                if 0 <= elapsed < CATCHUP_INTERVAL_SECONDS * 1_000_000_000:
                    return "debounced"
            child_environment = dict(environment)
            # A sibling collector must retain its own endpoint and attribution,
            # even when Codex was launched with provider-specific overrides.
            for key in IDENTITY_ENVIRONMENT:
                child_environment.pop(key, None)
            child_environment["CLAUDE_CONFIG_DIR"] = str(home)
            subprocess.Popen(
                [sys.executable, "-m", "sherlock_collector.cli",
                 "--provider", "claude_code", "--claude-home", str(home),
                 "--state-root", str(root), "--config", str(config),
                 "backfill", "--lookback-seconds", str(CLAUDE_DEFAULT_LOOKBACK_SECONDS)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
                close_fds=True, env=child_environment,
            )
            _atomic_json(state, {"state_version": 1, "last_scheduled_ns": now_ns})
        return "scheduled"
    except (OSError, ValueError, AttributeError, ConfigurationError):
        # A secondary recovery path must never interrupt the Codex hook.
        return "unavailable"
