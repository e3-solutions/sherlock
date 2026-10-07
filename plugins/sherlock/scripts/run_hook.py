#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from pathlib import Path


CODEX_SUCCESS_RESPONSE = {"continue": True}


def collector_source() -> Path | None:
    candidates = []
    if os.environ.get("SHERLOCK_COLLECTOR_SOURCE"):
        candidates.append(Path(os.environ["SHERLOCK_COLLECTOR_SOURCE"]))
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    candidates.append(codex_home / "sherlock" / "runtime")
    candidates.append(Path(__file__).resolve().parents[3] / "packages" / "telemetry-collector" / "src")
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if (resolved / "sherlock_collector" / "cli.py").is_file():
            return resolved
    return None


def main() -> int:
    event_name = sys.argv[1] if len(sys.argv) > 1 else ""
    response = dict(CODEX_SUCCESS_RESPONSE)
    if event_name == "SessionStart" and os.environ.get("E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED", "1") == "1":
        # Read once, then replay the identical bytes to telemetry. Emit guidance in
        # the parent; collector stdout is deliberately suppressed below.
        source_input = getattr(sys.stdin, "buffer", sys.stdin)
        raw = source_input.read()
        raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
        sys.stdin = io.TextIOWrapper(io.BytesIO(raw_bytes), encoding="utf-8")
        try:
            from collective_feedback import feedback_context

            context = feedback_context(json.loads(raw_bytes), event_name=event_name, agent="codex")
            if context:
                response["hookSpecificOutput"] = {
                    "hookEventName": "SessionStart", "additionalContext": context,
                }
        except Exception:
            pass  # Optional guidance cannot prevent telemetry or session startup.
    try:
        source = collector_source()
        if source is not None:
            sys.path.insert(0, str(source))
            arguments = []
            if os.environ.get("SHERLOCK_CONFIG_PATH"):
                arguments.extend(["--config", os.environ["SHERLOCK_CONFIG_PATH"]])
            arguments.extend(["hook", event_name])
            with contextlib.redirect_stdout(io.StringIO()):
                from sherlock_collector.cli import main as collector_main

                collector_main(arguments)
    except (Exception, SystemExit) as error:
        print(
            f"Sherlock telemetry capture failed ({type(error).__name__}): {error}",
            file=sys.stderr,
        )
    print(json.dumps(response, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
