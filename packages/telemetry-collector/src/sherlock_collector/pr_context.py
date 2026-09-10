"""Explicit, collector-reported PR declarations; native transcripts stay untouched."""
from __future__ import annotations

import fcntl
import json
import re
import subprocess
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from .config import CollectorConfig, collector_destination_binding
from .contract import ContractError, RFC3339_RE, build_source_batch, sha256_hex
from .discovery import _claude_transcript_identity, _codex_rollout_identity
from .rollout import open_regular_under_root
from .spool import DurableSpool, _atomic_json, secure_lock, utc_now

VERSION = "sherlock.pr-context.v1"
NATIVE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,511}\Z", re.ASCII)
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}\Z", re.ASCII)


def canonical_event_id(value: str) -> str:
    try:
        parsed = str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ContractError("event IDs must be canonical UUIDs") from error
    if value != parsed:
        raise ContractError("event IDs must be lowercase canonical UUIDs")
    return parsed


def repository_name(value: str) -> str:
    if not isinstance(value, str) or not REPOSITORY.fullmatch(value) or value.split("/")[-1] in {".", ".."}:
        raise ContractError("repository must be an explicit GitHub owner/repository name")
    return value.lower()


def validate_session(provider: str, session_id: str, source_home: Path,
                     transcript: Path | None = None) -> str:
    if provider not in {"codex", "claude_code"} or not isinstance(session_id, str) or not NATIVE_ID.fullmatch(session_id):
        raise ContractError("provider and exact native --session-id are required")
    # An explicitly provided file must match the provider-native identity. Otherwise
    # inspect only paths naming the selected ID, never a latest-session selector.
    paths = [transcript] if transcript else []
    if not transcript:
        roots = ([source_home / "sessions", source_home / "archived_sessions"]
                 if provider == "codex" else [source_home / "projects"])
        for root in roots:
            if root.is_dir() and not root.is_symlink():
                paths.extend(root.rglob(f"*{session_id}.jsonl"))
    for path in paths:
        assert path is not None
        with open_regular_under_root(source_home, path) as handle:
            if provider == "codex":
                identity = _codex_rollout_identity(handle)
            else:
                parent = path.parent.parent.name if path.parent.name == "subagents" else None
                identity = _claude_transcript_identity(
                    handle, path.name, (session_id, parent), require_declaration=True,
                )
                # Explicitly selecting another session's filename is never valid.
                expected_name = (f"agent-{session_id}.jsonl" if parent or path.name.startswith("agent-")
                                 else f"{session_id}.jsonl")
                if path.name != expected_name:
                    identity = None
            if identity is None or identity[0] != session_id:
                raise ContractError("transcript does not match the exact provider/session identity")
    return "native-file-checked" if paths else "collector-declared"


def _validate_event(event: dict) -> None:
    from datetime import datetime
    common = {"type", "event_id", "operation", "provider", "native_session_id", "occurred_at"}
    operation = event.get("operation")
    expected = common | ({"repository", "pull_request_number"} if operation == "link" else {"link_event_id"})
    if event.get("type") != VERSION or operation not in {"link", "retract"} or set(event) != expected:
        raise ContractError("invalid PR context v1 event shape")
    canonical_event_id(event["event_id"])
    if event["provider"] not in {"codex", "claude_code"} or not isinstance(event["native_session_id"], str) or not NATIVE_ID.fullmatch(event["native_session_id"]):
        raise ContractError("invalid provider/session identity")
    timestamp = event["occurred_at"]
    try:
        if not RFC3339_RE.fullmatch(timestamp):
            raise ValueError()
        zone = timestamp[-6:] if timestamp[-1] != "Z" else None
        if zone and (int(zone[1:3]) > 23 or int(zone[4:]) > 59):
            raise ValueError()
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
    except (ValueError, TypeError):
        raise ContractError("occurred_at must be a valid timezone-aware RFC3339 timestamp") from None
    if operation == "link":
        repository_name(event["repository"])
        number = event["pull_request_number"]
        if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= 2147483647:
            raise ContractError("PR number must be a positive 32-bit integer")
    else:
        canonical_event_id(event["link_event_id"])
        if event["link_event_id"] == event["event_id"]:
            raise ContractError("retraction must reference a different link event")


def _check_state_binding(root: Path, configuration: CollectorConfig) -> str:
    binding = collector_destination_binding(configuration.endpoint, configuration.identity)
    identity_path = root / "identity.json"
    if identity_path.exists():
        if json.loads(identity_path.read_text()) != {"binding": binding}:
            raise ContractError("PR context state belongs to a different collector/destination; use its original configuration")
    else:
        _atomic_json(identity_path, {"binding": binding})
    return binding


@contextmanager
def creation_guard(state_root: Path, configuration: CollectorConfig):
    """Serialize creation/replay checks and reject known config drift before gh."""
    root = state_root / "pr-context"
    with secure_lock(root / "create.lock") as creation_lock:
        fcntl.flock(creation_lock.fileno(), fcntl.LOCK_EX)
        with secure_lock(root / "events.lock") as event_lock:
            fcntl.flock(event_lock.fileno(), fcntl.LOCK_EX)
            _check_state_binding(root, configuration)
        yield


def enqueue_context(*, state_root: Path, configuration: CollectorConfig, provider: str,
                    session_id: str, operation: str, event_id: str | None = None,
                    occurred_at: str | None = None, repository: str | None = None,
                    pr_number: int | None = None, link_event_id: str | None = None) -> dict:
    event_id = canonical_event_id(event_id) if event_id else str(uuid.uuid4())
    root = state_root / "pr-context"
    # Bind retained sidecars to the installed collector and destination. The public
    # ingest still accepts declared identity: this prevents local accidents, not forgery.
    with secure_lock(root / "events.lock") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        binding = _check_state_binding(root, configuration)
        path = root / "events" / f"{event_id}.jsonl"
        existing = json.loads(path.read_text()) if path.exists() else None
        event = {"type": VERSION, "event_id": event_id, "operation": operation,
                 "provider": provider, "native_session_id": session_id,
                 "occurred_at": occurred_at or (existing["occurred_at"] if existing else utc_now())}
        if operation == "link":
            event.update(repository=repository_name(repository or ""), pull_request_number=pr_number)
        else:
            event["link_event_id"] = link_event_id
        _validate_event(event)
        if existing is not None and existing != event:
            raise ContractError("event ID already names a different immutable declaration")
        if existing is None:
            _atomic_json(path, event)
        raw = path.read_bytes()
        manifest, stored = build_source_batch(raw,
            source_stream_key=sha256_hex(f"{VERSION}:{provider}:{session_id}:{event_id}".encode()),
            generation_key=event_id, generation_seq=0, start_offset=0,
            source_provider=provider, source_kind="collector", source_version=VERSION,
            observed_native_session_id=session_id, collector_version="0.1.0")
        DurableSpool(state_root / "queue").enqueue(manifest, stored, workload_class="live",
                                                collector_binding=binding)
    return {"status": "queued", "event_id": event_id, "operation": operation,
            "provider": provider, "native_session_id": session_id, "sidecar": str(path)}


def create_pull_request(*, repository: str, head: str, title: str, body: str,
                        base: str | None = None, draft: bool = False) -> tuple[str, int]:
    repository = repository_name(repository)
    if not head.strip() or head.startswith("-") or not title.strip():
        raise ContractError("PR creation requires explicit --head and --title")
    command = ["gh", "pr", "create", "--repo", repository, "--head", head,
               "--title", title, "--body", body]
    if base:
        command += ["--base", base]
    if draft:
        command.append("--draft")
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise ContractError("gh pr create failed; no PR declaration was queued")
    url = completed.stdout.strip()
    parsed = urlsplit(url)
    match = re.fullmatch(r"/([^/]+/[^/]+)/pull/([1-9][0-9]*)", parsed.path)
    if (parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query
            or parsed.fragment or not match or match[1].lower() != repository):
        raise ContractError("gh succeeded but returned an unexpected PR URL; use manual link after checking the created PR")
    return url, int(match[2])
