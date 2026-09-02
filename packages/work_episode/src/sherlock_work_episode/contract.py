"""Validate and seal metadata-only work-episode manifests.

This is deliberately a local contract.  It stores identifiers, hashes, and
evidence relationships—not recordings, transcripts, prompts, responses, or
customer identifiers.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

CONTRACT_VERSION = "sherlock.work-episode.v1"
SNAPSHOT_VERSION = "sherlock.work-episode-receipt.v1"

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EVIDENCE_KINDS = frozenset(
    {
        "session",
        "github_commit",
        "github_pull_request",
        "ci_run",
        "linear_issue",
        "human_review",
        "benchmark",
        "document",
    }
)
OUTCOME_STATES = frozenset(
    {"verified_success", "verified_failure", "partial", "blocked", "unknown"}
)
VERIFIER_EVIDENCE_KINDS = frozenset({"ci_run", "human_review", "benchmark"})
SESSION_ROLES = frozenset({"primary", "worker", "resume"})
PURPOSES = frozenset({"retrieval", "evaluation", "training"})
SENSITIVITIES = frozenset({"metadata", "internal", "private", "restricted"})
FORBIDDEN_FIELDS = frozenset(
    {
        "audio",
        "customer_id",
        "customer_identifier",
        "prompt",
        "raw_content",
        "raw_url",
        "recording",
        "recording_url",
        "response",
        "transcript",
    }
)


class ContractError(ValueError):
    """A work-episode manifest or receipt does not satisfy the contract."""


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def _sha256(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _has_forbidden_fields(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            key in FORBIDDEN_FIELDS or _has_forbidden_fields(nested)
            for key, nested in value.items()
        )
    if isinstance(value, list):
        return any(_has_forbidden_fields(item) for item in value)
    return False


def _evidence_for(
    evidence_by_id: Mapping[str, Mapping[str, Any]], value: Any
) -> Mapping[str, Any] | None:
    """Return a referenced item without letting malformed input raise TypeError."""

    return evidence_by_id.get(value) if isinstance(value, str) else None


def validate_episode(manifest: Mapping[str, Any]) -> list[str]:
    """Return every contract violation without interpreting raw work content."""

    errors: list[str] = []
    if not isinstance(manifest, Mapping):
        return ["manifest must be a mapping"]
    if _has_forbidden_fields(manifest):
        errors.append("manifest contains a forbidden raw or customer-content field")
    if manifest.get("contract_version") != CONTRACT_VERSION:
        errors.append("unsupported contract_version")
    if not _text(manifest.get("episode_id")):
        errors.append("episode_id must be a non-empty string")

    raw_evidence = manifest.get("evidence")
    evidence_by_id: dict[str, Mapping[str, Any]] = {}
    source_keys: set[tuple[str, str]] = set()
    if not isinstance(raw_evidence, list) or not raw_evidence:
        errors.append("evidence must be a non-empty list")
    else:
        for index, evidence in enumerate(raw_evidence):
            prefix = f"evidence[{index}]"
            if not isinstance(evidence, Mapping):
                errors.append(f"{prefix} must be a mapping")
                continue
            evidence_id = evidence.get("evidence_id")
            if not _text(evidence_id):
                errors.append(f"{prefix}.evidence_id must be a non-empty string")
                continue
            if evidence_id in evidence_by_id:
                errors.append(f"duplicate evidence_id: {evidence_id}")
            evidence_by_id[evidence_id] = evidence
            if evidence.get("kind") not in EVIDENCE_KINDS:
                errors.append(f"{prefix}.kind is unsupported")
            if not _text(evidence.get("source_ref")):
                errors.append(f"{prefix}.source_ref must be a non-empty identifier")
            elif "://" in evidence["source_ref"]:
                errors.append(
                    f"{prefix}.source_ref must be an opaque identifier, not a URL"
                )
            elif isinstance(evidence.get("kind"), str):
                source_key = (evidence["kind"], evidence["source_ref"])
                if source_key in source_keys:
                    errors.append(f"duplicate evidence source: {source_key[0]}")
                source_keys.add(source_key)
            if evidence.get("kind") == "session" and not SHA256_RE.fullmatch(
                str(evidence.get("content_sha256", ""))
            ):
                errors.append(f"{prefix}.content_sha256 must seal session evidence")

    raw_links = manifest.get("session_links")
    if not isinstance(raw_links, list) or not raw_links:
        errors.append("session_links must be a non-empty list")
    else:
        primary_links = 0
        for index, link in enumerate(raw_links):
            prefix = f"session_links[{index}]"
            if not isinstance(link, Mapping):
                errors.append(f"{prefix} must be a mapping")
                continue
            if link.get("role") not in SESSION_ROLES:
                errors.append(f"{prefix}.role is unsupported")
            if link.get("role") == "primary":
                primary_links += 1
            if not _text(link.get("session_id")):
                errors.append(f"{prefix}.session_id must be a non-empty string")
            evidence = _evidence_for(evidence_by_id, link.get("evidence_id"))
            if evidence is None or evidence.get("kind") != "session":
                errors.append(f"{prefix}.evidence_id must reference session evidence")
            elif evidence.get("source_ref") != link.get("session_id"):
                errors.append(f"{prefix}.session_id must match its source evidence")
        if primary_links != 1:
            errors.append("session_links must contain exactly one primary session")

    raw_claims = manifest.get("claims", [])
    if not isinstance(raw_claims, list):
        errors.append("claims must be a list")
    else:
        claim_ids: set[str] = set()
        for index, claim in enumerate(raw_claims):
            prefix = f"claims[{index}]"
            if not isinstance(claim, Mapping):
                errors.append(f"{prefix} must be a mapping")
                continue
            claim_id = claim.get("claim_id")
            if not _text(claim_id):
                errors.append(f"{prefix}.claim_id must be a non-empty string")
            elif claim_id in claim_ids:
                errors.append(f"duplicate claim_id: {claim_id}")
            else:
                claim_ids.add(claim_id)
            if not _text(claim.get("statement")):
                errors.append(f"{prefix}.statement must be a non-empty string")
            evidence_ids = claim.get("evidence_ids")
            if not isinstance(evidence_ids, list) or not evidence_ids:
                errors.append(f"{prefix}.evidence_ids must be a non-empty list")
            elif any(
                _evidence_for(evidence_by_id, evidence_id) is None
                for evidence_id in evidence_ids
            ):
                errors.append(f"{prefix}.evidence_ids contains an unknown evidence_id")

    outcome = manifest.get("outcome")
    if not isinstance(outcome, Mapping):
        errors.append("outcome must be a mapping")
    else:
        state = outcome.get("state")
        if state not in OUTCOME_STATES:
            errors.append("outcome.state is unsupported")
        outcome_evidence_ids = outcome.get("evidence_ids")
        if not isinstance(outcome_evidence_ids, list) or not outcome_evidence_ids:
            errors.append("outcome.evidence_ids must be a non-empty list")
        elif any(
            _evidence_for(evidence_by_id, evidence_id) is None
            for evidence_id in outcome_evidence_ids
        ):
            errors.append("outcome.evidence_ids contains an unknown evidence_id")
        elif state in {"verified_success", "verified_failure"}:
            independent = [
                _evidence_for(evidence_by_id, evidence_id)
                for evidence_id in outcome_evidence_ids
                if _evidence_for(evidence_by_id, evidence_id) is not None
                and _evidence_for(evidence_by_id, evidence_id).get("kind")
                in VERIFIER_EVIDENCE_KINDS
            ]
            if not independent:
                errors.append("verified outcomes require independent verifier evidence")

    eligibility = manifest.get("eligibility")
    if not isinstance(eligibility, Mapping):
        errors.append("eligibility must be a mapping")
    else:
        sensitivity = eligibility.get("sensitivity")
        purposes = eligibility.get("purposes")
        if sensitivity not in SENSITIVITIES:
            errors.append("eligibility.sensitivity is unsupported")
        if not isinstance(purposes, list) or not purposes:
            errors.append("eligibility.purposes must be a non-empty list")
        elif any(purpose not in PURPOSES for purpose in purposes):
            errors.append("eligibility.purposes contains an unsupported purpose")
        elif "training" in purposes and sensitivity in {"private", "restricted"}:
            errors.append("private or restricted episodes cannot be training-eligible")
    return errors


def seal_snapshot(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Create an immutable, reproducible receipt for a valid manifest."""

    errors = validate_episode(manifest)
    if errors:
        raise ContractError("; ".join(errors))
    snapshot = json.loads(_canonical_json(manifest))
    return {
        "receipt_version": SNAPSHOT_VERSION,
        "episode_id": snapshot["episode_id"],
        "manifest": snapshot,
        "manifest_sha256": _sha256(snapshot),
    }


def verify_snapshot(receipt: Mapping[str, Any]) -> list[str]:
    """Check both snapshot integrity and the underlying manifest contract."""

    if not isinstance(receipt, Mapping):
        return ["receipt must be a mapping"]
    errors: list[str] = []
    if receipt.get("receipt_version") != SNAPSHOT_VERSION:
        errors.append("unsupported receipt_version")
    manifest = receipt.get("manifest")
    if not isinstance(manifest, Mapping):
        return [*errors, "receipt.manifest must be a mapping"]
    if receipt.get("episode_id") != manifest.get("episode_id"):
        errors.append("receipt.episode_id does not match manifest")
    if receipt.get("manifest_sha256") != _sha256(manifest):
        errors.append("receipt.manifest_sha256 does not match manifest")
    return [*errors, *validate_episode(manifest)]
