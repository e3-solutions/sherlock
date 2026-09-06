"""Privacy-safe derived views for validated work-episode manifests.

Catalog cards are deliberately not evidence exports.  The work-episode
manifest stays the governed provenance record; this view contains only bounded
metadata for retrieval or training selection.  In particular, it never emits
claim text, source references, session identifiers, hashes, URLs, transcripts,
recordings, prompts, responses, or customer material.
"""

from __future__ import annotations

from collections.abc import Mapping
from hashlib import sha256
from typing import Any, NoReturn

from .contract import validate_episode

CARD_VERSION = "sherlock.work-episode-card.v1"


def build_catalog_card(
    manifest: Mapping[str, Any],
    purpose: str,
) -> dict[str, Any]:
    """Build a deterministic metadata-only catalog card.

    The manifest must pass ``validate_episode`` and explicitly allow the
    requested purpose.  Training receives an additional sensitivity check even
    though the contract already rejects unsafe training eligibility, so this
    derived-view boundary remains safe if the contract evolves.

    Raises:
        ValueError: if validation, eligibility, or a purpose gate fails.
    """

    if not isinstance(manifest, Mapping):
        _invalid("episode manifest must be a mapping")
    if not isinstance(purpose, str) or not purpose:
        _invalid("catalog purpose must be a non-empty string")

    # Contract diagnostics can include a supplied identifier. Keep those at
    # the trusted validation boundary instead of exposing them through a card.
    if validate_episode(manifest):
        raise ValueError("invalid work episode manifest")

    eligibility = _mapping_field(manifest, "eligibility")
    sensitivity = _string_field(eligibility, "sensitivity")
    approved_purposes = _string_list_field(eligibility, "purposes")
    if purpose not in approved_purposes:
        raise ValueError(f"episode is not eligible for purpose {purpose!r}")

    if purpose == "training" and sensitivity in {"private", "restricted"}:
        raise ValueError(
            f"training cards require metadata or internal sensitivity, got {sensitivity!r}",
        )

    evidence = _mapping_list_field(manifest, "evidence")
    session_links = _mapping_list_field(manifest, "session_links")
    claims = _mapping_list_field(manifest, "claims")
    outcome = _mapping_field(manifest, "outcome")
    outcome_state = _string_field(outcome, "state")

    return {
        "card_version": CARD_VERSION,
        "episode_ref": _reference(_string_field(manifest, "episode_id")),
        "purpose": purpose,
        "sensitivity": sensitivity,
        "outcome_state": outcome_state,
        "outcome_verified": outcome_state in {"verified_success", "verified_failure"},
        "evidence_count": len(evidence),
        "evidence_kind_counts": _count_values(evidence, "kind"),
        "session_role_counts": _count_values(session_links, "role"),
        "claim_count": len(claims),
        "outcome_evidence_count": len(_string_list_field(outcome, "evidence_ids")),
    }


def _reference(episode_id: str) -> str:
    """Return a stable, non-reversible reference without emitting ``episode_id``."""

    digest = sha256(
        b"sherlock.work-episode-card.v1\x00" + episode_id.encode("utf-8"),
    ).hexdigest()
    return f"episode_{digest[:24]}"


def _count_values(items: list[Mapping[str, Any]], field: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        value = _string_field(item, field)
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items()))


def _mapping_field(mapping: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    value = mapping.get(name)
    if not isinstance(value, Mapping):
        _invalid(f"validated manifest field {name!r} must be a mapping")
    return value


def _mapping_list_field(
    mapping: Mapping[str, Any],
    name: str,
) -> list[Mapping[str, Any]]:
    value = mapping.get(name)
    if not isinstance(value, list) or not all(
        isinstance(item, Mapping) for item in value
    ):
        _invalid(f"validated manifest field {name!r} must be a list of mappings")
    return list(value)


def _string_field(mapping: Mapping[str, Any], name: str) -> str:
    value = mapping.get(name)
    if not isinstance(value, str):
        _invalid(f"validated manifest field {name!r} must be a string")
    return value


def _string_list_field(mapping: Mapping[str, Any], name: str) -> list[str]:
    value = mapping.get(name)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        _invalid(f"validated manifest field {name!r} must be a list of strings")
    return list(value)


def _invalid(message: str) -> NoReturn:
    raise ValueError(message)
