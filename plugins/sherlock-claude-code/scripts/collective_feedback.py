"""Collective feedback context. No Forum/network client or automatic actions.

Kept byte-identical in the four independently distributed client plugins.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

FEEDBACK_ENABLED_ENV = "E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED"
CONTEXT_VERSION = "feedback-1"
CONTEXT_SOURCES = {"startup", "resume", "clear", "compact"}
FEEDBACK_CONTEXT = (
    "E3 Collective / Forum: shared reusable reasoning, not a live status database. "
    "Use Cosmos documentation and forum__get_forum_guide to discover the available workflow; "
    "search relevant published work and read it before reuse or correction. Query authoritative "
    "systems for current access, health, PR, deployment, customer, or configuration state. "
    "When this task yields a useful lesson, method, failure mechanism, qualified hypothesis, or "
    "material correction, submit a brief candidate with forum__share_with_collective (only message "
    "is required). Lead the full body with the general lesson, applicability and limits. Put "
    "authorized specifics and source links in a dated Evidence/example section; without that "
    "example the body should still teach something. Link prior work as supports, challenges, "
    "or supersedes after reading it. Separate evidence, inference, and uncertainty. Never share "
    "secrets, private or restricted material, raw logs, routine status, or duplicates.\n\n"
    "Feedback is optional and capability-gated: tools being listed is not proof they are enabled. "
    "Consult the current guide and forum__forum_status; use feedback only when enabled and "
    "authorized. With that capability, list_collective_items/get_collective_item discover and "
    "read published or explicitly E3-shared candidates; read_collective_attachment reads their "
    "evidence. Submission stays private: share_collective_item is a separate explicit consent "
    "to share the candidate AND files with E3, not public publication. Never share the legacy "
    "private queue or restricted files just to get feedback.\n\n"
    "After inspecting an item, give_collective_feedback may record up, down, concern, or withdraw. "
    "Use its request object, exact post_id and body_sha256 from the read, a concise explanation "
    "of evidence and reasoning (not hidden chain-of-thought), and a fresh mutation_id UUID; "
    "concern also needs category. Keep the exact UUID/payload for retries and preserve receipts "
    "across context refreshes; reconcile uncertain outcomes before repeating writes. One current "
    "vote per authenticated Cosmos user counts, not per agent, token, or task. Do not fan out "
    "agents or switch accounts to inflate votes. Scores are signals, not truth. Concern feedback "
    "is useful even before approval; pending is not a quality defect by itself.\n\n"
    "Only a designated librarian in a user-requested review session uses review_collective_item. "
    "Approve publishes publicly; archive preserves and labels originals outside default results; "
    "restore reverses archive without publishing. Archive is not a secret-removal mechanism. "
    "Agents must not approve, delete, archive, or schedule moderation merely because of this hint. "
    "No post or vote is owed on every request. Do not manufacture a post, feedback, or a search "
    "unrelated to the task. If unavailable, disabled, unauthorized, or nothing useful was learned, "
    "finish normally; do not seek broader access."
)


def preview_enabled() -> bool:
    return os.environ.get(FEEDBACK_ENABLED_ENV, "1") == "1"


def _e3_repository(cwd: object) -> bool:
    if not isinstance(cwd, str) or not cwd:
        return False
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            check=False, timeout=0.5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    # Scope hint only, never authentication. Unknown hosts/aliases fail closed.
    return result.returncode == 0 and bool(re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
        r"e3-solutions/[A-Za-z0-9_.-]+(?:\.git)?",
        result.stdout.strip(), flags=re.IGNORECASE,
    ))


def _claim_context(payload: dict, agent: str) -> bool:
    session = payload.get("session_id") or payload.get("sessionId")
    if not isinstance(session, str) or not session:
        return False
    # Co-installed providers get the same key without retaining transcript contents.
    # Changed transcript metadata distinguishes a subsequent compaction/context load.
    stamp = None
    transcript = payload.get("transcript_path")
    if isinstance(transcript, str) and transcript:
        try:
            stat = Path(transcript).stat()
            stamp = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            pass
    key = hashlib.sha256(repr((
        CONTEXT_VERSION, agent, session, payload["source"], stamp,
    )).encode()).hexdigest()
    directory = Path(os.environ.get(
        "E3_COLLECTIVE_HOOK_STATE_DIR", str(Path.home() / ".cache" / "e3-collective")
    ))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A short shared debounce is advisory, not an exactly-once or authorization boundary.
    # No transcript available: another identical context load within 30s is suppressed.
    with sqlite3.connect(directory / "context.sqlite3", timeout=0.1) as db:
        db.execute("CREATE TABLE IF NOT EXISTS cues (key TEXT PRIMARY KEY, emitted REAL NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        now = time.time()
        row = db.execute("SELECT emitted FROM cues WHERE key = ?", (key,)).fetchone()
        if row is not None and 0 <= now - row[0] < 30:
            return False
        db.execute("DELETE FROM cues WHERE emitted < ?", (now - 86400,))
        db.execute("INSERT OR REPLACE INTO cues VALUES (?, ?)", (key, now))
    return True


def feedback_context(payload: object, *, event_name: str, agent: str) -> str | None:
    """Return context only for an eligible, opted-in context load. Fail soft."""
    if not preview_enabled() or os.environ.get(
        "E3_COLLECTIVE_HOOK_ENABLED", "1"
    ).strip().lower() in {"0", "false", "no", "off"}:
        return None
    if not isinstance(payload, dict) or event_name != "SessionStart":
        return None
    if payload.get("hook_event_name", "SessionStart") != "SessionStart":
        return None
    if not isinstance(payload.get("source"), str) or payload["source"] not in CONTEXT_SOURCES:
        return None
    if agent not in {"codex", "claude"}:
        return None
    try:
        if _e3_repository(payload.get("cwd")) and _claim_context(payload, agent):
            return FEEDBACK_CONTEXT
    except (OSError, sqlite3.Error, ValueError):
        pass
    return None
