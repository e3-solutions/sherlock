"""Cursor IDE/CLI native hook observations; never infer transcript or token facts."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import load_config
from .contract import ContractError, build_source_batch
from .drain import Drain
from .http import HttpTransport
from .spool import DurableSpool

EVENTS = frozenset({
    "sessionStart", "sessionEnd", "beforeSubmitPrompt", "postToolUse",
    "postToolUseFailure", "subagentStart", "subagentStop", "stop",
    "afterAgentResponse", "afterAgentThought", "preCompact",
})
MAX_HOOK_BYTES = 2 * 1024 * 1024


def text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def capture(event: str, raw: bytes, spool: DurableSpool) -> Path:
    if event not in EVENTS or not raw or len(raw) > MAX_HOOK_BYTES:
        raise ContractError("unsupported or oversized Cursor hook")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ContractError("Cursor hook must be an object")
    if payload.get("hook_event_name") not in (None, event):
        raise ContractError("Cursor hook dispatch mismatch")
    conversation = text(payload.get("conversation_id"))
    if conversation is None:
        raise ContractError("Cursor conversation_id is required")
    parent = None
    native = "cursor:" + conversation
    if event in {"subagentStart", "subagentStop"}:
        child = text(payload.get("subagent_id"))
        if child is None:
            raise ContractError("Cursor subagent_id is required")
        parent = "cursor:" + (text(payload.get("parent_conversation_id")) or conversation)
        native = parent + ":subagent:" + child
    observation_id = str(uuid.uuid4())
    observation = {
        "type": "cursor_hook",
        "schema_version": "sherlock.cursor-hook.v1",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "observation_id": observation_id,
        "dispatch_event_name": event,
        "payload_sha256": hashlib.sha256(raw).hexdigest(),
        "payload_base64": base64.b64encode(raw).decode("ascii"),
    }
    source = (json.dumps(observation, separators=(",", ":")) + "\n").encode()
    # Each hook invocation is an independent immutable source observation.
    # Retries reuse the spooled object; identical separate invocations stay distinct.
    manifest, stored = build_source_batch(
        source, source_stream_key="cursor-hook-" + observation_id,
        generation_key=observation_id, generation_seq=0, start_offset=0,
        source_provider="cursor", source_kind="hook",
        observed_native_session_id=native,
        observed_parent_native_session_id=parent,
        source_version=text(payload.get("cursor_version")), collector_version="0.1.0",
    )
    return spool.enqueue(manifest, stored, workload_class="live")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("event", choices=[*sorted(EVENTS), "drain"])
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    try:
        config = load_config(home / "sherlock" / "collector.json", codex_home=home)
        spool = DurableSpool(home / "sherlock" / "telemetry" / "queue")
        if args.event == "drain":
            Drain(spool, HttpTransport(config.endpoint, config.identity)).run()
        else:
            capture(args.event, sys.stdin.buffer.read(MAX_HOOK_BYTES + 1), spool)
            # Network work never delays or changes the agent's response.
            subprocess.Popen(
                [sys.executable, "-m", "sherlock_collector.cursor_hook",
                 "--home", str(home), "drain"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
                env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent)},
            )
    except Exception as error:
        print(f"Sherlock Cursor capture failed: {type(error).__name__}", file=sys.stderr)
    # These hooks observe only; explicitly allow hooks that have permission output.
    if args.event == "subagentStart":
        print('{"permission":"allow"}')
    elif args.event == "beforeSubmitPrompt":
        print('{"continue":true}')
    elif args.event != "drain":
        print('{}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
