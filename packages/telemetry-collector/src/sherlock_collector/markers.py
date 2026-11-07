"""Owner session markers: exclude sessions by what they are, not where they ran.

Some owners start unrelated private work from a shared folder (for example a
personal project driven from the company workspace root), so a folder rule
cannot tell the two apart. The policy file can name such folders and the
markers that identify the private work::

    {"version": 1,
     "marker_scoped_project_paths": ["/Users/me/work"],
     "excluded_session_markers": ["myproject", "facebook"]}

``marker_scoped_project_paths`` are matched exactly (the folder itself, not
folders inside it, which are normally repositories with their own rules).
A Claude session whose root session ran there is classified before anything
is captured or uploaded. It is excluded when a marker (case-insensitive) appears in:

* the Claude desktop app's record of the session or of any session it was
  spawned or forked from: the title, the scheduled task name, or the spawning
  session's recorded title or name;
* the transcript of the root session or of the subagent being captured: the
  first real user prompt, a title record, or a file path a tool was given
  that lies in an excluded project folder (so a company session that only
  reads a note *about* the private work, or names a folder after it, is not
  caught by its paths).

It fails closed. When the root session's working directory, its app record
(or an ancestor's), its title or its transcript cannot be read yet, the
session is held (``session_marker_unverified``) and retried on a later run.
Codex sessions in a scoped folder are always held; nothing classifies them
yet.

An exclusion is sticky: it is remembered in ``session-marker-state.json``
next to the policy. A root session excluded this way is reported to Sherlock
like other excluded session ids, so copies uploaded before a marker appeared
are hidden too, with its subagents. A marker found only in a subagent's own
transcript excludes that subagent alone. ``marker_allowed_session_ids`` lists
root sessions the owner has checked are not private work; markers are not
applied to them (or their subagents). Transcripts are
scanned incrementally (append-only), so a session is read once in full and
then only its new bytes. Only lines that contain a marker, and the lines up
to the first real user prompt, are parsed. Nothing read here leaves the machine.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .spool import _atomic_json, secure_lock


EXCLUDED_MARKER = "excluded_by_session_marker"
MARKER_UNVERIFIED = "session_marker_unverified"

STATE_NAME = "session-marker-state.json"
STATE_VERSION = 1
MIN_MARKER_LENGTH = 3
MAX_MARKERS = 64
MAX_APP_RECORD_BYTES = 4 * 1024 * 1024
MAX_ANCESTRY = 64
# One run reads at most this much new transcript per file; the rest is read
# on later runs, and the session stays held until it has been read in full.
MAX_SCAN_BYTES_PER_RUN = 512 * 1024 * 1024
# And at most this much across all files in one run (one policy load).
MAX_SCAN_BYTES_PER_PROCESS = 2 * 1024 * 1024 * 1024
# A single JSONL line longer than this cannot be classified: hold.
MAX_LINE_BYTES = 64 * 1024 * 1024

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_PATH_FIELDS = frozenset(
    {"file_path", "path", "notebook_path", "cwd", "directory", "dir", "root", "paths", "file_paths"}
)
_COMMAND = re.compile(r"<command-(?:name|args)>(.*?)</command-(?:name|args)>", re.S)
_TITLE_TYPES = frozenset({"custom-title", "ai-title", "summary"})
_TITLE_FIELDS = ("customTitle", "aiTitle", "title", "summary")


def app_sessions_root() -> Path:
    configured = os.environ.get("SHERLOCK_CLAUDE_APP_SESSIONS")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude-code-sessions"
    return Path.home() / ".config" / "Claude" / "claude-code-sessions"


def parse_marker_allowed(raw: dict) -> frozenset[str]:
    values = raw.get("marker_allowed_session_ids", [])
    if not isinstance(values, list) or not all(
        isinstance(v, str) and _UUID.fullmatch(v.strip().lower()) for v in values
    ):
        raise ValueError("marker_allowed_session_ids must be a list of session ids")
    return frozenset(v.strip().lower() for v in values)


def parse_markers(raw: dict) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Validated (scoped project paths, markers); both empty when unused."""
    parse_marker_allowed(raw)
    scoped = raw.get("marker_scoped_project_paths", [])
    markers = raw.get("excluded_session_markers", [])
    if not isinstance(scoped, list) or not all(isinstance(v, str) and v.strip() for v in scoped):
        raise ValueError("marker_scoped_project_paths must be a list of non-empty strings")
    if not isinstance(markers, list) or not all(isinstance(v, str) for v in markers):
        raise ValueError("excluded_session_markers must be a list of strings")
    cleaned = tuple(sorted({v.strip().lower() for v in markers if v.strip()}))
    if not all(v.isascii() for v in cleaned):
        # Transcript bytes are matched case-insensitively for ASCII only.
        raise ValueError("session markers must be ASCII")
    if any(len(v) < MIN_MARKER_LENGTH for v in cleaned):
        raise ValueError(f"session markers must be at least {MIN_MARKER_LENGTH} characters")
    if len(cleaned) > MAX_MARKERS:
        raise ValueError("too many session markers")
    paths: list[str] = []
    for value in scoped:
        path = os.path.expanduser(value.strip())
        if not os.path.isabs(path):
            raise ValueError("marker_scoped_project_paths must be absolute")
        path = os.path.normpath(path)
        if path == os.sep:
            raise ValueError("marker_scoped_project_paths must not be the filesystem root")
        paths.append(path)
    if paths and not cleaned:
        # A scope with nothing to look for would silently capture everything.
        raise ValueError("marker_scoped_project_paths needs excluded_session_markers")
    return tuple(sorted(set(paths))), cleaned


def settings_fingerprint(markers: Iterable[str], excluded_paths: Iterable[str]) -> str:
    payload = json.dumps([sorted(markers), sorted(excluded_paths)])
    return hashlib.sha256(payload.encode()).hexdigest()


def _text_of(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
    return ""


def _path_values(value: object, depth: int = 0) -> Iterable[str]:
    if depth > 8:
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _PATH_FIELDS:
                if isinstance(item, str):
                    yield item
                elif isinstance(item, list):
                    yield from (v for v in item if isinstance(v, str))
            if isinstance(item, (dict, list)):
                yield from _path_values(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            yield from _path_values(item, depth + 1)


@dataclass
class MarkerClassifier:
    """Classifies sessions in scoped folders; one instance per policy load."""

    scoped_keys: frozenset[str]
    markers: tuple[str, ...]
    state_path: Path | None
    app_root: Path | None = None
    # Whether a tool path lies in an excluded project folder (set by the policy).
    path_excluded: Callable[[str], bool] | None = None
    allowed_roots: frozenset[str] = frozenset()
    # Identifies the markers and excluded folders a scan was made with; scans
    # made under other settings are discarded so their bytes are read again.
    fingerprint: str = ""
    _app_index: dict | None = field(default=None, repr=False)
    _refreshed: bool = field(default=False, repr=False)
    _pruned: bool = field(default=False, repr=False)
    _scanned_bytes: int = field(default=0, repr=False)
    _state: dict | None = field(default=None, repr=False)
    _verdicts: dict = field(default_factory=dict, repr=False)

    # -- markers ---------------------------------------------------------
    def hit(self, text: object) -> bool:
        if not isinstance(text, str) or not text:
            return False
        lowered = text.lower()
        return any(marker in lowered for marker in self.markers)

    def _hit_bytes(self, line: bytes) -> bool:
        lowered = line.lower()
        return any(marker.encode() in lowered for marker in self.markers)

    # -- state -----------------------------------------------------------
    def _load_state(self) -> dict | None:
        """The sticky state; None when it exists but cannot be read (fail closed)."""
        if self._state is not None:
            return self._state
        state = {"version": STATE_VERSION, "excluded": [], "excluded_agents": [], "scans": {}}
        if self.state_path is not None:
            try:
                raw = json.loads(self.state_path.read_bytes())
            except FileNotFoundError:
                raw = state
            except (OSError, ValueError):
                return None
            if (
                not isinstance(raw, dict)
                or raw.get("version") != STATE_VERSION
                or not isinstance(raw.get("excluded"), list)
                or not isinstance(raw.get("scans"), dict)
                or not isinstance(raw.setdefault("excluded_agents", []), list)
            ):
                return None
            if raw.get("fingerprint") != self.fingerprint:
                # Markers or excluded folders changed: what was read before
                # must be read again. Exclusions already made stay.
                raw["scans"] = {}
                raw["fingerprint"] = self.fingerprint
            state = raw
        self._state = state
        return state

    def excluded_ids(self) -> set[str]:
        state = self._load_state()
        if state is None:
            return set()
        return {v for v in state["excluded"] if isinstance(v, str) and _UUID.fullmatch(v)}

    def _update_state(
        self,
        *,
        excluded: Iterable[str] = (),
        agents: Iterable[str] = (),
        scans: dict | None = None,
    ) -> bool:
        """Merge into the state file under its lock. False when it cannot be written."""
        excluded = {v for v in excluded if v}
        agents = {v for v in agents if v}
        if self.state_path is None:
            state = self._load_state()
            if state is None:
                return False
            state["excluded"] = sorted(set(state["excluded"]) | excluded)
            state["excluded_agents"] = sorted(set(state["excluded_agents"]) | agents)
            state["scans"].update(scans or {})
            return True
        try:
            with secure_lock(self.state_path.with_name(f".{self.state_path.name}.lock")) as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                self._state = None
                current = self._load_state()
                if current is None:
                    return False  # Never replace a state that cannot be read.
                current["excluded"] = sorted(set(current["excluded"]) | excluded)
                current["excluded_agents"] = sorted(set(current["excluded_agents"]) | agents)
                if not self._pruned:
                    # Forget scans of files that no longer exist (once per run).
                    current["scans"] = {
                        key: value
                        for key, value in current["scans"].items()
                        if os.path.exists(key)
                    }
                    self._pruned = True
                for key, value in (scans or {}).items():
                    old = current["scans"].get(key)
                    # Concurrent runs: keep the furthest scan of the same file.
                    if (
                        isinstance(old, dict)
                        and old.get("ino") == value.get("ino")
                        and old.get("dev") == value.get("dev")
                        and int(old.get("offset", 0)) > int(value.get("offset", 0))
                    ):
                        continue
                    current["scans"][key] = value
                _atomic_json(self.state_path, current)
                self._state = current
                return True
        except OSError:
            return False

    # -- Claude desktop app records ---------------------------------------
    def _index(self, refresh: bool = False) -> dict | None:
        if self._app_index is not None and (not refresh or self._refreshed):
            return self._app_index
        if refresh:
            self._refreshed = True  # Re-read the app records at most once per run.
        by_cli: dict[str, dict] = {}
        by_local: dict[str, dict] = {}
        root = self.app_root or app_sessions_root()
        if root.is_symlink() or not root.is_dir():
            self._app_index = {"cli": by_cli, "local": by_local}
            return self._app_index
        for directory, directories, files in os.walk(root):
            directories[:] = [d for d in directories if not os.path.islink(os.path.join(directory, d))]
            for name in files:
                if not (name.startswith("local_") and name.endswith(".json")):
                    continue
                path = os.path.join(directory, name)
                try:
                    if os.path.islink(path) or os.path.getsize(path) > MAX_APP_RECORD_BYTES:
                        continue
                    with open(path, "rb") as handle:
                        record = json.loads(handle.read())
                except (OSError, ValueError):
                    continue
                if not isinstance(record, dict):
                    continue
                local = record.get("sessionId")
                if isinstance(local, str):
                    by_local[local] = record
                ids = [record.get("cliSessionId"), record.get("lastAssistantCliSessionId")]
                bridge = record.get("bridgeSessionIds")
                if isinstance(bridge, list):
                    ids.extend(bridge)
                for value in ids:
                    if isinstance(value, str) and _UUID.fullmatch(value.lower()):
                        by_cli.setdefault(value.lower(), record)
        self._app_index = {"cli": by_cli, "local": by_local}
        return self._app_index

    def _app_reason(self, root: str) -> str | None:
        index = self._index()
        record = index["cli"].get(root)
        if record is None:
            index = self._index(refresh=True)
            record = index["cli"].get(root)
        if record is None:
            return MARKER_UNVERIFIED
        title = record.get("title")
        if not isinstance(title, str) or not title.strip():
            return MARKER_UNVERIFIED  # No title yet: hold until the app names it.
        seen: set[int] = set()
        while record is not None:
            if id(record) in seen or len(seen) > MAX_ANCESTRY:
                return MARKER_UNVERIFIED
            seen.add(id(record))
            spawned = record.get("spawnedFrom") if isinstance(record.get("spawnedFrom"), dict) else {}
            if any(
                self.hit(value)
                for value in (
                    record.get("title"),
                    record.get("scheduledTaskId"),
                    spawned.get("title"),
                    spawned.get("name"),
                )
            ):
                return EXCLUDED_MARKER
            parent = spawned.get("sessionId") or record.get("forkedFromSessionId")
            if not parent:
                return None
            if not isinstance(parent, str):
                return MARKER_UNVERIFIED
            record = index["local"].get(parent)
            if record is None:
                index = self._index(refresh=True)
                record = index["local"].get(parent)
            if record is None:
                return MARKER_UNVERIFIED
        return None

    # -- transcripts -----------------------------------------------------
    def _transcript_reason(self, path: Path) -> str | None:
        """Scan a transcript's unread bytes; EXCLUDED_MARKER, MARKER_UNVERIFIED or None."""
        state = self._load_state()
        if state is None:
            return MARKER_UNVERIFIED
        key = str(path)
        try:
            handle = open(path, "rb")
        except OSError:
            return MARKER_UNVERIFIED
        with handle:
            try:
                info = os.fstat(handle.fileno())
            except OSError:
                return MARKER_UNVERIFIED
            cached = state["scans"].get(key)
            offset, first_done = 0, False
            if (
                isinstance(cached, dict)
                and cached.get("dev") == info.st_dev
                and cached.get("ino") == info.st_ino
                and isinstance(cached.get("offset"), int)
                and 0 <= cached["offset"] <= info.st_size
            ):
                offset, first_done = cached["offset"], bool(cached.get("first_prompt_done"))
            handle.seek(offset)
            budget = min(
                MAX_SCAN_BYTES_PER_RUN, MAX_SCAN_BYTES_PER_PROCESS - self._scanned_bytes
            )
            start_offset = offset
            verdict: str | None = None
            while budget > 0:
                line = handle.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                if not line.endswith(b"\n"):
                    if len(line) > MAX_LINE_BYTES:
                        verdict = MARKER_UNVERIFIED
                    break  # Partial last line: read it on a later run.
                budget -= len(line)
                has_marker = self._hit_bytes(line)
                if first_done and not has_marker:
                    offset += len(line)
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    offset += len(line)
                    continue
                offset += len(line)
                if not isinstance(record, dict):
                    continue
                kind = record.get("type")
                if kind == "user" and not record.get("isMeta"):
                    message = record.get("message") if isinstance(record.get("message"), dict) else {}
                    text = _text_of(message.get("content")).strip()
                    if text and not first_done:
                        # Wrapped text before the first prompt is not a prompt,
                        # but a slash command in it (such as "/myproject-plan")
                        # and its arguments are what the owner typed: check
                        # those. Only an unwrapped prompt ends the search.
                        wrapped = text.startswith("<")
                        typed = " ".join(_COMMAND.findall(text)) if wrapped else text
                        if self.hit(typed):
                            verdict = EXCLUDED_MARKER
                            break
                        if not wrapped:
                            first_done = True
                elif has_marker and kind in _TITLE_TYPES:
                    if any(self.hit(record.get(name)) for name in _TITLE_FIELDS):
                        verdict = EXCLUDED_MARKER
                        break
                elif has_marker and kind == "assistant":
                    message = record.get("message") if isinstance(record.get("message"), dict) else {}
                    content = message.get("content")
                    for block in content if isinstance(content, list) else ():
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            if any(
                                self.hit(v) and self._path_counts(v)
                                for v in _path_values(block.get("input"))
                            ):
                                verdict = EXCLUDED_MARKER
                                break
                    if verdict:
                        break
            at_end = offset >= info.st_size
            self._scanned_bytes += offset - start_offset
        scan = {"dev": info.st_dev, "ino": info.st_ino, "offset": offset, "first_prompt_done": first_done}
        if verdict == EXCLUDED_MARKER:
            return EXCLUDED_MARKER
        if not self._update_state(scans={key: scan}):
            return MARKER_UNVERIFIED
        if verdict == MARKER_UNVERIFIED or not at_end:
            # Unread bytes (over budget, or a last line still being written)
            # could hold a marker: hold until a later run has read them.
            return MARKER_UNVERIFIED
        return None

    def _path_counts(self, value: str) -> bool:
        if self.path_excluded is None or not os.path.isabs(os.path.expanduser(value)):
            return False
        try:
            return bool(self.path_excluded(os.path.expanduser(value)))
        except (OSError, ValueError):
            return False

    # -- entry point -----------------------------------------------------
    def in_scope(self, cwd_keys: Iterable[str]) -> bool:
        return any(key in self.scoped_keys for key in cwd_keys)

    def claude_reason(
        self,
        root: str,
        native: str,
        root_transcript: Path | None,
        own_transcript: Path | None,
    ) -> str | None:
        """Verdict for a root session (own_transcript None) or one of its subagents."""
        if root in self.allowed_roots:
            return None
        cache_key = (root, native, str(root_transcript), str(own_transcript))
        if cache_key in self._verdicts:
            return self._verdicts[cache_key]
        verdict, scope = self._classify(root, native, root_transcript, own_transcript)
        if verdict == EXCLUDED_MARKER:
            # Remember it so it stays excluded (and, for a root, is reported).
            # If the state cannot be written it is still excluded now and is
            # found again on a later run.
            if scope == "root":
                self._update_state(excluded={root})
            else:
                self._update_state(agents={f"{root}/{native}"})
        self._verdicts[cache_key] = verdict
        return verdict

    def _classify(
        self,
        root: str,
        native: str,
        root_transcript: Path | None,
        own_transcript: Path | None,
    ) -> tuple[str | None, str]:
        state = self._load_state()
        if state is None:
            return MARKER_UNVERIFIED, "root"
        if root in self.excluded_ids():
            return EXCLUDED_MARKER, "root"
        agent_key = f"{root}/{native}"
        if native != root and agent_key in state["excluded_agents"]:
            return EXCLUDED_MARKER, "agent"
        app = self._app_reason(root)
        if app == EXCLUDED_MARKER:
            return app, "root"
        held = app == MARKER_UNVERIFIED
        if root_transcript is None:
            return MARKER_UNVERIFIED, "root"
        reason = self._transcript_reason(root_transcript)
        if reason == EXCLUDED_MARKER:
            return reason, "root"
        held = held or reason == MARKER_UNVERIFIED
        if native != root and own_transcript is None:
            return MARKER_UNVERIFIED, "agent"  # A subagent must be read itself.
        if own_transcript is not None and own_transcript != root_transcript:
            reason = self._transcript_reason(own_transcript)
            if reason == EXCLUDED_MARKER:
                return reason, "agent"
            held = held or reason == MARKER_UNVERIFIED
        return (MARKER_UNVERIFIED if held else None), "root"
