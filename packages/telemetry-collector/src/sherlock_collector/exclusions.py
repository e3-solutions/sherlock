"""Owner-local session exclusions shared by hooks, backfill, reconcile and drain.

The policy file is ``$SHERLOCK_HOME/session-exclusions.json`` (default
``~/.sherlock/session-exclusions.json``), the same file other local E3 session
tooling already honours::

    {"version": 1,
     "excluded_session_ids": ["<uuid>", ...],
     "excluded_project_paths": ["/absolute/project/path", ...],
     "allowed_claude_session_ids": ["<uuid>", ...]}

* ``excluded_session_ids``: these sessions and every Codex thread descended
  from them (subagents, forks) are never captured or uploaded.
* ``excluded_project_paths``: sessions whose working directory is one of these
  directories or inside one, including a git worktree of a repository inside
  one, are never captured or uploaded, nor are the Codex threads descended
  from them or the Claude subagents of a Claude session started there.
  An entry whose last folder name ends with ``*`` is a name pattern:
  ``/private/tmp/aeyron-*`` covers every folder in ``/private/tmp`` whose name
  starts with ``aeyron-``, and everything inside them, including folders made
  later. ``*`` is allowed only there (COR-5002).
* ``allowed_claude_session_ids`` (optional): when present, only these Claude
  root sessions are captured or uploaded; Claude subagent transcripts are not.

Codex hook-only sessions (side-conversation forks, which have no rollout and
no session_meta; see codex_hook.py) are classified from their hook
observation: the session and the parent it names (or its SessionStart named)
against ``excluded_session_ids``, its working directory and recorded git
remote against ``excluded_project_paths``, then the parent's recorded
ancestry. While any session ids are excluded, one with no known parent is held
as unverified, so a fork of an excluded session never leaves the machine.

No file means no policy. A file that exists but cannot be read or validated
fails closed: nothing is captured or uploaded until it is repaired. A session
whose working directory cannot be read yet while project exclusions exist is
held the same way. Blocked sources keep their cursor and blocked queued
batches stay queued, so removing an entry later resumes collection without
loss. Project paths and the rest of the policy never leave the machine; only
excluded session ids are reported to Sherlock (see exclusion_report.py) so it
can hide copies uploaded before they were excluded. Locally, transcripts are
read only up to the Codex session metadata or the first record naming a
working directory.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping
from urllib.parse import urlsplit

from .contract import MAX_SOURCE_BYTES
from .markers import (
    EXCLUDED_MARKER,
    MARKER_UNVERIFIED,
    STATE_NAME as MARKER_STATE_NAME,
    MarkerClassifier,
    parse_marker_allowed,
    parse_markers,
    settings_fingerprint,
)
from .spool import _atomic_json, secure_lock


POLICY_NAME = "session-exclusions.json"
# Linked worktrees are often removed once their task ends; remembering where
# each one pointed keeps its sessions excluded after the directory is gone.
WORKTREE_ORIGINS_NAME = "worktree-origins.json"
MAX_POLICY_BYTES = 1024 * 1024
MAX_SESSION_META_BYTES = 1024 * 1024
MAX_ANCESTRY_DEPTH = 64
MAX_CWD_SCAN_BYTES = 64 * 1024 * 1024
MAX_GIT_FILE_BYTES = 64 * 1024

EXCLUDED = "excluded_by_session_policy"
EXCLUDED_PROJECT = "excluded_by_project_policy"
NOT_ALLOWED = "not_in_claude_session_allowlist"
UNREADABLE = "session_exclusion_policy_unreadable"
UNVERIFIED = "session_ancestry_unverified"
ORIGINS_UNREADABLE = "worktree_origins_unreadable"
# macOS volumes are case- and Unicode-normalization-insensitive by default.
# Folding on a case-sensitive volume can only exclude more, never less.
_FOLD_CASE = sys.platform == "darwin"
# A "cwd" field at any depth, also inside a fragment of a record too large to parse.
_CWD_FIELD = re.compile(rb'"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# Sherlock hook observations carry the raw hook payload base64-encoded.
HOOK_OBSERVATION_TYPES = frozenset({"claude_hook", "codex_hook"})
# Where the Codex hook writes a marker for each hook-only session it saw start
# (see codex_hook.py); the marker keeps the parent named by the SessionStart.
CODEX_HOOK_SESSIONS = "codex-hook-sessions"
CODEX_HOOK_EVENTS = "codex-hook-events"


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


PATTERN = "*"
# Pattern keys carry this mark, which no path can contain, so a resolved plain
# path that happens to end with "*" is never read as a pattern.
_PATTERN_KEY = "\0"


def is_project_pattern(path: str) -> bool:
    """Whether a configured project entry is a folder-name pattern (``parent/name*``)."""
    return isinstance(path, str) and bool(path.strip()) and \
        os.path.normpath(os.path.expanduser(path.strip())).endswith(PATTERN)


def _check_pattern(path: str, *, resolved: bool = False) -> None:
    parent, name = os.path.split(path)
    if name.count(PATTERN) != 1 or not name.endswith(PATTERN) or (PATTERN in parent and not resolved):
        raise ValueError("a project pattern may use * only at the end of its last folder name")
    # The resolved parent too: "//x*" or a parent linked to "/" must not cover everything.
    if os.sep in (parent, os.path.normpath(os.path.realpath(parent)) if parent else os.sep):
        raise ValueError("a project pattern must not cover top-level folders")


def normalize_project_path(value: object) -> str:
    """Absolute, normalized form of a configured project directory or name pattern."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("project paths must be non-empty strings")
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path):
        raise ValueError("project paths must be absolute")
    path = os.path.normpath(path)
    if path.endswith(PATTERN):
        _check_pattern(path)
    return path


def _resolved_project_path(value: str) -> str:
    """Symlinks resolved before "..", as the filesystem does; for a pattern, its parent."""
    expanded = os.path.expanduser(value.strip())
    if is_project_pattern(expanded):
        # Drop trailing "/" and "/." only; ".." must resolve after symlinks.
        trimmed = expanded.rstrip(os.sep) or os.sep
        while os.path.basename(trimmed) == "." and trimmed != os.sep:
            trimmed = os.path.dirname(trimmed).rstrip(os.sep) or os.sep
        return os.path.join(os.path.realpath(os.path.dirname(trimmed)), os.path.basename(trimmed))
    return os.path.realpath(expanded)


def _absolute_project_path(value: str, *, for_removal: bool = False) -> str:
    """Resolve a command-line path as the filesystem would, symlinks before "..".

    Relative paths are taken from the current directory.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("project paths must be non-empty strings")
    resolved = os.path.normpath(_resolved_project_path(value))
    if is_project_pattern(value):
        return normalize_project_path(resolved)
    if for_removal:
        return resolved
    if resolved.endswith(PATTERN) and not for_removal:
        # Stored, it would read as a pattern and cover its siblings too.
        raise ValueError("a folder whose real name ends with * cannot be excluded by path")
    return normalize_project_path(resolved)


def _project_paths(raw: dict) -> frozenset[str]:
    values = raw.get("excluded_project_paths", [])
    if not isinstance(values, list):
        raise ValueError("excluded_project_paths must be a list of strings")
    keys: set[str] = set()
    for value in values:
        normalized = normalize_project_path(value)
        # Resolve symlinks before collapsing "..", as the filesystem does, and
        # keep the lexical spelling too (for example /tmp and /private/tmp).
        resolved = _resolved_project_path(value)
        if normalized.endswith(PATTERN):
            _check_pattern(resolved, resolved=True)
            keys |= {_PATTERN_KEY + _path_key(normalized), _PATTERN_KEY + _path_key(resolved)}
            continue
        if os.sep in (normalized, resolved):
            raise ValueError("excluded_project_paths must not exclude the filesystem root")
        keys |= {_path_key(normalized), _path_key(resolved)}
    return frozenset(keys)


def _under(candidate: str, project: str) -> bool:
    """Whether a path key is an excluded project key or inside one.

    A pattern key ``parent/name*`` matches every path under ``parent`` whose
    first folder below it starts with ``name``.
    """
    if project.startswith(_PATTERN_KEY):
        return candidate.startswith(project[len(_PATTERN_KEY): -len(PATTERN)])
    return candidate == project or candidate.startswith(project.rstrip(os.sep) + os.sep)


def _path_key(path: str) -> str:
    if not _FOLD_CASE:
        return path
    # Canonical caseless matching, as APFS compares names.
    return unicodedata.normalize("NFD", unicodedata.normalize("NFD", path).casefold())


@dataclass(frozen=True)
class ExclusionPolicy:
    excluded: frozenset[str] = frozenset()
    allowed_claude: frozenset[str] | None = None
    excluded_projects: frozenset[str] = frozenset()
    excluded_project_paths: tuple[str, ...] = ()
    worktree_origins_path: Path | None = None
    error: str | None = None
    # Session markers for shared folders (see markers.py); None when unused.
    markers: MarkerClassifier | None = field(default=None, compare=False)
    _ancestry: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def active(self) -> bool:
        return bool(
            self.error
            or self.excluded
            or self.excluded_projects
            or self.markers is not None
            or self.allowed_claude is not None
        )

    def marker_excluded_ids(self) -> set[str]:
        """Root sessions excluded by a marker, remembered across runs."""
        return self.markers.excluded_ids() if self.markers is not None else set()

    def _scope_keys(self, cwds: Iterable[str | None]) -> set[str]:
        keys: set[str] = set()
        for cwd in cwds:
            if isinstance(cwd, str) and os.path.isabs(cwd):
                keys |= {
                    _path_key(os.path.normpath(cwd)),
                    _path_key(os.path.realpath(cwd)),
                }
        return keys

    def _codex_scope_reason(self, cwds: Iterable[str | None]) -> str | None:
        """Codex sessions in a marker-scoped folder cannot be classified yet: hold."""
        if self.markers is not None and self.markers.in_scope(self._scope_keys(cwds)):
            return MARKER_UNVERIFIED
        return None

    def _claude_marker_reason(
        self,
        native: str,
        parent: str | None,
        source_home: Path | None,
        source_path: Path | None,
        observed: set[str],
        source_kind: str | None = None,
    ) -> str | None:
        """Classify a Claude session whose root session ran in a marker-scoped folder.

        A hook observation file is not a transcript: the session's own
        transcript is looked up instead.
        """
        if source_kind == "hook":
            source_path = None
        markers = self.markers
        if markers is None:
            return None
        root = parent or native
        roots, agents = (
            self._claude_index(source_home) if source_home is not None else ({}, {})
        )
        if source_path is not None and parent is None and source_path.stem.lower() == root:
            root_path: Path | None = source_path
        else:
            root_path = roots.get(root)
        if source_path is not None:
            own_path: Path | None = source_path
        elif parent is not None:
            own_path = agents.get((parent, native))
        else:
            own_path = root_path
        root_cwd = self._file_cwd(root_path) if root_path is not None else None
        own_cwd = self._file_cwd(own_path) if own_path is not None else None
        if root_cwd is None:
            # Without the root session's folder its scope is unknown.
            return MARKER_UNVERIFIED
        if not markers.in_scope(self._scope_keys(set(observed) | {root_cwd, own_cwd})):
            return None
        # A subagent with no transcript of its own is held by the classifier
        # (unless it was already excluded).
        return markers.claude_reason(
            root,
            native,
            root_path,
            own_path if parent is not None else None,
        )

    def blocked_reason(
        self,
        provider: str,
        native_session_id: object,
        parent_native_session_id: object = None,
        *,
        source_home: Path | None = None,
        source_path: Path | None = None,
        observed_cwds: Iterable[str] = (),
        native_fragments: Iterable[tuple[int, int, str]] = (),
        source_kind: str | None = None,
        observed_repositories: Iterable[str] = (),
        hook_state_root: Path | None = None,
    ) -> str | None:
        """Return why this source/batch must not be captured or uploaded.

        ``source_home`` is the provider home (Codex home, or the Claude home or
        its ``projects`` directory) used to resolve sessions and their parents.
        ``observed_cwds`` are working directories recorded in the bytes being
        uploaded, such as those of an already-queued batch.
        ``native_fragments`` are (start, end, sha256) of oversized native records
        a batch carries only part of; each is classified by the complete record,
        read back from its source file, and held when that cannot be verified.
        ``source_kind`` ``hook`` with provider ``codex`` selects the Codex
        hook-only branch (sessions with no rollout, such as side-conversation
        forks; see ``_codex_hook_reason``). ``observed_repositories`` are git
        remotes recorded in the bytes being uploaded, and ``hook_state_root`` is
        the collector state root holding the Codex hook session markers.
        """
        if not self.active:
            return None
        if self.error:
            return UNREADABLE
        native = _normalize(native_session_id)
        parent = _normalize(parent_native_session_id)
        native_fragments = tuple(native_fragments)
        if self.excluded_projects and native_fragments:
            fragment_cwds = self._fragment_cwds(
                provider, native, parent, source_home, native_fragments
            )
            if fragment_cwds is None:
                return UNVERIFIED
            observed_cwds = set(observed_cwds) | fragment_cwds
        if provider == "claude_code":
            if {native, parent} & self.excluded:
                return EXCLUDED
            if native is None:
                return UNVERIFIED
            if self.excluded_projects:
                blocked = self._claude_project_reason(
                    native, parent, source_home, source_path, set(observed_cwds)
                )
                if blocked:
                    return blocked
            if self.markers is not None:
                blocked = self._claude_marker_reason(
                    native,
                    parent,
                    source_home,
                    source_path,
                    set(observed_cwds),
                    source_kind,
                )
                if blocked:
                    return blocked
            if self.allowed_claude is not None and (
                parent is not None or native not in self.allowed_claude
            ):
                return NOT_ALLOWED
            return None
        if not (self.excluded or self.excluded_projects or self.markers is not None):
            return None
        if provider == "codex" and source_kind == "hook":
            return self._codex_hook_reason(
                native,
                parent,
                source_home,
                source_path,
                set(observed_cwds),
                set(observed_repositories),
                hook_state_root,
            )
        if {native, parent} & self.excluded:
            return EXCLUDED
        blocked = self._cwds_reason(set(observed_cwds)) or self._codex_scope_reason(
            observed_cwds
        )
        if blocked:
            return blocked
        codex_home = source_home
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
            own, ancestors, cwd, repository = meta
            if ({own} | ancestors) & self.excluded:
                return EXCLUDED
            blocked = self._session_reason(cwd, repository)
            if blocked:
                return blocked
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
            meta = self._ancestors(current, codex_home)
            if meta is None:
                return UNVERIFIED
            ancestors, cwd, repository = meta
            if ancestors & self.excluded:
                return EXCLUDED
            blocked = self._session_reason(cwd, repository)
            if blocked:
                return blocked
            pending.extend(ancestors - seen)
        return None

    def _codex_hook_reason(
        self,
        native: str | None,
        parent: str | None,
        codex_home: Path | None,
        source_path: Path | None,
        cwds: set[str],
        repositories: set[str],
        hook_state_root: Path | None,
    ) -> str | None:
        """Classify a Codex hook-only observation (no rollout, no session_meta).

        In order: the session or its parent excluded; no session id; no
        working directory while project exclusions exist; an excluded
        directory or repository remote; the recorded ancestry of a known
        parent. A session with no known parent is held while any session ids
        are excluded, so a fork of an excluded session never leaves the machine.
        The parent is the one the observation names, else the one its
        SessionStart named (kept in the local session marker).
        """
        if source_path is not None and hook_state_root is None and (
            source_path.parent.name == CODEX_HOOK_EVENTS
        ):
            hook_state_root = source_path.parent.parent
        marker = _codex_hook_marker(hook_state_root, native)
        marker_parent = _normalize(marker.get("parent_native_session_id")) if marker else None
        known_parent = parent or marker_parent
        if {native, parent, marker_parent} & self.excluded:
            return EXCLUDED
        if native is None:
            return UNVERIFIED
        if source_path is not None:
            record = _codex_hook_record(source_path)
            if record is None or record[0] != native:
                return UNVERIFIED
            _, own_parent, cwd, repository = record
            if own_parent is not None:
                if own_parent in self.excluded:
                    return EXCLUDED
                known_parent = known_parent or own_parent
            if cwd is not None:
                cwds.add(cwd)
            if repository is not None:
                repositories.add(repository)
        marker_cwd = marker.get("cwd") if marker else None
        if isinstance(marker_cwd, str) and os.path.isabs(marker_cwd):
            cwds.add(marker_cwd)
        if self.excluded_projects:
            if not cwds:
                return UNVERIFIED
            blocked = self._cwds_reason(cwds)
            if blocked:
                return blocked
            excluded_repositories = self._excluded_repositories()
            if any(
                _repository_key(repository) in excluded_repositories
                for repository in repositories
            ):
                return EXCLUDED_PROJECT
        if self.markers is not None:
            if not cwds:
                return MARKER_UNVERIFIED
            blocked = self._codex_scope_reason(cwds)
            if blocked:
                return blocked
        if known_parent is None:
            return UNVERIFIED if self.excluded else None
        seen: set[str] = {native}
        pending = [known_parent]
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            if len(seen) > MAX_ANCESTRY_DEPTH:
                return UNVERIFIED
            meta = self._ancestors(current, codex_home)
            if meta is None:
                # A fork of a fork: the parent has no rollout either, so its
                # own SessionStart marker continues the chain.
                meta = _codex_hook_marker_ancestry(hook_state_root, current)
                if meta is None:
                    return UNVERIFIED
                if not meta[0] and self.excluded:
                    return UNVERIFIED  # The chain ends without a verified root.
            ancestors, cwd, repository = meta
            if ancestors & self.excluded:
                return EXCLUDED
            blocked = self._session_reason(cwd, repository)
            if blocked:
                return blocked
            pending.extend(ancestors - seen)
        return None

    def _fragment_cwds(
        self,
        provider: str,
        native: str | None,
        parent: str | None,
        source_home: Path | None,
        fragments: tuple[tuple[int, int, str], ...],
    ) -> set[str] | None:
        """Directories in the complete native records behind fragment batches."""
        if native is None or source_home is None:
            return None
        if provider == "claude_code":
            roots, agents = self._claude_index(source_home)
            source = agents.get((parent, native)) if parent else roots.get(native)
            candidates = [source] if source is not None else []
        else:
            candidates = [
                path for path in self._index(source_home).get(native, ())
                if (_session_meta_ids(path) or (None,))[0] == native
            ]
        cwds: set[str] = set()
        for start, end, digest in fragments:
            for path in candidates:
                # Fragments of one record share a single verified read per run.
                key = ("record-cwds", str(path), start, end, digest)
                if key not in self._ancestry:
                    self._ancestry[key] = _record_range_cwds(path, start, end, digest)
                found = self._ancestry[key]
                if found is not None:
                    cwds |= found
                    break
            else:
                return None
        return cwds

    def _session_reason(self, cwd: str | None, repository: str | None) -> str | None:
        """Codex sessions also record their repository, which outlives a
        removed worktree: a remote of an excluded checkout excludes them."""
        if repository is not None and repository in self._excluded_repositories():
            return EXCLUDED_PROJECT
        return self._cwd_reason(cwd) or self._codex_scope_reason((cwd,))

    def _excluded_repositories(self) -> frozenset[str]:
        if "repositories" not in self._ancestry:
            self._ancestry["repositories"] = frozenset(
                remote
                for project in self.excluded_project_paths
                # Patterns match by path only: a folder created later that
                # carries an E3 repository's remote must not exclude that repo.
                if not is_project_pattern(project)
                for remote in _project_remotes(project)
            )
        return self._ancestry["repositories"]

    def _cwd_reason(self, cwd: str | None) -> str | None:
        if not self.excluded_projects:
            return None
        if cwd is None:
            return UNVERIFIED
        return self._cwds_reason({cwd})

    def _cwds_reason(self, cwds: set[str]) -> str | None:
        if not self.excluded_projects or not cwds:
            return None
        if any(map(self.project_excluded, cwds)):
            return EXCLUDED_PROJECT
        if self._worktree_origins() is None:
            return ORIGINS_UNREADABLE
        return None

    def project_excluded(self, cwd: str) -> bool:
        """Whether a working directory lies in an excluded project."""
        key = ("cwd", cwd)
        if key not in self._ancestry:
            self._ancestry[key] = any(
                _under(candidate, project)
                for candidate in self._cwd_candidates(cwd)
                for project in self.excluded_projects
            )
        return self._ancestry[key]

    def _cwd_candidates(self, cwd: str) -> set[str]:
        """Every spelling of cwd and the checkouts of any git worktree containing it.

        Recorded worktree roots always apply to every directory inside them, so
        a removed (or since recreated) worktree keeps classifying its sessions.
        """
        normalized = os.path.normpath(cwd)
        resolved = os.path.realpath(cwd)
        found = {**_git_origins(normalized), **_git_origins(resolved)}
        if found:
            self._remember_worktrees(found)
        origins = set(found.values())
        spellings = {_path_key(normalized), _path_key(resolved)}
        for root, recorded in (self._worktree_origins() or {}).items():
            prefix = _path_key(root).rstrip(os.sep)
            if any(value == prefix or value.startswith(prefix + os.sep) for value in spellings):
                origins.update(recorded)
        candidates = {normalized, resolved} | origins
        candidates |= {os.path.realpath(origin) for origin in origins}
        return {_path_key(candidate) for candidate in candidates}

    def _worktree_origins(self) -> dict[str, list[str]] | None:
        """Recorded origins; None when the record exists but cannot be read."""
        if "worktree-origins" not in self._ancestry:
            self._ancestry["worktree-origins"] = _read_worktree_origins(
                self.worktree_origins_path
            )
        return self._ancestry["worktree-origins"]

    def _remember_worktrees(self, found: Mapping[str, str]) -> None:
        """Record each worktree root and the checkout it belongs to."""
        known = self._worktree_origins()
        path = self.worktree_origins_path
        if known is None or path is None or all(
            origin in known.get(root, ()) for root, origin in found.items()
        ):
            return
        try:
            with secure_lock(path.with_name(f".{path.name}.lock")) as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                current = _read_worktree_origins(path)
                if current is None:
                    self._ancestry["worktree-origins"] = None
                    return  # Never replace a record that cannot be read.
                for root, origin in found.items():
                    current[root] = sorted(set(current.get(root, ())) | {origin})
                _atomic_json(path, {"version": 1, "origins": current})
        except OSError:
            return  # Best effort: a live worktree still resolves from disk.
        self._ancestry["worktree-origins"] = current

    def _file_cwd(self, path: Path) -> str | None:
        key = ("file-cwd", str(path))
        if key not in self._ancestry:
            self._ancestry[key] = _first_cwd(path)
        return self._ancestry[key]

    def _claude_project_reason(
        self,
        native: str,
        parent: str | None,
        source_home: Path | None,
        source_path: Path | None,
        observed: set[str],
    ) -> str | None:
        """Check the source's own directories and its root session's directory.

        Excluded when any of them is; unverified unless both the source's own
        directory and the root session's directory are known.
        """
        root = parent or native
        own = set(observed)
        root_cwd = None
        roots, agents = (
            self._claude_index(source_home) if source_home is not None else ({}, {})
        )
        if source_path is not None:
            cwd = self._file_cwd(source_path)
            if cwd is not None:
                own.add(cwd)
                if parent is None and source_path.stem.lower() == root:
                    root_cwd = cwd
        elif parent is not None and (parent, native) in agents:
            cwd = self._file_cwd(agents[(parent, native)])
            if cwd is not None:
                own.add(cwd)
        if root_cwd is None and root in roots:
            root_cwd = self._file_cwd(roots[root])
        if source_path is None and parent is None and root_cwd is not None:
            own.add(root_cwd)
        blocked = self._cwds_reason(own | ({root_cwd} if root_cwd else set()))
        if blocked:
            return blocked
        if root_cwd is None or not own:
            return UNVERIFIED
        return None

    def _ancestors(
        self, session_id: str, codex_home: Path | None
    ) -> tuple[set[str], str | None, str | None] | None:
        """Ancestor ids, cwd and repository recorded by the rollout whose session_meta is session_id.

        None means the ancestry cannot be verified (missing or unreadable file);
        callers then fail closed. One filename index per home keeps this to a
        single directory walk per process, however many ancestors are checked.
        """
        if session_id in self._ancestry:
            return self._ancestry[session_id]
        result: tuple[set[str], str | None, str | None] | None = None
        for path in self._index(codex_home).get(session_id, ()):
            meta = _session_meta_ids(path)
            if meta is not None and meta[0] == session_id:
                result = meta[1], meta[2], meta[3]
                break
        self._ancestry[session_id] = result
        return result

    def _index(self, codex_home: Path | None) -> Mapping[str, list[Path]]:
        key = ("index", str(codex_home))
        if key not in self._ancestry:
            self._ancestry[key] = _rollout_index(codex_home)
        return self._ancestry[key]

    def _claude_index(
        self, claude_home: Path
    ) -> tuple[Mapping[str, Path], Mapping[tuple[str, str], Path]]:
        key = ("claude-index", str(claude_home))
        if key not in self._ancestry:
            self._ancestry[key] = _claude_transcript_index(claude_home)
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
        projects = _project_paths(raw)
        project_paths = tuple(
            sorted({normalize_project_path(v) for v in raw.get("excluded_project_paths", [])})
        )
        scoped, session_markers = parse_markers(raw)
        marker_allowed = parse_marker_allowed(raw)
    except (ValueError, UnicodeDecodeError) as error:
        return ExclusionPolicy(error=str(error))
    classifier = None
    if scoped:
        keys: set[str] = set()
        for value in scoped:
            keys |= {_path_key(value), _path_key(os.path.realpath(value))}
        classifier = MarkerClassifier(
            scoped_keys=frozenset(keys),
            markers=session_markers,
            state_path=path.parent / MARKER_STATE_NAME,
            allowed_roots=marker_allowed,
            fingerprint=settings_fingerprint(session_markers, project_paths),
        )
    policy = ExclusionPolicy(
        markers=classifier,
        excluded=excluded,
        allowed_claude=allowed,
        excluded_projects=projects,
        excluded_project_paths=project_paths,
        worktree_origins_path=path.parent / WORKTREE_ORIGINS_NAME,
    )
    if classifier is not None:
        classifier.path_excluded = policy.project_excluded
    return policy


def _read_worktree_origins(path: Path | None) -> dict[str, list[str]] | None:
    """Recorded worktree roots and the checkouts they belonged to.

    No record means nothing is known; a record that exists but cannot be read
    returns None so callers fail closed instead of forgetting exclusions.
    """
    if path is None:
        return {}
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError:
        return None
    try:
        raw = json.loads(data)
    except ValueError:
        return None
    origins = raw.get("origins") if isinstance(raw, dict) else None
    if isinstance(origins, dict):
        # Earlier records stored one origin per directory as a string.
        origins = {
            key: [values] if isinstance(values, str) else values
            for key, values in origins.items()
        }
    if not isinstance(origins, dict) or not all(
        isinstance(key, str)
        and isinstance(values, list)
        and all(isinstance(value, str) and os.path.isabs(value) for value in values)
        for key, values in origins.items()
    ):
        return None
    return origins


def _read_policy_object(path: Path) -> dict | None:
    """The validated policy object, or None when there is no policy file."""
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    if len(data) > MAX_POLICY_BYTES:
        raise ValueError("policy file is too large")
    raw = json.loads(data)
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise ValueError("policy must be an object with version 1")
    _id_list(raw, "excluded_session_ids")
    _id_list(raw, "allowed_claude_session_ids")
    _project_paths(raw)
    parse_markers(raw)
    return raw


def excluded_project_paths(path: Path | None = None) -> list[str]:
    raw = _read_policy_object(path or policy_path()) or {}
    return sorted({normalize_project_path(v) for v in raw.get("excluded_project_paths", [])})


def update_project_exclusions(
    add: Iterable[str] = (),
    remove: Iterable[str] = (),
    path: Path | None = None,
) -> list[str]:
    """Add or remove excluded project paths, keeping every other policy field.

    An existing file that is unreadable or invalid is never overwritten.
    Returns the resulting excluded project paths.
    """
    path = path or policy_path()
    added = {_absolute_project_path(value) for value in add}
    removed = {_absolute_project_path(value, for_removal=True) for value in remove}
    if os.sep in added or os.sep in {_resolved_project_path(value) for value in added}:
        raise ValueError("refusing to exclude the filesystem root")
    # Serialize read-modify-write so concurrent edits cannot drop each other.
    with secure_lock(path.with_name(f".{path.name}.lock")) as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        raw = _read_policy_object(path) or {"version": 1}
        current = {normalize_project_path(v) for v in raw.get("excluded_project_paths", [])}
        removed_keys = {_path_key(value) for value in removed}
        result = sorted(
            value for value in current | added
            if not {_path_key(value), _path_key(_resolved_project_path(value))} & removed_keys
        )
        raw["excluded_project_paths"] = result
        _atomic_json(path, raw)
    return result


def _open_regular(path: Path):
    """Open without blocking on a FIFO or following a final symlink."""
    descriptor = os.open(
        path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    )
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        return None
    return os.fdopen(descriptor, "rb")


def _session_meta_ids(
    path: Path,
) -> tuple[str, set[str], str | None, str | None] | None:
    """Return (own id, ancestor ids, cwd, repository) from a Codex rollout's first session_meta."""
    try:
        handle = _open_regular(path)
        if handle is None:
            return None
        with handle:
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
    cwd = payload.get("cwd")
    git = payload.get("git")
    return (
        own,
        {value for value in ancestors if value and value != own},
        cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None,
        _repository_key(git.get("repository_url")) if isinstance(git, dict) else None,
    )


_DEFAULT_PORTS = {"https": 443, "http": 80, "ssh": 22, "git": 9418}
# Hosts that treat repository paths case-insensitively.
_CASE_INSENSITIVE_HOSTS = frozenset({"github.com", "gitlab.com", "bitbucket.org"})


def _repository_key(url: object) -> str | None:
    """Comparable host[:port]/path of a git remote (https, ssh or scp-like)."""
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip()
    port = None
    if "://" in url:
        parts = urlsplit(url)
        try:
            port = parts.port
        except ValueError:
            return None
        host, path = parts.hostname or "", parts.path
        if port == _DEFAULT_PORTS.get(parts.scheme.lower()):
            port = None
    elif ":" in url and not url.startswith("/"):
        host, path = url.split(":", 1)
        host = host.rsplit("@", 1)[-1].lower()
    else:
        return None  # Local paths are matched as directories instead.
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not host or not path:
        return None
    if host in _CASE_INSENSITIVE_HOSTS:
        path = path.lower()
    return f"{host}:{port}/{path}" if port else f"{host}/{path}"


def _git_config_value(raw: str) -> str:
    """Decode a git config value: quotes, backslash escapes, inline comments."""
    escapes = {"n": "\n", "t": "\t", "b": "\b", '"': '"', "\\": "\\"}
    result, quoted, pending_space, index = [], False, "", 0
    raw = raw.strip()
    while index < len(raw):
        character = raw[index]
        if character == "\\" and index + 1 < len(raw):
            result.append(pending_space + escapes.get(raw[index + 1], raw[index + 1]))
            pending_space, index = "", index + 2
            continue
        if character == '"':
            quoted = not quoted
        elif not quoted and character in "#;":
            break
        elif not quoted and character.isspace():
            pending_space += character
        else:
            result.append(pending_space + character)
            pending_space = ""
        index += 1
    return "".join(result)


def _origin_urls(config: str | None) -> list[str]:
    """Decoded ``url`` values of ``[remote "origin"]`` in a git config file."""
    if config is None:
        return []
    try:
        with open(config, "rb") as handle:
            text = handle.read(MAX_GIT_FILE_BYTES * 16).decode("utf-8", "replace")
    except OSError:
        return []
    # A backslash at the end of a line continues the value on the next one.
    lines = re.sub(r"(?<!\\)((?:\\\\)*)\\\r?\n", r"\1", text).splitlines()
    urls: list[str] = []
    in_origin = False
    for line in lines:
        line = line.strip()
        if line.startswith("["):
            header = line.split("]", 1)[0] + "]"  # ignore a trailing comment
            in_origin = header.replace(" ", "").lower() in {'[remote"origin"]', "[remote.origin]"}
        elif in_origin and "=" in line and line.split("=", 1)[0].strip().lower() == "url":
            urls.append(_git_config_value(line.split("=", 1)[1]))
    return urls


def _project_remotes(project: str) -> set[str]:
    """The origin remote of an excluded main checkout or bare repository.

    Only origin is used, as that is what Codex records; linked worktrees and
    repositories nested in an excluded directory are matched by path instead,
    so unrelated clones of their remotes are not excluded.
    """
    return {
        key
        for url in _origin_urls(_git_config_path(project))
        if (key := _repository_key(url))
    }


def _git_directories(cwd: str) -> tuple[str, str] | None:
    """(git dir, common dir) of the checkout or linked worktree containing cwd.

    Reads local files only (no git subprocess); the nearest ``.git`` wins.
    """
    current = os.path.normpath(cwd)
    while True:
        marker = os.path.join(current, ".git")
        if os.path.isdir(marker):
            return marker, marker
        if os.path.isfile(marker):
            gitdir = _git_pointer(marker, "gitdir:")
            if gitdir is None:
                return None
            gitdir = os.path.normpath(os.path.join(current, gitdir))
            common = _git_pointer(os.path.join(gitdir, "commondir"), "")
            common = os.path.normpath(os.path.join(gitdir, common)) if common else gitdir
            return gitdir, common
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _without_credentials(url: str) -> str:
    """Drop user info, query and fragment (which can hold a token) from a URL remote."""
    if "://" not in url:
        return url
    parts = urlsplit(url)
    host = parts.netloc.rsplit("@", 1)[-1]
    return parts._replace(netloc=host, query="", fragment="").geturl()


def origin_remote_url(cwd: object) -> str | None:
    """The origin remote of the git checkout containing cwd, without credentials."""
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return None
    directories = _git_directories(cwd)
    if directories is None:
        return None
    config = os.path.join(directories[1], "config")
    for url in _origin_urls(config if os.path.isfile(config) else None):
        if url.strip():
            return _without_credentials(url.strip())
    return None


def head_branch(cwd: object) -> str | None:
    """The branch checked out at cwd (None when detached or unknown)."""
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return None
    directories = _git_directories(cwd)
    if directories is None:
        return None
    ref = _git_pointer(os.path.join(directories[0], "HEAD"), "ref:")
    prefix = "refs/heads/"
    if ref is None or not ref.startswith(prefix) or len(ref) == len(prefix):
        return None
    return ref[len(prefix):]


def _git_config_path(checkout: str) -> str | None:
    """Config of a main checkout or bare repository (not of a linked worktree)."""
    marker = os.path.join(checkout, ".git")
    if os.path.isdir(marker):
        common = marker
    elif os.path.isfile(os.path.join(checkout, "HEAD")) and os.path.isdir(
        os.path.join(checkout, "objects")
    ):
        common = checkout  # bare repository
    else:
        return None
    config = os.path.join(common, "config")
    return config if os.path.isfile(config) else None


def _first_cwd(path: Path) -> str | None:
    """First absolute working directory named by a transcript or hook observation.

    Claude transcripts carry ``cwd`` on most records, though not on the first
    queue records; Sherlock hook observations carry it in the encoded hook
    payload. Overlong records are skipped without being parsed.
    """
    try:
        handle = _open_regular(path)
        if handle is None:
            return None
        with handle:
            remaining = MAX_CWD_SCAN_BYTES
            while remaining > 0:
                line = handle.readline(min(remaining, MAX_SOURCE_BYTES))
                if not line:
                    return None
                remaining -= len(line)
                if not line.endswith(b"\n"):
                    while line and not line.endswith(b"\n") and remaining > 0:
                        line = handle.readline(min(remaining, MAX_SOURCE_BYTES))
                        remaining -= len(line)
                    continue
                if b"cwd" not in line and b"payload_base64" not in line:
                    continue
                try:
                    record = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                cwd = _record_cwd(record)
                if cwd is not None:
                    return cwd
    except OSError:
        return None
    return None


def observed_cwds(source: bytes) -> set[str]:
    """Working directories named anywhere in a source byte range.

    Complete records are parsed; ``"cwd"`` fields are also matched in the raw
    bytes so fragments of an oversized record still classify their batch.
    Escaped occurrences inside string values do not match.
    """
    cwds: set[str] = set()
    for match in _CWD_FIELD.finditer(source):
        try:
            cwd = json.loads(b'"' + match.group(1) + b'"')
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(cwd, str) and os.path.isabs(cwd):
            cwds.add(cwd)
    for line in source.splitlines():
        if b"cwd" not in line and b"payload_base64" not in line:
            continue
        try:
            cwd = _record_cwd(json.loads(line))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if cwd is not None:
            cwds.add(cwd)
    return cwds


def observed_repositories(source: bytes) -> set[str]:
    """Git remotes recorded by Codex hook observations in a source byte range."""
    remotes: set[str] = set()
    for line in source.splitlines():
        if b"codex_hook" not in line:
            continue
        try:
            record = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        git = record.get("git") if isinstance(record, dict) else None
        if record.get("type") == "codex_hook" and isinstance(git, dict):
            url = git.get("repository_url")
            if isinstance(url, str) and url.strip():
                remotes.add(url)
    return remotes


def _codex_hook_record(
    path: Path,
) -> tuple[str | None, str | None, str | None, str | None] | None:
    """(session id, parent id, cwd, repository) of a Codex hook observation file.

    None when the file is not a readable Codex hook observation.
    """
    try:
        handle = _open_regular(path)
        if handle is None:
            return None
        with handle:
            data = handle.read(MAX_SOURCE_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_SOURCE_BYTES:
        return None
    try:
        record = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or record.get("type") != "codex_hook":
        return None
    git = record.get("git")
    repository = git.get("repository_url") if isinstance(git, dict) else None
    return (
        _normalize(record.get("native_session_id")),
        _normalize(record.get("parent_native_session_id")),
        _record_cwd(record),
        repository if isinstance(repository, str) and repository.strip() else None,
    )


def _codex_hook_marker(state_root: Path | None, session_id: str | None) -> dict | None:
    """The local marker the Codex hook wrote when a hook-only session started."""
    if state_root is None or session_id is None or not _UUID.fullmatch(session_id):
        return None
    try:
        handle = _open_regular(Path(state_root) / CODEX_HOOK_SESSIONS / f"{session_id}.json")
        if handle is None:
            return None
        with handle:
            value = json.loads(handle.read(MAX_SESSION_META_BYTES))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or _normalize(value.get("native_session_id")) != session_id:
        return None
    return value


def _codex_hook_marker_ancestry(
    state_root: Path | None, session_id: str
) -> tuple[set[str], str | None, str | None] | None:
    """(parent ids, cwd, repository) a hook-only fork's marker records, like _ancestors."""
    marker = _codex_hook_marker(state_root, session_id)
    if marker is None or marker.get("source") != "fork":
        return None
    parent = _normalize(marker.get("parent_native_session_id"))
    cwd = marker.get("cwd")
    return (
        {parent} - {None, session_id},
        cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None,
        _repository_key(marker.get("repository_url")),
    )


def _record_range_cwds(path: Path, start: int, end: int, digest: str) -> set[str] | None:
    """Directories in bytes [start, end) of path, or None unless they hash to digest."""
    overlap = 64 * 1024
    try:
        handle = _open_regular(path)
        if handle is None:
            return None
        with handle:
            handle.seek(start)
            hasher, cwds, tail, remaining = hashlib.sha256(), set(), b"", end - start
            while remaining > 0:
                chunk = handle.read(min(remaining, 4 * 1024 * 1024))
                if not chunk:
                    return None
                remaining -= len(chunk)
                hasher.update(chunk)
                window = tail + chunk
                cwds |= observed_cwds(window)
                tail = window[-overlap:]
    except OSError:
        return None
    return cwds if hasher.hexdigest() == digest else None


def _record_cwd(record: object) -> str | None:
    if not isinstance(record, dict):
        return None
    for container in (record, record.get("payload")):
        if isinstance(container, dict):
            cwd = container.get("cwd")
            if isinstance(cwd, str) and os.path.isabs(cwd):
                return cwd
    encoded = record.get("payload_base64")
    if record.get("type") in HOOK_OBSERVATION_TYPES and isinstance(encoded, str):
        try:
            payload = json.loads(base64.b64decode(encoded, validate=True))
        except (ValueError, UnicodeDecodeError):
            return None
        if isinstance(payload, dict):
            cwd = payload.get("cwd")
            if isinstance(cwd, str) and os.path.isabs(cwd):
                return cwd
    return None


def _git_origins(cwd: str) -> dict[str, str]:
    """Map each git worktree or submodule root containing cwd to its owning checkout.

    Reads local git pointer files only and continues past nested repositories
    and submodules, so a repository inside a linked worktree still maps to that
    worktree's origin. A bare repository's origin is its git directory.
    """
    origins: dict[str, str] = {}
    current = cwd
    while True:
        marker = os.path.join(current, ".git")
        gitdir = _git_pointer(marker, "gitdir:") if os.path.isfile(marker) else None
        if gitdir is not None:
            gitdir = os.path.normpath(os.path.join(current, gitdir))
            common = _git_pointer(os.path.join(gitdir, "commondir"), "")
            common = os.path.normpath(os.path.join(gitdir, common)) if common else gitdir
            origins[current] = (
                os.path.dirname(common) if os.path.basename(common) == ".git" else common
            )
        parent = os.path.dirname(current)
        if parent == current:
            return origins
        current = parent


def _git_pointer(path: str, prefix: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            text = handle.read(MAX_GIT_FILE_BYTES).decode("utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not text.startswith(prefix):
        return None
    return text[len(prefix):].strip() or None


def _claude_transcript_index(
    claude_home: Path,
) -> tuple[dict[str, Path], dict[tuple[str, str], Path]]:
    """Index Claude root transcripts by session id and subagent transcripts by
    (root session id, agent id), from ``projects/<project>/<id>.jsonl`` and
    ``projects/<project>/<id>/subagents/**/agent-<agent>.jsonl``.
    """
    roots: dict[str, Path] = {}
    agents: dict[tuple[str, str], Path] = {}
    projects = claude_home / "projects"
    if not projects.is_dir() or projects.is_symlink():
        projects = claude_home
    if projects.is_symlink() or not projects.is_dir():
        return roots, agents
    try:
        project_directories = list(os.scandir(projects))
    except OSError:
        return roots, agents
    for project in project_directories:
        if not project.is_dir(follow_symlinks=False):
            continue
        try:
            entries = list(os.scandir(project.path))
        except OSError:
            continue
        for entry in entries:
            name = entry.name.lower()
            if name.endswith(".jsonl") and _UUID.fullmatch(name[:-6]):
                roots.setdefault(name[:-6], Path(entry.path))
            elif _UUID.fullmatch(name) and entry.is_dir(follow_symlinks=False):
                subagents = os.path.join(entry.path, "subagents")
                if os.path.islink(subagents):
                    continue
                for directory, directories, files in os.walk(subagents):
                    directories[:] = [
                        child for child in directories
                        if not os.path.islink(os.path.join(directory, child))
                    ]
                    for file_name in files:
                        lowered = file_name.lower()
                        if lowered.startswith("agent-") and lowered.endswith(".jsonl"):
                            agents.setdefault(
                                (name, lowered[len("agent-"):-len(".jsonl")]),
                                Path(directory) / file_name,
                            )
    return roots, agents


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
