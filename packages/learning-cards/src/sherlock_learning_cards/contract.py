"""A deliberately small contract for human-reviewed internal learnings.

Cards are pointers to evidence, not copies of raw agent sessions. They can be
drafted locally and reviewed by a person, but this package cannot publish them.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

CARD_VERSION = "sherlock.learning-card.v1"
CARD_STATUSES = frozenset({"draft", "reviewed"})
CONFIDENCE_LEVELS = frozenset({"low", "medium", "high"})
ATTEMPT_RESULTS = frozenset({"worked", "did_not_work", "inconclusive"})
EVIDENCE_KINDS = frozenset(
    {
        "session",
        "commit",
        "pull_request",
        "ci_run",
        "linear_issue",
        "human_review",
        "meeting",
        "benchmark",
    }
)
CLAIM_AREAS = frozenset({"problem", "learning", "outcome"})
INDEPENDENT_VERIFIERS = frozenset({"ci_run", "human_review", "benchmark"})
FORBIDDEN_FIELDS = frozenset(
    {
        "audio",
        "customer_data",
        "customer_id",
        "prompt",
        "raw_content",
        "recording",
        "recording_url",
        "response",
        "storage_path",
        "transcript",
    }
)


def validate_card(card: Mapping[str, Any]) -> list[str]:
    """Return each reason a private learning-card draft is unsafe or incomplete."""

    if not isinstance(card, Mapping):
        return ["card must be a mapping"]

    errors: list[str] = []
    if _has_forbidden_fields(card):
        errors.append("card contains a forbidden raw-content field")
    if card.get("card_version") != CARD_VERSION:
        errors.append("unsupported card_version")
    if card.get("visibility") != "private":
        errors.append("learning cards are private-only")
    if card.get("status") not in CARD_STATUSES:
        errors.append("status must be draft or reviewed")
    if not _text(card.get("card_id")):
        errors.append("card_id must be a non-empty string")
    for field in ("problem", "learning"):
        if not _text(card.get(field)):
            errors.append(f"{field} must be a non-empty string")

    reuse_when = card.get("reuse_when")
    if (
        not isinstance(reuse_when, list)
        or not reuse_when
        or not all(_text(item) for item in reuse_when)
    ):
        errors.append("reuse_when must be a non-empty list of strings")

    attempts = card.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        errors.append("attempts must be a non-empty list")
    else:
        for index, attempt in enumerate(attempts):
            prefix = f"attempts[{index}]"
            if not isinstance(attempt, Mapping):
                errors.append(f"{prefix} must be a mapping")
                continue
            if not _text(attempt.get("approach")):
                errors.append(f"{prefix}.approach must be a non-empty string")
            if attempt.get("result") not in ATTEMPT_RESULTS:
                errors.append(f"{prefix}.result is unsupported")

    confidence = card.get("confidence")
    if confidence not in CONFIDENCE_LEVELS:
        errors.append("confidence is unsupported")

    evidence_by_id = _validate_evidence(card.get("evidence"), errors)
    supported_areas = {
        area for evidence in evidence_by_id.values() for area in evidence["supports"]
    }
    for area in CLAIM_AREAS:
        if area not in supported_areas:
            errors.append(f"evidence must support {area}")
    if confidence == "high" and not any(
        evidence["kind"] in INDEPENDENT_VERIFIERS
        and evidence["verification"] == "direct"
        and "outcome" in evidence["supports"]
        for evidence in evidence_by_id.values()
    ):
        errors.append("high confidence requires a direct independent outcome verifier")
    return errors


def build_reviewer_brief(card: Mapping[str, Any]) -> dict[str, Any]:
    """Return the bounded local packet a human needs to approve or reject a draft."""

    errors = validate_card(card)
    if errors:
        raise ValueError("invalid learning card: " + "; ".join(errors))
    return {
        "card_version": CARD_VERSION,
        "card_id": card["card_id"],
        "status": card["status"],
        "visibility": "private",
        "problem": card["problem"],
        "learning": card["learning"],
        "attempts": list(card["attempts"]),
        "reuse_when": list(card["reuse_when"]),
        "confidence": card["confidence"],
        "evidence": [
            {
                "kind": evidence["kind"],
                "reference": evidence["reference"],
                "supports": list(evidence["supports"]),
                "verification": evidence["verification"],
            }
            for evidence in card["evidence"]
        ],
        "review_questions": [
            "Is the learning accurate and specific enough to reuse?",
            "Does the listed evidence actually support the claimed outcome?",
            "Would this help another engineer before they begin similar work?",
        ],
    }


def _validate_evidence(value: Any, errors: list[str]) -> dict[str, Mapping[str, Any]]:
    evidence_by_id: dict[str, Mapping[str, Any]] = {}
    if not isinstance(value, list) or not value:
        errors.append("evidence must be a non-empty list")
        return evidence_by_id
    for index, evidence in enumerate(value):
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
        if not _text(evidence.get("reference")):
            errors.append(f"{prefix}.reference must be a non-empty string")
        supports = evidence.get("supports")
        if (
            not isinstance(supports, list)
            or not supports
            or any(item not in CLAIM_AREAS for item in supports)
        ):
            errors.append(f"{prefix}.supports must name one or more claim areas")
        if evidence.get("verification") not in {"direct", "contextual"}:
            errors.append(f"{prefix}.verification must be direct or contextual")
    return evidence_by_id


def _has_forbidden_fields(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            key in FORBIDDEN_FIELDS or _has_forbidden_fields(nested)
            for key, nested in value.items()
        )
    if isinstance(value, list):
        return any(_has_forbidden_fields(item) for item in value)
    return False


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())
