#!/usr/bin/env python3
"""Preparation-only JR hook. No registration, installation, or update effects."""
from __future__ import annotations

import contextlib
import functools
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "telemetry-collector" / "src"
EVENTS = {
    "codex": {"SessionStart", "UserPromptSubmit", "PostToolUse", "PostCompact", "SubagentStart", "SubagentStop", "Stop"},
    "claude": {"SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"},
}


def capture(provider: str, event: str, payload: bytes, state: Path) -> None:
    # Entry is launched with Python -I. The detached collector CLI must also
    # prefer this immutable bundle, never a separately updated home runtime.
    os.environ["PYTHONPATH"] = str(SOURCE)
    for variable in ("SHERLOCK_COLLECTOR_SOURCE", "PYTHONHOME", "PYTHONSTARTUP"):
        os.environ.pop(variable, None)
    os.environ["PYTHONNOUSERSITE"] = "1"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SOURCE))
    if provider == "claude":
        path = ROOT / "plugins" / "sherlock-claude-code" / "scripts" / "run_hook.py"
        spec = importlib.util.spec_from_file_location("sherlock_bundled_claude", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.collector_source = lambda: SOURCE
        module.capture = functools.partial(module.capture, state_root=state)
        # Native terminal settling + detachment remain unchanged. Success only
        # establishes dispatch attempted; it does not acknowledge durable work.
        module.dispatch(event, payload_bytes=payload)
        return
    from sherlock_collector.cli import main as collector_main

    args = ["--provider", "codex", "--state-root", str(state)]
    if os.environ.get("SHERLOCK_CONFIG_PATH"):
        args += ["--config", os.environ["SHERLOCK_CONFIG_PATH"]]
    args += ["hook", event]
    sys.stdin = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()):
        collector_main(args)


def main() -> int:
    status = "skipped"
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("oversized envelope")
        envelope = json.loads(raw)
        if (not isinstance(envelope, dict) or type(envelope.get("schema_version")) is not int
                or envelope["schema_version"] != 1):
            raise ValueError("invalid envelope")
        if (os.environ.get("JOLLY_ROGER_MANAGED") != "1"
                or os.environ.get("JOLLY_ROGER_COMPONENT_ID") != "sherlock"):
            raise ValueError("managed environment required")
        provider = os.environ["JOLLY_ROGER_PROVIDER"]
        event = envelope["event"]
        if envelope.get("provider") != provider or event not in EVENTS.get(provider, set()):
            raise ValueError("unsupported provider/event")
        payload = envelope["payload"]
        if not isinstance(payload, dict):
            raise ValueError("invalid native payload")
        states = json.loads(os.environ["JOLLY_ROGER_STATE_PATHS"])
        if set(states) != {"codex-telemetry", "claude-telemetry"}:
            raise ValueError("invalid state mapping")
        state = states[f"{provider}-telemetry"]
        if not isinstance(state, str) or not Path(state).is_absolute():
            raise ValueError("state mapping must be absolute")
        capture(provider, event, json.dumps(payload).encode("utf-8"), Path(state))
        status = "ok"
    except (Exception, SystemExit):
        # No exception text: configuration and payload can contain private data.
        print("Sherlock managed hook skipped or failed; inspect local collector state.", file=sys.stderr)
    print(json.dumps({"status": status}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
