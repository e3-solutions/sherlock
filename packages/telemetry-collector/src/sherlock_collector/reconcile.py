"""Hook-independent local reconciliation. The ledger is coverage, not a receipt."""

from __future__ import annotations

import fcntl
import json
import os
import time
from dataclasses import asdict
from pathlib import Path

from . import pending_sources
from .discovery import discover_all_sources
from .drain import Drain, UploadTransport
from .exclusions import EXCLUDED, EXCLUDED_PROJECT, NOT_ALLOWED
from .overlap_repair import repair_overlap_dead_letters
from .rollout import (
    CaptureResult,
    DEFAULT_MAX_FILES,
    RECONCILE_CURSOR,
    RolloutCapturer,
    _stream_key,
)
from .spool import DurableSpool, _atomic_json, secure_lock, utc_now

# Fragment publication resumes across runs within this source-byte budget.
DEFAULT_RECONCILE_BYTES = 128 * 1024 * 1024
# Files last written before this window are not discovered by the periodic scan.
# It matches the installer's longest permitted Claude backfill (744 hours), so a
# scheduled run never reaches further back than an install could be asked to.
# 0 disables the bound for an explicit, operator-run history recovery.
DEFAULT_RECONCILE_MAX_AGE_DAYS = 31
# Ledger reasons that owner policy decided; they are not capture failures.
POLICY_REASONS = frozenset({EXCLUDED, EXCLUDED_PROJECT, NOT_ALLOWED})
STATUS_NAME = "collector-status.json"


def reconcile(
    home: Path | str,
    state_root: Path | str,
    provider: str,
    transport: UploadTransport | None,
    *,
    max_files: int = DEFAULT_MAX_FILES,
    max_bytes: int = DEFAULT_RECONCILE_BYTES,
    max_uploads: int = 128,
    max_age_days: int = DEFAULT_RECONCILE_MAX_AGE_DAYS,
) -> dict:
    if min(max_files, max_bytes, max_uploads) < 1:
        raise ValueError("reconcile budgets must be positive")
    if max_age_days < 0:
        raise ValueError("reconcile max_age_days must not be negative")
    modified_after_ns = (
        time.time_ns() - max_age_days * 86_400 * 1_000_000_000 if max_age_days else 0
    )
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
                    Drain(spool, transport, source_home=home).run(
                    max_items=max_uploads, max_seconds=120
                )
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
        discovery = discover_all_sources(
            home, provider, modified_after_ns=modified_after_ns
        )
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
        for raw, entry in sources.items():
            entry["status"] = (
                "outside_reconcile_window"
                if _older_than(raw, modified_after_ns)
                else "source_missing_or_invalid"
            )
        for status in discovery.source_statuses:
            raw = str(status.get("rollout_path") or "")
            if raw and status.get("reason"):
                entry = sources.setdefault(raw, {"first_seen_at": now})
                entry.update(
                    {
                        "last_seen_at": now,
                        "status": "unfinished",
                        "reason": status["reason"],
                    }
                )
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
                "max_age_days": max_age_days,
                "discovery_errors": list(discovery.errors),
                "invalid_sources": discovery.invalid_count,
            }
        )
        # Persist every discovered candidate before applying any run budget.
        _atomic_json(ledger_path, ledger)
        is_claude = provider == "claude_code"
        state_name = "claude-transcript" if is_claude else "rollout"
        capturer = RolloutCapturer(
            root,
            spool,
            source_provider=provider,
            source_kind="transcript" if is_claude else "rollout",
            state_name=state_name,
            allowed_root=home if home.is_dir() else None,
            enforce_sync_budget=True,
        )
        capture_error = None
        # Sources a hook named but could not capture go first (COR-5023).
        reminders = pending_sources.load(
            root,
            state_name,
            allowed_root=home,
            limit=min(pending_sources.MAX_MARKERS_PER_CAPTURE, max(1, max_files // 4)),
        )
        native_ids = dict(discovery.native_session_ids)
        parent_ids = dict(discovery.parent_native_session_ids)
        for entry in reminders:
            if entry.native_session_id:
                native_ids.setdefault(entry.path, entry.native_session_id)
            if entry.parent_native_session_id:
                parent_ids.setdefault(entry.path, entry.parent_native_session_id)
        try:
            reminder_paths = [entry.path for entry in reminders]
            pending_paths = [
                *reminder_paths,
                *(
                    path
                    for path in discovery.paths
                    if str(path) not in reminder_paths
                    and completed_snapshots.get(str(path))
                    != asdict(discovery.source_snapshots[str(path)])
                ),
            ]
            capture = capturer.capture(
                pending_paths,
                native_session_ids=native_ids,
                parent_native_session_ids=parent_ids,
                source_snapshots=discovery.source_snapshots,
                best_effort=True,
                max_files=max_files,
                max_sync_bytes=max_bytes,
                priority_count=len(reminder_paths),
                priority_workload_class="backfill",
                backlog_workload_class="backfill",
                cursor_name=RECONCILE_CURSOR,
            )
            if not capture.locked:
                pending_sources.settle(
                    reminders,
                    visited=capturer.visited_paths,
                    completed=capturer.completed_paths,
                    source_issues=capturer.source_issues,
                    blocked_reasons=POLICY_REASONS,
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
                entry["fragment_progress"] = state.pending_fragment
        eligible_unfinished = sum(
            entry.get("status") == "unfinished"
            and entry.get("reason") not in POLICY_REASONS
            for entry in sources.values()
        )
        progress = ledger.get("progress") if isinstance(ledger.get("progress"), dict) else {}
        if capture.captured_bytes or not eligible_unfinished:
            progress = {
                "runs_without_progress": 0,
                "last_progress_at": now if capture.captured_bytes else progress.get(
                    "last_progress_at"
                ),
            }
        elif not capture.locked:
            progress = {
                "runs_without_progress": int(progress.get("runs_without_progress", 0))
                + 1,
                "last_progress_at": progress.get("last_progress_at"),
            }
        ledger["progress"] = progress
        _atomic_json(ledger_path, ledger)
        try:
            repairs = repair_overlap_dead_letters(spool)
        except OSError as error:
            repairs = {"error": f"{type(error).__name__}"}
        # Drain even when capture is busy or discovery is empty. Queue recovery
        # must never depend on another source event or successful capture.
        drain = (
            Drain(spool, transport, source_home=home).run(
                    max_items=max_uploads, max_seconds=120
                )
            if transport
            else None
        )
        unfinished = sum(
            entry["status"] not in {"captured", "outside_reconcile_window"}
            for entry in sources.values()
        )
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
            or drain.collector_failure
        )
        dead_letter_summary = spool.dead_letter_summary()
        result = {
            "status": "partial" if partial else "complete",
            "provider": provider,
            "locked": capture.locked,
            "discovered": len(discovery.paths),
            "max_age_days": max_age_days,
            "excluded_by_cutoff": discovery.excluded_by_cutoff,
            "unfinished_sources": unfinished,
            "eligible_unfinished_sources": eligible_unfinished,
            "runs_without_progress": int(progress.get("runs_without_progress", 0)),
            "last_progress_at": progress.get("last_progress_at"),
            "pending_source_markers": pending_sources.count(root, state_name),
            "overlap_repair": repairs,
            "dead_letter_codes": dead_letter_summary["dead_letter_codes"],
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
        write_collector_status(root, provider, result, dead_letter_summary)
        return result


def write_collector_status(
    root: Path,
    provider: str,
    result: dict,
    dead_letter_summary: dict,
) -> None:
    """Persist counters (never content) for Jolly Roger's check-in to read."""
    drain = result.get("drain") or {}
    status = {
        "status_version": 1,
        "provider": provider,
        "updated_at": utc_now(),
        "reconcile_status": result.get("status"),
        "eligible_unfinished_sources": result.get("eligible_unfinished_sources"),
        "unfinished_sources": result.get("unfinished_sources"),
        "runs_without_progress": result.get("runs_without_progress"),
        "last_progress_at": result.get("last_progress_at"),
        "pending_source_markers": result.get("pending_source_markers"),
        "pending_uploads": result.get("pending_uploads"),
        "held_by_policy": drain.get("held_by_policy"),
        "dead_letters": dead_letter_summary["dead_letter_batches"],
        "dead_letter_codes": dead_letter_summary["dead_letter_codes"],
        "dead_letters_total": dead_letter_summary["dead_letters_total"],
        "last_dead_lettered_at": dead_letter_summary["last_dead_lettered_at"],
        "collector_failure": (drain.get("collector_failure") or {}).get("error_code")
        if isinstance(drain.get("collector_failure"), dict)
        else None,
    }
    try:
        _atomic_json(root / STATUS_NAME, status)
    except OSError:
        pass


def _older_than(raw: str, modified_after_ns: int) -> bool:
    if not modified_after_ns:
        return False
    try:
        return os.stat(raw, follow_symlinks=False).st_mtime_ns < modified_after_ns
    except OSError:
        return False
