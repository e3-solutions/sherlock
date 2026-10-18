#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


PLUGIN_ID = "sherlock-claude-code@sherlock"


def main() -> int:
    claude_home = Path(
        os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")
    ).expanduser().resolve()
    settings_path = claude_home / "settings.json"
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"Claude settings are unreadable: {error}", file=sys.stderr)
        return 1
    enabled = settings.get("enabledPlugins") if isinstance(settings, dict) else None
    if not isinstance(enabled, dict) or enabled.get(PLUGIN_ID) is not True:
        print(f"Claude plugin is not enabled: {PLUGIN_ID}", file=sys.stderr)
        return 1
    runtime = claude_home / "sherlock" / "runtime"
    source = Path(__file__).resolve().parents[3] / "packages" / "telemetry-collector" / "src"
    sys.path.insert(0, str(runtime if runtime.is_dir() else source))
    try:
        from sherlock_collector.scheduler import scheduler_status
        scheduler = scheduler_status(claude_home, check_loaded=True)
    except ImportError:
        scheduler = {"status": "runtime_missing"}
    scheduler_ok = scheduler.get("status") in {"installed", "disabled"}
    print(
        json.dumps(
            {
                "status": "ok" if scheduler_ok else "degraded",
                "scheduler": scheduler,
                "check": "local_plugin_enabled",
                "plugin": PLUGIN_ID,
            },
            sort_keys=True,
        )
    )
    return 0 if scheduler_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
