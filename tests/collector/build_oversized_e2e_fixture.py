from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sherlock_collector.contract import FRAGMENT_BYTES
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool


def compact(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    session_id = "oversized-e2e-session"
    turn_id = "oversized-e2e-turn"
    started_at = datetime.now(timezone.utc).replace(microsecond=0)
    timestamps = [
        (started_at + timedelta(seconds=offset)).isoformat().replace("+00:00", "Z")
        for offset in range(3)
    ]
    # The largest rollout record measured while scoping COR-3629.
    target_bytes = 72_591_045
    prefix = (
        f'{{"timestamp":"{timestamps[0]}","type":"compacted",'
        '"payload":{"type":"compacted","replacement_history":"'
    ).encode()
    suffix = b'"}}\n'
    if target_bytes <= len(prefix) + len(suffix):
        raise AssertionError("oversized fixture target is too small")
    oversized = prefix + b"x" * (target_bytes - len(prefix) - len(suffix)) + suffix
    ordinary = b"".join(
        [
            compact(
                {
                    "timestamp": timestamps[0],
                    "type": "session_meta",
                    "payload": {
                        "id": session_id,
                        "source": "cli",
                        "title": "Oversized E2E",
                    },
                }
            ),
            compact(
                {
                    "timestamp": timestamps[0],
                    "type": "event_msg",
                    "payload": {"type": "turn_started", "turn_id": turn_id},
                }
            ),
            compact(
                {
                    "timestamp": timestamps[1],
                    "type": "event_msg",
                    "payload": {
                        "type": "agent_message",
                        "turn_id": turn_id,
                        "message": "activity after the oversized record",
                    },
                }
            ),
            compact(
                {
                    "timestamp": timestamps[2],
                    "type": "event_msg",
                    "payload": {"type": "turn_complete", "turn_id": turn_id},
                }
            ),
        ]
    )
    rollout = root / "rollout.jsonl"
    rollout.write_bytes(oversized + ordinary)
    spool = DurableSpool(root / "spool")
    capturer = RolloutCapturer(root / "state", spool, chunk_bytes=128 * 1024)
    native_sessions = {str(rollout): session_id}

    first = capturer.capture(
        [rollout],
        native_session_ids=native_sessions,
        max_sync_bytes=1024 * 1024,
    )
    expected_fragments = (len(oversized) + FRAGMENT_BYTES - 1) // FRAGMENT_BYTES
    if first.enqueued != expected_fragments or first.captured_bytes != len(oversized):
        raise AssertionError(
            "the first capture did not publish the complete fragment set"
        )
    second = capturer.capture([rollout], native_session_ids=native_sessions)
    if second.enqueued != 1 or second.captured_bytes != len(ordinary):
        raise AssertionError("the second capture did not resume with ordinary records")

    print(
        json.dumps(
            {
                "rollout_path": str(rollout),
                "spool_path": str(spool.root),
                "session_id": session_id,
                "turn_id": turn_id,
                "oversized_bytes": len(oversized),
                "oversized_sha256": hashlib.sha256(oversized).hexdigest(),
                "ordinary_bytes": len(ordinary),
                "fragment_count": expected_fragments,
                "total_bytes": len(oversized) + len(ordinary),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
