#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def collector_source() -> Path | None:
    candidates: list[Path] = []
    if os.environ.get("SHERLOCK_COLLECTOR_SOURCE"):
        candidates.append(Path(os.environ["SHERLOCK_COLLECTOR_SOURCE"]))
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
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
        description="Export all local Codex session rollouts to a verified Sherlock ZIP."
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--workers", type=int)
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--acknowledge-sensitive-data",
        action="store_true",
        help="Confirm that prompts, responses, tool data, and secrets may be included.",
    )
    args = parser.parse_args()
    source = collector_source()
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
    command_args = ["backfill-export", "--output", str(args.output)]
    if args.workers is not None:
        command_args.extend(["--workers", str(args.workers)])
    if args.acknowledge_sensitive_data:
        command_args.append("--acknowledge-sensitive-data")
    if args.force:
        command_args.append("--force")
    return collector_main([*global_args, *command_args])


if __name__ == "__main__":
    raise SystemExit(main())
