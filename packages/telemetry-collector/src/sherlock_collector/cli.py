from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .config import (
    ConfigurationError,
    default_codex_home,
    default_state_root,
    load_config,
)
from .drain import Drain
from .hook import capture_and_spawn_drain, run_hook
from .http import HttpTransport
from .rollout import RolloutCapturer
from .spool import DurableSpool


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="sherlock-collector")
    result.add_argument("--codex-home", type=Path)
    result.add_argument("--state-root", type=Path)
    result.add_argument("--config", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("rollout", nargs="+", type=Path)
    hook = commands.add_parser("hook")
    hook.add_argument("event_name")
    commands.add_parser("drain")
    return result


def _payload_from_stdin() -> dict[str, object]:
    try:
        value = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    codex_home = Path(
        args.codex_home or default_codex_home()
    ).expanduser().resolve()
    state_root = Path(
        args.state_root or default_state_root(codex_home)
    ).expanduser().resolve()
    spool = DurableSpool(state_root / "queue")
    source_root = str(Path(__file__).resolve().parents[1])
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONPATH": source_root
            + (
                f"{os.pathsep}{os.environ['PYTHONPATH']}"
                if os.environ.get("PYTHONPATH")
                else ""
            ),
            "CODEX_HOME": str(codex_home),
        }
    )
    if args.command == "capture":
        outcome = capture_and_spawn_drain(
            RolloutCapturer(state_root, spool),
            args.rollout,
            [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--codex-home",
                str(codex_home),
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(outcome), sort_keys=True))
        return 0 if not outcome.locked else 75
    if args.command == "hook":
        outcome = run_hook(
            args.event_name,
            _payload_from_stdin(),
            codex_home=codex_home,
            state_root=state_root,
            drain_command=[
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--codex-home",
                str(codex_home),
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(outcome), sort_keys=True))
        return 0
    try:
        configuration = load_config(args.config, codex_home=codex_home)
    except ConfigurationError as error:
        print(f"sherlock collector is not configured: {error}", file=sys.stderr)
        return 78
    outcome = Drain(
        spool,
        HttpTransport(configuration.endpoint, configuration.token),
    ).run()
    print(json.dumps(asdict(outcome), sort_keys=True))
    return 0 if not outcome.locked else 75


if __name__ == "__main__":
    raise SystemExit(main())
