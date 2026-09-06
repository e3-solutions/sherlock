from __future__ import annotations

import sys
import unittest
from pathlib import Path

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "learning-cards" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_learning_cards.contract import (
    build_reviewer_brief,
    card_sha256,
    validate_card,
)


def card() -> dict[str, object]:
    return {
        "card_version": "sherlock.learning-card.v1",
        "card_id": "private-card-001",
        "visibility": "private",
        "status": "draft",
        "problem": "A cache-backed timeline needs preparation before traffic.",
        "learning": "Warm required cache state before serving and bound cleanup work.",
        "attempts": [
            {"approach": "Warm the cache", "result": "worked"},
            {"approach": "Bound shutdown cleanup", "result": "worked"},
        ],
        "reuse_when": ["A user-facing read path depends on a cache."],
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


def reviewed_card() -> dict[str, object]:
    reviewed = card()
    reviewed["status"] = "reviewed"
    reviewed["review"] = {
        "review_version": "sherlock.learning-card-review.v1",
        "decision": "approved",
        "reviewer": "private-reviewer-001",
        "rationale": "The evidence is direct and the guidance is specific.",
        "card_id": reviewed["card_id"],
        "card_sha256": card_sha256(reviewed),
    }
    return reviewed


class LearningCardContractTests(unittest.TestCase):
    def test_private_evidence_backed_draft_is_valid(self):
        self.assertEqual(validate_card(card()), [])

    def test_card_can_never_be_marked_published(self):
        draft = card()
        draft["visibility"] = "published"
        self.assertIn("learning cards are private-only", validate_card(draft))

    def test_raw_session_content_is_not_allowed(self):
        draft = card()
        draft["transcript"] = "private session text"
        self.assertIn(
            "card contains a forbidden raw-content field", validate_card(draft)
        )

    def test_every_claim_area_needs_evidence(self):
        draft = card()
        draft["evidence"] = draft["evidence"][:1]
        errors = validate_card(draft)
        self.assertIn("evidence must support learning", errors)
        self.assertIn("evidence must support outcome", errors)

    def test_high_confidence_requires_independent_outcome_proof(self):
        draft = card()
        draft["confidence"] = "high"
        draft["evidence"][2]["kind"] = "pull_request"
        self.assertIn(
            "high confidence requires a direct independent outcome verifier",
            validate_card(draft),
        )

    def test_reviewer_brief_is_private_and_contains_review_questions(self):
        brief = build_reviewer_brief(card())
        self.assertEqual(brief["visibility"], "private")
        self.assertEqual(len(brief["review_questions"]), 3)

    def test_reviewed_card_requires_a_bound_approval_receipt(self):
        self.assertEqual(validate_card(reviewed_card()), [])

    def test_reviewed_card_rejects_an_unbound_or_non_approval_receipt(self):
        reviewed = reviewed_card()
        reviewed["review"]["decision"] = "needs_changes"
        reviewed["learning"] = "A changed claim invalidates the receipt binding."

        errors = validate_card(reviewed)

        self.assertIn("reviewed cards require an approved review", errors)
        self.assertIn("review.card_sha256 does not bind this card", errors)

    def test_draft_card_cannot_carry_a_review_receipt(self):
        draft = card()
        draft["review"] = reviewed_card()["review"]

        self.assertIn(
            "draft cards must not include a review receipt", validate_card(draft)
        )


if __name__ == "__main__":
    unittest.main()
