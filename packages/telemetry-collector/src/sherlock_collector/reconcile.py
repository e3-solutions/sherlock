"""Hook-independent local reconciliation. The ledger is coverage, not a receipt."""

from __future__ import annotations

import fcntl
import json
from dataclasses import asdict
from pathlib import Path

from .discovery import discover_all_sources
from .drain import Drain, UploadTransport
from .rollout import CaptureResult, DEFAULT_MAX_FILES, RolloutCapturer, _stream_key
from .spool import DurableSpool, _atomic_json, secure_lock, utc_now

# A complete native record (up to 100 MiB) can be committed atomically in one run.
DEFAULT_RECONCILE_BYTES = 128 * 1024 * 1024


def reconcile(
    home: Path | str,
    state_root: Path | str,
    provider: str,
    transport: UploadTransport | None,
    *,
    max_files: int = DEFAULT_MAX_FILES,
    max_bytes: int = DEFAULT_RECONCILE_BYTES,
    max_uploads: int = 128,
) -> dict:
    if min(max_files, max_bytes, max_uploads) < 1:
        raise ValueError("reconcile budgets must be positive")
    home, root = Path(home).resolve(), Path(state_root).resolve()
    spool = DurableSpool(root / "queue")
    with secure_lock(root / f"{provider}-reconcile.lock") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "busy", "locked": True, "provider": provider}
        ledger_path = root / f"{provider}-reconcile.json"
        if ledger_path.exists():
            # Fail closed on corruption; never silently discard unfinished work.
            try:
                ledger = json.loads(ledger_path.read_text())
                if (
                    not isinstance(ledger, dict)
                    or ledger.get("version") != 1
                    or not isinstance(ledger.get("sources"), dict)
                    or not all(
                        isinstance(entry, dict) for entry in ledger["sources"].values()
                    )
                ):
                    raise ValueError("invalid reconcile ledger")
            except (OSError, ValueError) as error:
                # Keep the corrupt ledger for audit; queue recovery is independent.
                drain = (
                    Drain(spool, transport).run(max_items=max_uploads, max_seconds=120)
                    if transport
                    else None
                )
                return {
                    "status": "partial",
                    "locked": False,
                    "provider": provider,
                    "ledger_error": str(error),
                    "drain": asdict(drain) if drain else None,
                }
        else:
            ledger = {"version": 1, "provider": provider, "sources": {}}
        discovery = discover_all_sources(home, provider)
        now = utc_now()
        sources = ledger["sources"]
        previous_issues = {
            path: (entry.get("snapshot"), entry.get("reason"))
            for path, entry in sources.items()
        }
        completed_snapshots = {
            path: entry.get("snapshot")
            for path, entry in sources.items()
            if entry.get("status") == "captured"
        }
        for entry in sources.values():
            entry["status"] = "source_missing_or_invalid"
        for path in discovery.paths:
            raw = str(path)
            snapshot = discovery.source_snapshots[raw]
            entry = sources.setdefault(raw, {"first_seen_at": now})
            entry.update(
                {
                    "last_seen_at": now,
                    "snapshot": asdict(snapshot),
                    "native_session_id": discovery.native_session_ids.get(raw),
                    "parent_native_session_id": discovery.parent_native_session_ids.get(
                        raw
                    ),
                    "status": "pending",
                }
            )
        ledger.update(
            {
                "last_scan_at": now,
                "discovery_errors": list(discovery.errors),
                "invalid_sources": discovery.invalid_count,
            }
        )
        # Persist every discovered candidate before applying any run budget.
        _atomic_json(ledger_path, ledger)
        is_claude = provider == "claude_code"
        capturer = RolloutCapturer(
            root,
            spool,
            source_provider=provider,
            source_kind="transcript" if is_claude else "rollout",
            state_name="claude-transcript" if is_claude else "rollout",
            allowed_root=home if home.is_dir() else None,
            enforce_sync_budget=True,
        )
        capture_error = None
        try:
            pending_paths = [
                path
                for path in discovery.paths
                if completed_snapshots.get(str(path))
                != asdict(discovery.source_snapshots[str(path)])
            ]
            capture = capturer.capture(
                pending_paths,
                native_session_ids=discovery.native_session_ids,
                parent_native_session_ids=discovery.parent_native_session_ids,
                source_snapshots=discovery.source_snapshots,
                best_effort=True,
                max_files=max_files,
                max_sync_bytes=max_bytes,
                backlog_workload_class="backfill",
            )
            states = (
                capturer._read_state(capturer.state_path)[0]
                if capturer.state_path.exists()
                else {}
            )
        except (OSError, ValueError) as error:
            capture_error = f"{type(error).__name__}: {error}"
            capture = CaptureResult(errors=1)
            states = {}
        for path in discovery.paths:
            raw = str(path)
            entry = sources[raw]
            snapshot = discovery.source_snapshots[raw]
            state = states.get(_stream_key(path))
            offset = 0
            if state:
                offset = capturer.snapshot_offset(path, snapshot, state)
            remaining = snapshot.end_offset - offset
            issue = capturer.source_issues.get(raw) or capture_error
            previous_snapshot, previous_reason = previous_issues.get(raw, (None, None))
            if raw not in capturer.visited_paths and previous_snapshot == asdict(
                snapshot
            ):
                issue = issue or previous_reason
            if raw in capturer.visited_paths:
                entry["last_attempted_at"] = now
            entry.update(
                {
                    "capture_offset": offset,
                    "deferred_bytes": remaining,
                    "status": "captured"
                    if not remaining and not issue
                    else "unfinished",
                    "reason": issue
                    or (
                        "capture_locked"
                        if capture.locked
                        else "file_below_cursor"
                        if remaining
                        else None
                    ),
                }
            )
            if state:
                entry["generation_seq"] = state.generation_seq
                entry["generation_key"] = state.generation_key
                entry["recovery_reason"] = state.recovery_reason
        _atomic_json(ledger_path, ledger)
        # Drain even when capture is busy or discovery is empty. Queue recovery
        # must never depend on another source event or successful capture.
        drain = (
            Drain(spool, transport).run(max_items=max_uploads, max_seconds=120)
            if transport
            else None
        )
        unfinished = sum(entry["status"] != "captured" for entry in sources.values())
        dead_letters = len(list(spool.dead_letter.glob("*.json")))
        pending = len(spool.list_pending())
        partial = bool(
            unfinished
            or pending
            or dead_letters
            or discovery.errors
            or discovery.invalid_count
            or capture.locked
            or capture.errors
            or drain is None
            or drain.locked
        )
        return {
            "status": "partial" if partial else "complete",
            "provider": provider,
            "locked": capture.locked,
            "discovered": len(discovery.paths),
            "unfinished_sources": unfinished,
            "pending_uploads": pending,
            "dead_letters": dead_letters,
            "capture": asdict(capture),
            "drain": asdict(drain) if drain else None,
            "discovery_errors": list(discovery.errors),
            "invalid_sources": discovery.invalid_count,
            "capture_error": capture_error,
            "completion_basis": "local_capture_and_queue_state",
            "delivery_audit": "inventory_uses_committed_receipts",
        }
