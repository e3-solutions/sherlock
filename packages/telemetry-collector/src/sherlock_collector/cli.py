from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .drain import Drain
from .hook import capture_and_spawn_drain
from .http import HttpTransport
from .rollout import RolloutCapturer
from .spool import DurableSpool


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="sherlock-collector")
    result.add_argument("--state-root", type=Path, required=True)
    commands = result.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("rollout", nargs="+", type=Path)
    commands.add_parser("drain")
    return result


def main() -> int:
    args = parser().parse_args()
    spool = DurableSpool(args.state_root / "queue")
    if args.command == "capture":
        outcome = capture_and_spawn_drain(
            RolloutCapturer(args.state_root, spool),
            args.rollout,
            [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--state-root",
                str(args.state_root),
                "drain",
            ],
        )
        print(json.dumps(asdict(outcome), sort_keys=True))
        return 0 if not outcome.locked else 75
    endpoint = os.environ["SHERLOCK_INGEST_URL"]
    credential = os.environ["SHERLOCK_INGEST_TOKEN"]
    outcome = Drain(spool, HttpTransport(endpoint, credential)).run()
    print(json.dumps(asdict(outcome), sort_keys=True))
    return 0 if not outcome.locked else 75


if __name__ == "__main__":
    raise SystemExit(main())
