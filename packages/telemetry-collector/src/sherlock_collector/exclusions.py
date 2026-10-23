"""Owner-local session exclusions shared by hooks, backfill, reconcile and drain.

The policy file is ``$SHERLOCK_HOME/session-exclusions.json`` (default
``~/.sherlock/session-exclusions.json``), the same file other local E3 session
tooling already honours::

    {"version": 1,
     "excluded_session_ids": ["<uuid>", ...],
     "allowed_claude_session_ids": ["<uuid>", ...]}

* ``excluded_session_ids``: these sessions and every Codex thread descended
  from them (subagents, forks) are never captured or uploaded.
* ``allowed_claude_session_ids`` (optional): when present, only these Claude
  root sessions are captured or uploaded; Claude subagent transcripts are not.

No file means no policy. A file that exists but cannot be read or validated
fails closed: nothing is captured or uploaded until it is repaired. Blocked
sources keep their cursor and blocked queued batches stay queued, so removing
an entry later resumes collection without loss. The policy never leaves the
machine and transcript bodies are never read beyond Codex session metadata.
"""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping


POLICY_NAME = "session-exclusions.json"
MAX_POLICY_BYTES = 1024 * 1024
MAX_SESSION_META_BYTES = 1024 * 1024
MAX_ANCESTRY_DEPTH = 64

EXCLUDED = "excluded_by_session_policy"
NOT_ALLOWED = "not_in_claude_session_allowlist"
UNREADABLE = "session_exclusion_policy_unreadable"
UNVERIFIED = "session_ancestry_unverified"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def policy_path() -> Path:
    configured = os.environ.get("SHERLOCK_HOME")
    base = Path(configured).expanduser() if configured else Path.home() / ".sherlock"
    return base / POLICY_NAME


def _normalize(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value or None


def _id_list(raw: dict, key: str) -> frozenset[str] | None:
    if key not in raw:
        return None
    values = raw[key]
    if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
        raise ValueError(f"{key} must be a list of strings")
    return frozenset(v for v in (_normalize(item) for item in values) if v)


@dataclass(frozen=True)
class ExclusionPolicy:
    excluded: frozenset[str] = frozenset()
    allowed_claude: frozenset[str] | None = None
    error: str | None = None
    _ancestry: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def active(self) -> bool:
        return bool(self.error or self.excluded or self.allowed_claude is not None)

    def blocked_reason(
        self,
        provider: str,
        native_session_id: object,
        parent_native_session_id: object = None,
        *,
        codex_home: Path | None = None,
        source_path: Path | None = None,
    ) -> str | None:
        """Return why this source/batch must not be captured or uploaded."""
        if not self.active:
            return None
        if self.error:
            return UNREADABLE
        native = _normalize(native_session_id)
        parent = _normalize(parent_native_session_id)
        if provider == "claude_code":
            if {native, parent} & self.excluded:
                return EXCLUDED
            if native is None:
                return UNVERIFIED
            if self.allowed_claude is not None and (
                parent is not None or native not in self.allowed_claude
            ):
                return NOT_ALLOWED
            return None
        if not self.excluded:
            return None
        if {native, parent} & self.excluded:
            return EXCLUDED
        # Codex threads can be subagents of subagents or forks of an excluded
        # session; walk the recorded ancestry through each rollout's session_meta.
        # A source file supplies its own session_meta; a queued batch is resolved
        # from its labelled session id. Unresolvable ancestry fails closed.
        seen: set[str] = set()
        pending: list[str] = [value for value in (parent,) if value]
        if source_path is not None:
            meta = _session_meta_ids(source_path)
            if meta is None:
                return UNVERIFIED
            own, ancestors = meta
            if ({own} | ancestors) & self.excluded:
                return EXCLUDED
            seen.add(own)
            pending.extend(ancestors)
        elif native is not None:
            pending.append(native)
        else:
            return UNVERIFIED
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            if len(seen) > MAX_ANCESTRY_DEPTH:
                return UNVERIFIED
            ancestors = self._ancestors(current, codex_home)
            if ancestors is None:
                return UNVERIFIED
            if ancestors & self.excluded:
                return EXCLUDED
            pending.extend(ancestors - seen)
        return None

    def _ancestors(self, session_id: str, codex_home: Path | None) -> set[str] | None:
        """Ancestor ids recorded by the rollout whose own session_meta is session_id.

        None means the ancestry cannot be verified (missing or unreadable file);
        callers then fail closed. One filename index per home keeps this to a
        single directory walk per process, however many ancestors are checked.
        """
        if session_id in self._ancestry:
            return self._ancestry[session_id]
        result: set[str] | None = None
        for path in self._index(codex_home).get(session_id, ()):
            meta = _session_meta_ids(path)
            if meta is not None and meta[0] == session_id:
                result = meta[1]
                break
        self._ancestry[session_id] = result
        return result

    def _index(self, codex_home: Path | None) -> Mapping[str, list[Path]]:
        key = ("index", str(codex_home))
        if key not in self._ancestry:
            self._ancestry[key] = _rollout_index(codex_home)
        return self._ancestry[key]


def load_policy(path: Path | None = None) -> ExclusionPolicy:
    path = path or policy_path()
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_POLICY_BYTES + 1)
    except FileNotFoundError:
        return ExclusionPolicy()
    except OSError as error:
        return ExclusionPolicy(error=f"{type(error).__name__}: {error}")
    try:
        if len(data) > MAX_POLICY_BYTES:
            raise ValueError("policy file is too large")
        raw = json.loads(data)
        if not isinstance(raw, dict) or raw.get("version") != 1:
            raise ValueError("policy must be an object with version 1")
        excluded = _id_list(raw, "excluded_session_ids") or frozenset()
        allowed = _id_list(raw, "allowed_claude_session_ids")
    except (ValueError, UnicodeDecodeError) as error:
        return ExclusionPolicy(error=str(error))
    return ExclusionPolicy(excluded=excluded, allowed_claude=allowed)


def _session_meta_ids(path: Path) -> tuple[str, set[str]] | None:
    """Return (own id, ancestor ids) from a Codex rollout's first session_meta."""
    try:
        # Never block on a FIFO or follow a final symlink while checking policy.
        descriptor = os.open(
            path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
        )
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            return None
        with os.fdopen(descriptor, "rb") as handle:
            remaining = MAX_SESSION_META_BYTES
            while remaining > 0:
                line = handle.readline(remaining + 1)
                if not line or len(line) > remaining:
                    return None
                remaining -= len(line)
                try:
                    record = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(record, dict) and record.get("type") == "session_meta":
                    break
            else:
                return None
    except OSError:
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    own = _normalize(payload.get("id"))
    if own is None:
        return None
    ancestors = {
        _normalize(payload.get(key))
        for key in ("session_id", "parent_thread_id", "forked_from_id")
    }
    source = payload.get("source")
    if isinstance(source, dict) and isinstance(source.get("subagent"), dict):
        spawn = source["subagent"].get("thread_spawn")
        if isinstance(spawn, dict):
            ancestors.add(_normalize(spawn.get("parent_thread_id")))
    return own, {value for value in ancestors if value and value != own}


def _rollout_index(codex_home: Path | None) -> dict[str, list[Path]]:
    """Map every UUID in a rollout filename to its paths (no symlinked roots)."""
    index: dict[str, list[Path]] = {}
    if codex_home is None:
        return index
    for root in (codex_home / "sessions", codex_home / "archived_sessions"):
        if root.is_symlink() or not root.is_dir():
            continue
        for directory, directories, files in os.walk(root):
            directories[:] = [
                name for name in directories
                if not os.path.islink(os.path.join(directory, name))
            ]
            for name in files:
                if name.startswith("rollout-") and name.endswith(".jsonl"):
                    for value in set(_UUID.findall(name.lower())):
                        index.setdefault(value, []).append(Path(directory) / name)
    return index
