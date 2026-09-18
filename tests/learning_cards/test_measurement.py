from __future__ import annotations

import sys
import unittest
from pathlib import Path

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "learning-cards" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_learning_cards.contract import card_sha256
from sherlock_learning_cards.measurement import (
    build_pilot_summary,
    validate_pilot_measurement,
)


def measurement() -> dict[str, object]:
    return {
        "measurement_version": "sherlock.learning-card-pilot-measurement.v1",
        "pilot_id": "private-sherlock-pilot-001",
        "visibility": "private",
        "reviews": [
            {
                "card_id": "private-card-001",
                "decision": "approved",
                "review_reference": "local-review:001",
            },
            {
                "card_id": "private-card-002",
                "decision": "needs_evidence",
                "review_reference": "local-review:002",
            },
        ],
        "reuses": [
            {
                "reuse_id": "reuse-001",
                "card_id": "private-card-001",
                "timing": "before_work",
                "helpfulness": "helpful",
                "effect": "avoided_repeat_investigation",
                "work_item_reference": "e3-solutions/sherlock#91",
            },
            {
                "reuse_id": "reuse-002",
                "card_id": "private-card-001",
                "timing": "after_work",
                "helpfulness": "unknown",
                "effect": "none_observed",
            },
        ],
    }


def card(card_id: str, *, reviewed: bool) -> dict[str, object]:
    result: dict[str, object] = {
        "card_version": "sherlock.learning-card.v1",
        "card_id": card_id,
        "visibility": "private",
        "status": "draft",
        "problem": "A specific cache behavior needed an explicit lifecycle.",
        "learning": "Bound ownership and verify the final lifecycle behavior.",
        "attempts": [{"approach": "Add a bounded lifecycle", "result": "worked"}],
        "reuse_when": ["A read path depends on a cache lifecycle."],
        "confidence": "medium",
        "evidence": [
            {
                "evidence_id": "issue",
                "kind": "linear_issue",
                "reference": "COR-3692",
                "supports": ["problem"],
                "verification": "direct",
            },
            {
                "evidence_id": "pr",
                "kind": "pull_request",
                "reference": "e3-solutions/sherlock#38",
                "supports": ["learning"],
                "verification": "direct",
            },
            {
                "evidence_id": "ci",
                "kind": "ci_run",
                "reference": "github-actions:32290381473",
                "supports": ["outcome"],
                "verification": "direct",
            },
        ],
    }
    if reviewed:
        result["status"] = "reviewed"
        result["review"] = {
            "review_version": "sherlock.learning-card-review.v1",
            "card_id": card_id,
            "card_sha256": card_sha256(result),
            "decision": "approved",
            "reviewer": "private-reviewer-001",
            "rationale": "The evidence supports a reusable claim.",
        }
    return result


def cards() -> list[dict[str, object]]:
    return [
        card("private-card-001", reviewed=True),
        card("private-card-002", reviewed=False),
    ]


class PilotMeasurementTests(unittest.TestCase):
    def test_valid_private_measurement_builds_an_honest_summary(self):
        summary = build_pilot_summary(measurement(), cards())
        self.assertEqual(summary["review_counts"]["approved"], 1)
        self.assertEqual(summary["helpful_before_or_during_work_count"], 1)
        self.assertEqual(summary["independently_referenced_helpful_count"], 1)
        self.assertEqual(
            summary["observed_effect_counts"]["avoided_repeat_investigation"], 1
        )
        self.assertIn("do not prove time saved", summary["interpretation"])

    def test_helpful_reuse_requires_a_work_item_reference(self):
        pilot = measurement()
        pilot["reuses"][0].pop("work_item_reference")  # type: ignore[index]
        self.assertIn(
            "reuses[0].work_item_reference is required for a helpful reuse",
            validate_pilot_measurement(pilot, cards()),
        )

    def test_reuse_requires_an_approved_human_review(self):
        pilot = measurement()
        pilot["reviews"] = []
        self.assertIn(
            "reuses[0].card_id does not have an approved review",
            validate_pilot_measurement(pilot, cards()),
        )

    def test_reuse_is_not_allowed_for_a_card_needing_evidence(self):
        pilot = measurement()
        pilot["reuses"][0]["card_id"] = "private-card-002"  # type: ignore[index]
        self.assertIn(
            "reuses[0].card_id does not have an approved review",
            validate_pilot_measurement(pilot, cards()),
        )

    def test_measurements_cannot_be_published(self):
        pilot = measurement()
        pilot["visibility"] = "shared"
        self.assertIn(
            "pilot measurements are private-only",
            validate_pilot_measurement(pilot, cards()),
        )

    def test_measurement_rejects_raw_session_content(self):
        pilot = measurement()
        pilot["reuses"][0]["transcript"] = "raw private content"  # type: ignore[index]
        self.assertIn(
            "measurement contains a forbidden raw-content field",
            validate_pilot_measurement(pilot, cards()),
        )

    def test_approval_requires_a_finalized_card(self):
        supplied_cards = cards()
        supplied_cards[0]["status"] = "draft"
        supplied_cards[0].pop("review")
        self.assertIn(
            "reviews[0].card_id must be a reviewed card before approval",
            validate_pilot_measurement(measurement(), supplied_cards),
        )


if __name__ == "__main__":
    unittest.main()
