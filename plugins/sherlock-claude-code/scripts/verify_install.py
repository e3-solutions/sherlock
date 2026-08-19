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
    print(
        json.dumps(
            {
                "status": "ok",
                "check": "local_plugin_enabled",
                "plugin": PLUGIN_ID,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
