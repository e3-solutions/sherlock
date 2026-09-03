#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Replay one Claude session UUID or one bounded mtime range."
    )
    selectors = parser.add_mutually_exclusive_group(required=True)
    selectors.add_argument("--session-id")
    selectors.add_argument("--start")
    parser.add_argument("--end")
    args = parser.parse_args()
    if args.session_id is not None and args.end is not None:
        parser.error("--end requires --start")
    if args.start is not None and args.end is None:
        parser.error("--start requires --end")
    replay_arguments = (
        ["--session-id", args.session_id]
        if args.session_id is not None
        else ["--start", args.start, "--end", args.end]
    )
    claude_home = (
        Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
        .expanduser()
        .resolve()
    )
    runtime = claude_home / "sherlock" / "runtime"
    if not (runtime / "sherlock_collector" / "cli.py").is_file():
        print(
            "Sherlock's installed Claude collector runtime was not found.",
            file=sys.stderr,
        )
        return 78
    sys.path.insert(0, str(runtime))
    from sherlock_collector.cli import main as collector_main

    return collector_main(
        [
            "--provider",
            "claude_code",
            "--claude-home",
            str(claude_home),
            "--state-root",
            str(claude_home / "sherlock" / "telemetry"),
            "--config",
            os.environ.get(
                "SHERLOCK_CONFIG_PATH",
                str(claude_home / "sherlock" / "collector.json"),
            ),
            "backfill",
            *replay_arguments,
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main())
