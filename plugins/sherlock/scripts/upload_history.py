#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def collector_source(codex_home_override: Path | None = None) -> Path | None:
    candidates: list[Path] = []
    if os.environ.get("SHERLOCK_COLLECTOR_SOURCE"):
        candidates.append(Path(os.environ["SHERLOCK_COLLECTOR_SOURCE"]))
    codex_home = Path(
        codex_home_override
        or os.environ.get("CODEX_HOME")
        or Path.home() / ".codex"
    )
    candidates.append(
        Path(__file__).resolve().parents[3] / "packages" / "telemetry-collector" / "src"
    )
    candidates.append(codex_home / "sherlock" / "runtime")
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if (resolved / "sherlock_collector" / "cli.py").is_file():
            return resolved
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify and upload a Sherlock Codex-history ZIP."
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument(
        "--workers",
        type=int,
        default=16,
        help="Parallel upload workers (1-16; default: 16).",
    )
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--no-resume", action="store_true")
    args = parser.parse_args()
    source = collector_source(args.codex_home)
    if source is None:
        print("Sherlock collector runtime is not installed", file=sys.stderr)
        return 78
    sys.path.insert(0, str(source))
    from sherlock_collector.cli import main as collector_main

    global_args: list[str] = []
    if args.codex_home:
        global_args.extend(["--codex-home", str(args.codex_home)])
    if args.state_root:
        global_args.extend(["--state-root", str(args.state_root)])
    if args.config:
        global_args.extend(["--config", str(args.config)])
    command_args = [
        "backfill-upload",
        str(args.archive),
        "--workers",
        str(args.workers),
        "--retries",
        str(args.retries),
    ]
    if args.state:
        command_args.extend(["--state", str(args.state)])
    if args.no_resume:
        command_args.append("--no-resume")
    return collector_main([*global_args, *command_args])


if __name__ == "__main__":
    raise SystemExit(main())
