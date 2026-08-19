from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .config import (
    ConfigurationError,
    default_claude_home,
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
    result.add_argument("--claude-home", type=Path)
    result.add_argument(
        "--provider", choices=("codex", "claude_code"), default="codex"
    )
    result.add_argument("--state-root", type=Path)
    result.add_argument("--config", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("rollout", nargs="+", type=Path)
    hook = commands.add_parser("hook")
    hook.add_argument("event_name")
    commands.add_parser("drain")
    commands.add_parser("health")
    return result


def _payload_from_stdin() -> dict[str, object]:
    try:
        value = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    source_home = Path(
        (args.claude_home or default_claude_home())
        if args.provider == "claude_code"
        else (args.codex_home or default_codex_home())
    ).expanduser().resolve()
    state_root = Path(
        args.state_root or default_state_root(source_home)
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
            (
                "CLAUDE_CONFIG_DIR"
                if args.provider == "claude_code"
                else "CODEX_HOME"
            ): str(source_home),
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
                *(["--claude-home", str(source_home)]
                    if args.provider == "claude_code"
                    else ["--codex-home", str(source_home)]),
                "--provider",
                args.provider,
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
            codex_home=source_home if args.provider == "codex" else None,
            claude_home=source_home if args.provider == "claude_code" else None,
            state_root=state_root,
            provider=args.provider,
            drain_command=[
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                *(["--claude-home", str(source_home)]
                    if args.provider == "claude_code"
                    else ["--codex-home", str(source_home)]),
                "--provider",
                args.provider,
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
        configuration = load_config(args.config, codex_home=source_home)
    except ConfigurationError as error:
        print(f"sherlock collector is not configured: {error}", file=sys.stderr)
        return 78
    if args.command == "health":
        print(
            json.dumps(
                {
                    "status": "ok",
                    "provider": args.provider,
                    "source_home": str(source_home),
                    "state_root": str(state_root),
                    "pending_batches": len(spool.list_pending()),
                    "dead_letter_batches": len(
                        list(spool.dead_letter.glob("*.json"))
                    ),
                },
                sort_keys=True,
            )
        )
        return 0
    outcome = Drain(
        spool,
        HttpTransport(
            configuration.endpoint,
            configuration.identity,
        ),
    ).run()
    print(json.dumps(asdict(outcome), sort_keys=True))
    return 0 if not outcome.locked else 75


if __name__ == "__main__":
    raise SystemExit(main())
