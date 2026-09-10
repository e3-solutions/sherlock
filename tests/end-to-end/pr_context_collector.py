"""Synthetic native transcripts; uses the installed collector's real durable spool."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool


def main() -> None:
    root, provider, native_id, started_at, sha = sys.argv[1:]
    directory = Path(root)
    directory.mkdir(parents=True, exist_ok=True)
    if provider == "codex":
        records = [
            {"timestamp": started_at, "type": "session_meta", "payload": {
                "id": native_id, "source": "cli", "cwd": "/synthetic/shared-checkout",
                "git": {"repository_url": "https://github.com/e3-solutions/sherlock.git",
                        "branch": "reused-branch", **({"commit_hash": sha} if sha else {})},
            }},
            {"timestamp": started_at, "type": "event_msg", "payload": {
                "type": "user_message", "message": "Review this change without making commits", "turn_id": "fixture-turn",
            }},
            {"timestamp": started_at, "type": "event_msg", "payload": {
                "type": "agent_message", "message": "Review complete", "turn_id": "fixture-turn",
            }},
        ]
    else:
        records = [
            {"sessionId": native_id, "timestamp": started_at, "type": "user", "uuid": "fixture-user",
             "cwd": "/synthetic/shared-checkout", "gitBranch": "reused-branch",
             "message": {"role": "user", "content": "Review this change without making commits"}},
            {"sessionId": native_id, "timestamp": started_at, "type": "assistant", "uuid": "fixture-answer",
             "parentUuid": "fixture-user", "requestId": "fixture-request", "message": {
                 "id": "fixture-message", "role": "assistant", "model": "claude-sonnet-4",
                 "content": [{"type": "text", "text": "Review complete"}], "stop_reason": "end_turn",
                 "usage": {"input_tokens": 2, "output_tokens": 1}}},
        ]
    raw = b"".join((json.dumps(record, separators=(",", ":")) + "\n").encode() for record in records)
    transcript = directory / "native.jsonl"
    transcript.write_bytes(raw)
    capturer = RolloutCapturer(directory / "state", DurableSpool(directory / "state" / "queue"), source_provider=provider,
                              source_kind="rollout" if provider == "codex" else "transcript")
    capturer.capture([transcript], native_session_ids={str(transcript): native_id})
    assert transcript.read_bytes() == raw, "collector changed the native transcript"
    print(json.dumps({"path": str(transcript), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}))


if __name__ == "__main__":
    main()
