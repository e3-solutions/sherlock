#!/usr/bin/env python3
"""Verify the local collector and report periodic collection configuration."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    home = (
        Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
        .expanduser()
        .resolve()
    )
    runtime = home / "sherlock" / "runtime"
    source = (
        Path(__file__).resolve().parents[3] / "packages" / "telemetry-collector" / "src"
    )
    sys.path.insert(0, str(runtime if runtime.is_dir() else source))
    try:
        from sherlock_collector.config import ConfigurationError, load_config
        from sherlock_collector.scheduler import scheduler_status
        from sherlock_collector.spool import DurableSpool
    except ImportError:
        print(json.dumps({"status": "degraded", "reason": "runtime_missing"}))
        return 1
    try:
        load_config(codex_home=home)
        configuration = "ok"
    except ConfigurationError as error:
        configuration = str(error)
    scheduler = scheduler_status(home, check_loaded=True)
    try:
        upload = DurableSpool(home / "sherlock" / "telemetry" / "queue").upload_status()
    except (OSError, ValueError) as error:
        upload = {"status": "unreadable", "reason": str(error)}
    ok = (
        upload["status"] == "ready"
        and configuration == "ok"
        and scheduler.get("status") in {"installed", "disabled"}
    )
    print(
        json.dumps(
            {
                "status": "ok" if ok else "degraded",
                "configuration": configuration,
                "upload": upload,
                "scheduler": scheduler,
            },
            sort_keys=True,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
