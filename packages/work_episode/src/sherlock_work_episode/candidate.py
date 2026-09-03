"""Create a sealed, metadata-only unknown episode from one local Codex rollout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from .contract import CONTRACT_VERSION

_SESSION_ID_RE = re.compile(
    r"(?P<session_id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$",
    re.IGNORECASE,
)


class CandidateError(ValueError):
    """A candidate cannot be safely derived from the requested local source."""


def build_unknown_manifest(
    session_path: Path,
    *,
    episode_id: str,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Hash a regular rollout file and create an outcome-unknown manifest.

    The rollout is never parsed or copied.  Hashing is descriptor-bound and
    checks that the path did not change before the result is returned.
    """

    if not isinstance(episode_id, str) or not episode_id.strip():
        raise CandidateError("episode_id must be a non-empty string")
    path = Path(session_path)
    if path.is_symlink():
        raise CandidateError("session_path must not be a symbolic link")
    resolved_session_id = session_id or _session_id_from_path(path)
    if not resolved_session_id:
        raise CandidateError(
            "session_id is required when it cannot be read from filename"
        )

    before = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        raise CandidateError("session_path must be a regular file")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise CandidateError("session_path could not be opened safely") from error

    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise CandidateError("session_path must be a regular file")
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise CandidateError("session_path changed before it could be hashed")
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        after = path.stat(follow_symlinks=False)
        if (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) != (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
        ):
            raise CandidateError("session_path changed while it was being hashed")
    finally:
        os.close(descriptor)

    return {
        "contract_version": CONTRACT_VERSION,
        "episode_id": episode_id,
        "evidence": [
            {
                "evidence_id": "session-primary",
                "kind": "session",
                "source_ref": f"codex-session:{resolved_session_id}",
                "content_sha256": digest.hexdigest(),
            }
        ],
        "session_links": [
            {
                "role": "primary",
                "session_id": f"codex-session:{resolved_session_id}",
                "evidence_id": "session-primary",
            }
        ],
        "claims": [
            {
                "claim_id": "session-captured",
                "statement": "A work session was captured; its outcome is not yet independently verified.",
                "evidence_ids": ["session-primary"],
            }
        ],
        "outcome": {"state": "unknown", "evidence_ids": ["session-primary"]},
        "eligibility": {"sensitivity": "private", "purposes": ["retrieval"]},
    }


def _session_id_from_path(path: Path) -> str | None:
    match = _SESSION_ID_RE.search(path.name)
    return match.group("session_id").lower() if match else None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a metadata-only, outcome-unknown work-episode manifest."
    )
    parser.add_argument("--session-file", required=True, type=Path)
    parser.add_argument("--episode-id", required=True)
    parser.add_argument("--session-id")
    args = parser.parse_args()
    manifest = build_unknown_manifest(
        args.session_file, episode_id=args.episode_id, session_id=args.session_id
    )
    print(json.dumps(manifest, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
