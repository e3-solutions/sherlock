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
* ``allowed_claude_session_ids`` (optional): when present, only these Claude
  root sessions are captured or uploaded; Claude subagent transcripts are not.

No file means no policy. A file that exists but cannot be read or validated
fails closed: nothing is captured or uploaded until it is repaired. A session
whose working directory cannot be read yet while project exclusions exist is
held the same way. Blocked sources keep their cursor and blocked queued
batches stay queued, so removing an entry later resumes collection without
loss. The policy never leaves the machine; locally, transcripts are read only
up to the Codex session metadata or the first record naming a working
directory.
"""

from __future__ import annotations

import base64
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
# A top-level "cwd" field, also inside a fragment of a record too large to parse.
_CWD_FIELD = re.compile(rb'"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
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


def normalize_project_path(value: object) -> str:
    """Absolute, normalized form of a configured project directory."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("project paths must be non-empty strings")
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path):
        raise ValueError("project paths must be absolute")
    return os.path.normpath(path)


def _absolute_project_path(value: str) -> str:
    """Resolve a command-line path as the filesystem would, symlinks before "..".

    Relative paths are taken from the current directory.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("project paths must be non-empty strings")
    return normalize_project_path(os.path.realpath(os.path.expanduser(value.strip())))


def _project_paths(raw: dict) -> frozenset[str]:
    values = raw.get("excluded_project_paths", [])
    if not isinstance(values, list):
        raise ValueError("excluded_project_paths must be a list of strings")
    keys: set[str] = set()
    for value in values:
        normalized = normalize_project_path(value)
        # Resolve symlinks before collapsing "..", as the filesystem does, and
        # keep the lexical spelling too (for example /tmp and /private/tmp).
        resolved = os.path.realpath(os.path.expanduser(value.strip()))
        if os.sep in (normalized, resolved):
            raise ValueError("excluded_project_paths must not exclude the filesystem root")
        keys |= {_path_key(normalized), _path_key(resolved)}
    return frozenset(keys)


def _path_key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold() if _FOLD_CASE else path


@dataclass(frozen=True)
class ExclusionPolicy:
    excluded: frozenset[str] = frozenset()
    allowed_claude: frozenset[str] | None = None
    excluded_projects: frozenset[str] = frozenset()
    excluded_project_paths: tuple[str, ...] = ()
    worktree_origins_path: Path | None = None
    error: str | None = None
    _ancestry: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def active(self) -> bool:
        return bool(
            self.error
            or self.excluded
            or self.excluded_projects
            or self.allowed_claude is not None
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
    ) -> str | None:
        """Return why this source/batch must not be captured or uploaded.

        ``source_home`` is the provider home (Codex home, or the Claude home or
        its ``projects`` directory) used to resolve sessions and their parents.
        ``observed_cwds`` are working directories recorded in the bytes being
        uploaded, such as those of an already-queued batch.
        ``native_fragments`` are (start, end, sha256) of oversized native records
        a batch carries only part of; each is classified by the complete record,
        read back from its source file, and held when that cannot be verified.
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
            if self.allowed_claude is not None and (
                parent is not None or native not in self.allowed_claude
            ):
                return NOT_ALLOWED
            return None
        if not (self.excluded or self.excluded_projects):
            return None
        if {native, parent} & self.excluded:
            return EXCLUDED
        blocked = self._cwds_reason(set(observed_cwds))
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
                found = _record_range_cwds(path, start, end, digest)
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
        return self._cwd_reason(cwd)

    def _excluded_repositories(self) -> frozenset[str]:
        if "repositories" not in self._ancestry:
            self._ancestry["repositories"] = frozenset(
                remote
                for project in self.excluded_project_paths
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
                candidate == project or candidate.startswith(project.rstrip(os.sep) + os.sep)
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
    except (ValueError, UnicodeDecodeError) as error:
        return ExclusionPolicy(error=str(error))
    return ExclusionPolicy(
        excluded=excluded,
        allowed_claude=allowed,
        excluded_projects=projects,
        excluded_project_paths=tuple(
            sorted({normalize_project_path(v) for v in raw.get("excluded_project_paths", [])})
        ),
        worktree_origins_path=path.parent / WORKTREE_ORIGINS_NAME,
    )


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
    removed = {_absolute_project_path(value) for value in remove}
    if os.sep in added or os.sep in {os.path.realpath(value) for value in added}:
        raise ValueError("refusing to exclude the filesystem root")
    # Serialize read-modify-write so concurrent edits cannot drop each other.
    with secure_lock(path.with_name(f".{path.name}.lock")) as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        raw = _read_policy_object(path) or {"version": 1}
        current = {normalize_project_path(v) for v in raw.get("excluded_project_paths", [])}
        removed_keys = {_path_key(value) for value in removed}
        result = sorted(
            value for value in current | added
            if not {_path_key(value), _path_key(os.path.realpath(value))} & removed_keys
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


def _project_remotes(project: str) -> set[str]:
    """Remotes of the repository at project, or of repositories directly inside it."""
    remotes: set[str] = set()
    try:
        children = [entry.path for entry in os.scandir(project) if entry.is_dir(follow_symlinks=False)]
    except OSError:
        children = []
    for checkout in (project, *children):
        config = _git_config_path(checkout)
        if config is None:
            continue
        try:
            with open(config, "rb") as handle:
                lines = handle.read(MAX_GIT_FILE_BYTES * 16).decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        in_remote = False
        for line in lines:
            line = line.strip()
            if line.startswith("["):
                in_remote = line.lower().startswith("[remote ")
            elif in_remote and line.split("=", 1)[0].strip().lower() == "url" and "=" in line:
                key = _repository_key(_git_config_value(line.split("=", 1)[1]))
                if key:
                    remotes.add(key)
    return remotes


def _git_config_path(checkout: str) -> str | None:
    marker = os.path.join(checkout, ".git")
    if os.path.isdir(marker):
        common = marker
    elif os.path.isfile(marker):
        gitdir = _git_pointer(marker, "gitdir:")
        if gitdir is None:
            return None
        gitdir = os.path.normpath(os.path.join(checkout, gitdir))
        pointer = _git_pointer(os.path.join(gitdir, "commondir"), "")
        common = os.path.normpath(os.path.join(gitdir, pointer)) if pointer else gitdir
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
    if record.get("type") == "claude_hook" and isinstance(encoded, str):
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
