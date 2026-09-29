"""Private, aggregate-only measurements for a learning-card pilot.

This module deliberately measures a bounded question: did a reviewed card help
someone before or during a later work item?  It cannot claim that a card saved
time merely because it was created or opened.  The observations contain stable
references and a constrained outcome vocabulary, never raw session material.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from .contract import FORBIDDEN_FIELDS, validate_card

PILOT_MEASUREMENT_VERSION = "sherlock.learning-card-pilot-measurement.v1"
REVIEW_DECISIONS = frozenset({"approved", "rejected", "needs_evidence"})
REUSE_TIMINGS = frozenset({"before_work", "during_work", "after_work"})
HELPFULNESS = frozenset({"helpful", "not_helpful", "unknown"})
EFFECTS = frozenset(
    {
        "avoided_repeat_investigation",
        "avoided_known_failure",
        "informed_design_choice",
        "none_observed",
    }
)


def validate_pilot_measurement(
    measurement: Mapping[str, Any], cards: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Return safety and integrity errors for a private pilot measurement."""

    if not isinstance(measurement, Mapping):
        return ["measurement must be a mapping"]

    errors: list[str] = []
    if _has_forbidden_fields(measurement):
        errors.append("measurement contains a forbidden raw-content field")
    if measurement.get("measurement_version") != PILOT_MEASUREMENT_VERSION:
        errors.append("unsupported measurement_version")
    if measurement.get("visibility") != "private":
        errors.append("pilot measurements are private-only")
    if not _text(measurement.get("pilot_id")):
        errors.append("pilot_id must be a non-empty string")

    cards_by_id = _validate_cards(cards, errors)
    reviews = measurement.get("reviews")
    approved_ids = _validate_reviews(reviews, cards_by_id, errors)
    _validate_reuses(measurement.get("reuses"), cards_by_id, approved_ids, errors)
    return errors


def build_pilot_summary(
    measurement: Mapping[str, Any], cards: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Create an aggregate, honest pilot summary after input validation.

    The result reports observations, rather than inferring causal time savings.
    A reusable-card rate is only meaningful once an engineer reported using a
    card before or during work and supplied an independent work-item reference.
    """

    errors = validate_pilot_measurement(measurement, cards)
    if errors:
        raise ValueError("invalid pilot measurement: " + "; ".join(errors))

    reviews = measurement["reviews"]
    reuses = measurement["reuses"]
    decisions = Counter(review["decision"] for review in reviews)
    timing = Counter(reuse["timing"] for reuse in reuses)
    helpful = [reuse for reuse in reuses if reuse["helpfulness"] == "helpful"]
    actionable = [
        reuse for reuse in helpful if reuse["timing"] in {"before_work", "during_work"}
    ]
    verified = [reuse for reuse in actionable if reuse["work_item_reference"]]
    effects = Counter(reuse["effect"] for reuse in actionable)

    return {
        "measurement_version": PILOT_MEASUREMENT_VERSION,
        "pilot_id": measurement["pilot_id"],
        "visibility": "private",
        "card_count": len(cards),
        "review_counts": {
            decision: decisions[decision] for decision in sorted(REVIEW_DECISIONS)
        },
        "reuse_observation_count": len(reuses),
        "timing_counts": {item: timing[item] for item in sorted(REUSE_TIMINGS)},
        "helpful_before_or_during_work_count": len(actionable),
        "independently_referenced_helpful_count": len(verified),
        "observed_effect_counts": {
            effect: effects[effect]
            for effect in sorted(EFFECTS)
            if effect != "none_observed"
        },
        "interpretation": (
            "These are reported, reference-backed reuse observations. They do not "
            "prove time saved or causation without a separate controlled study."
        ),
    }


def _validate_cards(
    cards: Sequence[Mapping[str, Any]], errors: list[str]
) -> dict[str, Mapping[str, Any]]:
    cards_by_id: dict[str, Mapping[str, Any]] = {}
    for index, card in enumerate(cards):
        prefix = f"cards[{index}]"
        if not isinstance(card, Mapping):
            errors.append(f"{prefix} must be a mapping")
            continue
        card_errors = validate_card(card)
        if card_errors:
            errors.extend(f"{prefix} is invalid: {error}" for error in card_errors)
            continue
        card_id = str(card["card_id"])
        if card_id in cards_by_id:
            errors.append(f"duplicate supplied card_id: {card_id}")
            continue
        cards_by_id[card_id] = card
    return cards_by_id


def _validate_reviews(
    value: Any,
    cards_by_id: Mapping[str, Mapping[str, Any]],
    errors: list[str],
) -> set[str]:
    approved_ids: set[str] = set()
    if not isinstance(value, list):
        errors.append("reviews must be a list")
        return approved_ids
    seen: set[str] = set()
    for index, review in enumerate(value):
        prefix = f"reviews[{index}]"
        if not isinstance(review, Mapping):
            errors.append(f"{prefix} must be a mapping")
            continue
        card_id = review.get("card_id")
        if card_id not in cards_by_id:
            errors.append(f"{prefix}.card_id is not a known card")
        elif card_id in seen:
            errors.append(f"duplicate review for card_id: {card_id}")
        else:
            seen.add(card_id)
            card = cards_by_id[card_id]
            if review.get("decision") == "approved":
                if card.get("status") != "reviewed":
                    errors.append(
                        f"{prefix}.card_id must be a reviewed card before approval"
                    )
                else:
                    approved_ids.add(card_id)
            elif card.get("status") != "draft":
                errors.append(f"{prefix}.card_id must remain a draft when not approved")
        if review.get("decision") not in REVIEW_DECISIONS:
            errors.append(f"{prefix}.decision is unsupported")
        if not _text(review.get("review_reference")):
            errors.append(f"{prefix}.review_reference must be a non-empty string")
    return approved_ids


def _validate_reuses(
    value: Any,
    cards_by_id: Mapping[str, Mapping[str, Any]],
    approved_ids: set[str],
    errors: list[str],
) -> None:
    if not isinstance(value, list):
        errors.append("reuses must be a list")
        return
    seen: set[str] = set()
    for index, reuse in enumerate(value):
        prefix = f"reuses[{index}]"
        if not isinstance(reuse, Mapping):
            errors.append(f"{prefix} must be a mapping")
            continue
        reuse_id = reuse.get("reuse_id")
        if not _text(reuse_id):
            errors.append(f"{prefix}.reuse_id must be a non-empty string")
        elif reuse_id in seen:
            errors.append(f"duplicate reuse_id: {reuse_id}")
        else:
            seen.add(reuse_id)
        card_id = reuse.get("card_id")
        if card_id not in cards_by_id:
            errors.append(f"{prefix}.card_id is not a known card")
        elif card_id not in approved_ids:
            errors.append(f"{prefix}.card_id does not have an approved review")
        if reuse.get("timing") not in REUSE_TIMINGS:
            errors.append(f"{prefix}.timing is unsupported")
        if reuse.get("helpfulness") not in HELPFULNESS:
            errors.append(f"{prefix}.helpfulness is unsupported")
        if reuse.get("effect") not in EFFECTS:
            errors.append(f"{prefix}.effect is unsupported")
        if reuse.get("helpfulness") == "helpful" and not _text(
            reuse.get("work_item_reference")
        ):
            errors.append(
                f"{prefix}.work_item_reference is required for a helpful reuse"
            )


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
