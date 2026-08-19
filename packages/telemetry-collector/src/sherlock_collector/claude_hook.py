from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

from .contract import ContractError, MAX_SOURCE_BYTES
from .spool import _atomic_json


SCHEMA_VERSION = "sherlock.claude-hook.v1"
TERMINAL_EVENTS = {"Stop", "SubagentStop", "SessionEnd"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _canonical_uuid(value: object) -> str | None:
    candidate = _text(value)
    if candidate is None:
        return None
    try:
        parsed = uuid.UUID(candidate)
    except (ValueError, AttributeError):
        return None
    canonical = str(parsed)
    return canonical if candidate.lower() == canonical else None


def _message_text(content: object) -> str | None:
    if isinstance(content, str):
        return content if content.strip() else None
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        if item.get("type") not in {"input_text", "output_text", "text"}:
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text)
    return "\n".join(parts) if parts else None


def _is_submitted_user(record: Mapping[str, object]) -> bool:
    if record.get("type") != "user" or record.get("isMeta") is True:
        return False
    message = record.get("message")
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if _message_text(content) is None:
        return False
    return not (
        isinstance(content, list)
        and any(
            isinstance(item, dict) and item.get("type") == "tool_result"
            for item in content
        )
    )


def _transcript_anchor(
    transcript: bytes,
    last_assistant_message: object,
) -> tuple[str | None, str | None]:
    expected = _text(last_assistant_message)
    records: list[dict[str, object]] = []
    for line in transcript.splitlines():
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            records.append(value)
    by_uuid = {
        value: record
        for record in records
        if (value := _text(record.get("uuid"))) is not None
    }
    terminal: dict[str, object] | None = None
    for record in reversed(records):
        if record.get("type") == "assistant":
            terminal = record
            break
    if terminal is None:
        return None, None
    message = terminal.get("message")
    if not isinstance(message, dict):
        return None, None
    content = message.get("content")
    rendered = _message_text(content)
    if rendered is None or (expected is not None and rendered != expected):
        return None, None
    if isinstance(content, list) and any(
        isinstance(item, dict) and item.get("type") == "tool_use"
        for item in content
    ):
        return None, None
    terminal_uuid = _canonical_uuid(terminal.get("uuid"))
    if terminal_uuid is None:
        return None, None

    current: dict[str, object] | None = terminal
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        prompt_id = _canonical_uuid(
            current.get("promptId", current.get("prompt_id"))
        )
        if prompt_id is not None:
            return terminal_uuid, prompt_id
        if _is_submitted_user(current):
            user_uuid = _canonical_uuid(current.get("uuid"))
            if user_uuid is not None:
                return terminal_uuid, user_uuid
        parent_uuid = _text(
            current.get("parentUuid", current.get("parent_uuid"))
        )
        current = by_uuid.get(parent_uuid) if parent_uuid is not None else None
    return terminal_uuid, None


def referenced_transcript(
    claude_home: Path,
    event_name: str,
    payload: Mapping[str, object],
) -> Path | None:
    key = "agent_transcript_path" if event_name == "SubagentStop" else "transcript_path"
    value = _text(payload.get(key))
    if value is None:
        return None
    projects = (claude_home / "projects").resolve()
    candidate = Path(value).expanduser().resolve()
    try:
        candidate.relative_to(projects)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def write_observation(
    state_root: Path,
    event_name: str,
    payload: Mapping[str, object],
    raw_payload: bytes,
    *,
    transcript_path: Path | None,
) -> Path:
    if event_name not in TERMINAL_EVENTS:
        raise ValueError("unsupported Claude terminal hook event")
    if not raw_payload:
        raise ValueError("Claude hook payload must not be empty")

    session_id = _text(payload.get("session_id"))
    agent_id = _text(payload.get("agent_id"))
    native_session_id = agent_id if event_name == "SubagentStop" else session_id
    parent_native_session_id = session_id if event_name == "SubagentStop" else None
    transcript_sha256 = None
    transcript_byte_count = None
    terminal_assistant_uuid = None
    turn_anchor_id = None
    if transcript_path is not None:
        transcript = transcript_path.read_bytes()
        transcript_sha256 = hashlib.sha256(transcript).hexdigest()
        transcript_byte_count = len(transcript)
        if event_name in {"Stop", "SubagentStop"}:
            terminal_assistant_uuid, turn_anchor_id = _transcript_anchor(
                transcript,
                payload.get("last_assistant_message"),
            )

    observation: dict[str, object] = {
        "type": "claude_hook",
        "schema_version": SCHEMA_VERSION,
        "collector_observed_at": _utc_now(),
        "dispatch_event_name": event_name,
        "payload_sha256": hashlib.sha256(raw_payload).hexdigest(),
        "payload_base64": base64.b64encode(raw_payload).decode("ascii"),
        "native_session_id": native_session_id,
        "parent_native_session_id": parent_native_session_id,
        "terminal_assistant_uuid": terminal_assistant_uuid,
        "turn_anchor_id": turn_anchor_id,
        "transcript_byte_count": transcript_byte_count,
        "transcript_sha256": transcript_sha256,
    }
    encoded = (
        json.dumps(observation, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    if len(encoded) > MAX_SOURCE_BYTES:
        raise ContractError("Claude hook observation exceeds source batch limits")

    directory = state_root / "claude-hook-events"
    path = directory / f"{uuid.uuid4()}.jsonl"
    _atomic_json(path, observation)
    return path


def observation_identity(path: Path) -> tuple[str | None, str | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, None
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        return None, None
    return _text(value.get("native_session_id")), _text(
        value.get("parent_native_session_id")
    )
