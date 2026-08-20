from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sherlock_collector.contract import FRAGMENT_BYTES
from sherlock_collector.discovery import discover_claude_transcripts
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool


MEASURED_MAXIMUM_RECORD_BYTES = 72_591_045


def compact(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def measured_record(prefix: bytes, suffix: bytes) -> bytes:
    if MEASURED_MAXIMUM_RECORD_BYTES <= len(prefix) + len(suffix):
        raise AssertionError("oversized fixture target is too small")
    result = (
        prefix
        + b"x" * (MEASURED_MAXIMUM_RECORD_BYTES - len(prefix) - len(suffix))
        + suffix
    )
    if len(result) != MEASURED_MAXIMUM_RECORD_BYTES:
        raise AssertionError("oversized fixture has the wrong byte size")
    return result


def timestamps(count: int) -> list[str]:
    now = datetime.now(timezone.utc)
    previous_bucket_start = (int(now.timestamp()) // (10 * 60) - 1) * (10 * 60)
    started_at = datetime.fromtimestamp(
        previous_bucket_start + 60,
        tz=timezone.utc,
    )
    return [
        (started_at + timedelta(seconds=offset)).isoformat().replace("+00:00", "Z")
        for offset in range(count)
    ]


def build_codex_fixture(root: Path) -> dict[str, object]:
    session_id = "oversized-e2e-session"
    turn_id = "oversized-e2e-turn"
    observed_at = timestamps(4)
    oversized = measured_record(
        (
            f'{{"timestamp":"{observed_at[0]}","type":"compacted",'
            '"payload":{"type":"compacted","replacement_history":"'
        ).encode(),
        b'"}}\n',
    )
    ordinary = b"".join(
        [
            compact(
                {
                    "timestamp": observed_at[0],
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
                    "timestamp": observed_at[0],
                    "type": "event_msg",
                    "payload": {"type": "turn_started", "turn_id": turn_id},
                }
            ),
            compact(
                {
                    "timestamp": observed_at[1],
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
                    "timestamp": observed_at[2],
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
        raise AssertionError("the first capture did not publish every fragment")
    second = capturer.capture([rollout], native_session_ids=native_sessions)
    if second.enqueued != 1 or second.captured_bytes != len(ordinary):
        raise AssertionError("the second capture did not resume ordinary records")
    return {
        "provider": "codex",
        "rollout_path": str(rollout),
        "spool_path": str(spool.root),
        "session_id": session_id,
        "turn_id": turn_id,
        "oversized_bytes": len(oversized),
        "oversized_sha256": hashlib.sha256(oversized).hexdigest(),
        "ordinary_bytes": len(ordinary),
        "fragment_count": expected_fragments,
        "total_bytes": len(oversized) + len(ordinary),
        "source_file_count": 1,
    }


def build_claude_fixture(root: Path) -> dict[str, object]:
    primary_id = "11111111-1111-4111-8111-111111111111"
    subagent_id = "worker-oversized-e2e"
    prompt_id = "prompt-after-oversized"
    worker_prompt_id = "worker-prompt-after-oversized"
    observed_at = timestamps(8)
    oversized = measured_record(
        (
            f'{{"sessionId":"{primary_id}","type":"assistant",'
            f'"uuid":"oversized-envelope","timestamp":"{observed_at[0]}",'
            '"customTitle":"fragment poison","cwd":"/fragment-poison",'
            '"gitBranch":"fragment-poison",'
            '"message":{"id":"oversized-message","role":"assistant",'
            '"model":"fragment-poison-model",'
            '"content":[{"type":"text","text":"'
        ).encode(),
        b'"}]}}\n',
    )
    ordinary = b"".join(
        [
            compact(
                {
                    "sessionId": primary_id,
                    "promptId": prompt_id,
                    "type": "user",
                    "uuid": "primary-user",
                    "parentUuid": None,
                    "timestamp": observed_at[1],
                    "message": {
                        "role": "user",
                        "content": "activity after the oversized Claude record",
                    },
                }
            ),
            compact(
                {
                    "sessionId": primary_id,
                    "type": "assistant",
                    "uuid": "primary-tool-call",
                    "parentUuid": "primary-user",
                    "requestId": "primary-request",
                    "timestamp": observed_at[2],
                    "message": {
                        "id": "primary-message",
                        "role": "assistant",
                        "model": "claude-sonnet-4",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "oversized-tool",
                                "name": "Read",
                                "input": {},
                            }
                        ],
                        "stop_reason": "tool_use",
                        "usage": {"input_tokens": 2, "output_tokens": 1},
                    },
                }
            ),
            compact(
                {
                    "sessionId": primary_id,
                    "promptId": prompt_id,
                    "type": "user",
                    "uuid": "primary-tool-result",
                    "parentUuid": "primary-tool-call",
                    "timestamp": observed_at[3],
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "oversized-tool",
                                "content": "synthetic result",
                            }
                        ],
                    },
                }
            ),
            compact(
                {
                    "sessionId": primary_id,
                    "type": "assistant",
                    "uuid": "primary-answer",
                    "parentUuid": "primary-tool-result",
                    "requestId": "primary-answer-request",
                    "timestamp": observed_at[4],
                    "message": {
                        "id": "primary-answer-message",
                        "role": "assistant",
                        "model": "claude-sonnet-4",
                        "content": [
                            {
                                "type": "text",
                                "text": "Claude activity survived oversized input.",
                            }
                        ],
                        "stop_reason": "end_turn",
                        "usage": {"input_tokens": 3, "output_tokens": 4},
                    },
                }
            ),
        ]
    )
    subagent = b"".join(
        [
            compact(
                {
                    "sessionId": primary_id,
                    "agentId": subagent_id,
                    "isSidechain": True,
                    "promptId": worker_prompt_id,
                    "type": "user",
                    "uuid": "worker-user",
                    "parentUuid": "primary-answer",
                    "timestamp": observed_at[5],
                    "message": {
                        "role": "user",
                        "content": "subagent after oversized input",
                    },
                }
            ),
            compact(
                {
                    "sessionId": primary_id,
                    "agentId": subagent_id,
                    "isSidechain": True,
                    "type": "assistant",
                    "uuid": "worker-answer",
                    "parentUuid": "worker-user",
                    "requestId": "worker-request",
                    "timestamp": observed_at[6],
                    "message": {
                        "id": "worker-message",
                        "role": "assistant",
                        "model": "claude-sonnet-4",
                        "content": [
                            {"type": "text", "text": "Subagent activity survived."}
                        ],
                        "stop_reason": "end_turn",
                        "usage": {"input_tokens": 1, "output_tokens": 2},
                    },
                }
            ),
        ]
    )
    claude_home = root / "claude"
    project = claude_home / "projects" / "repo"
    primary = project / f"{primary_id}.jsonl"
    worker = project / primary_id / "subagents" / f"agent-{subagent_id}.jsonl"
    worker.parent.mkdir(parents=True, exist_ok=True)
    primary.write_bytes(oversized + ordinary)
    worker.write_bytes(subagent)
    discovery = discover_claude_transcripts(
        claude_home,
        hook_payload={
            "session_id": primary_id,
            "transcript_path": str(primary),
        },
        lookback_seconds=24 * 60 * 60,
    )
    spool = DurableSpool(root / "spool")
    capturer = RolloutCapturer(
        root / "state",
        spool,
        chunk_bytes=128 * 1024,
        source_provider="claude_code",
        source_kind="transcript",
        source_version="2.0.59",
        state_name="claude-transcript",
        capture_unterminated_tail=False,
        allowed_root=claude_home / "projects",
    )
    capture_options = {
        "native_session_ids": discovery.native_session_ids,
        "parent_native_session_ids": discovery.parent_native_session_ids,
        "source_snapshots": discovery.source_snapshots,
        "priority_count": discovery.priority_count,
        "priority_workload_class": "live",
        "backlog_workload_class": "backfill",
    }
    first = capturer.capture(
        discovery.paths,
        max_files=1,
        max_sync_bytes=1024 * 1024,
        **capture_options,
    )
    expected_fragments = (len(oversized) + FRAGMENT_BYTES - 1) // FRAGMENT_BYTES
    if first.enqueued != expected_fragments or first.captured_bytes != len(oversized):
        raise AssertionError("Claude did not publish the complete fragment set")
    second = capturer.capture(discovery.paths, **capture_options)
    if second.enqueued != 2 or second.captured_bytes != len(ordinary) + len(subagent):
        raise AssertionError("Claude did not resume primary and subagent records")
    return {
        "provider": "claude_code",
        "rollout_path": str(primary),
        "subagent_path": str(worker),
        "spool_path": str(spool.root),
        "session_id": primary_id,
        "subagent_session_id": subagent_id,
        "prompt_id": prompt_id,
        "turn_id": f"claude:prompt:{prompt_id}",
        "oversized_bytes": len(oversized),
        "oversized_sha256": hashlib.sha256(oversized).hexdigest(),
        "ordinary_bytes": len(ordinary) + len(subagent),
        "fragment_count": expected_fragments,
        "total_bytes": len(oversized) + len(ordinary) + len(subagent),
        "primary_bytes": len(oversized) + len(ordinary),
        "subagent_bytes": len(subagent),
        "source_file_count": 2,
    }


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    provider = sys.argv[2] if len(sys.argv) > 2 else "codex"
    root.mkdir(parents=True, exist_ok=True)
    if provider == "codex":
        result = build_codex_fixture(root)
    elif provider == "claude_code":
        result = build_claude_fixture(root)
    else:
        raise SystemExit(f"unsupported provider: {provider}")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
