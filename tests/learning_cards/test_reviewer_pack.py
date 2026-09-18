from __future__ import annotations

import sys
import unittest
from pathlib import Path

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "learning-cards" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_learning_cards.reviewer_pack import (
    ReviewerPackError,
    render_reviewer_pack,
)


def card(card_id: str = "private-card-001") -> dict[str, object]:
    return {
        "card_version": "sherlock.learning-card.v1",
        "card_id": card_id,
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


class ReviewerPackTests(unittest.TestCase):
    def test_pack_contains_the_private_review_surface(self):
        page = render_reviewer_pack([card()])

        self.assertIn("Private review only.", page)
        self.assertIn("A cache-backed timeline needs preparation before traffic.", page)
        self.assertIn("Warm required cache state before serving", page)
        self.assertIn("What was tried", page)
        self.assertIn("When to reuse", page)
        self.assertIn("Evidence references", page)
        self.assertIn('value="approved"', page)
        self.assertIn('value="needs_evidence"', page)
        self.assertIn('value="rejected"', page)
        self.assertIn("not saved by this page", page)
        self.assertNotIn("<script", page)
        self.assertNotIn("href=", page)

    def test_pack_is_deterministic_and_orders_cards_by_id(self):
        first = card("private-card-001")
        second = card("private-card-002")

        forward = render_reviewer_pack([first, second])
        reverse = render_reviewer_pack([second, first])

        self.assertEqual(forward, reverse)
        self.assertLess(
            forward.index("private-card-001"), forward.index("private-card-002")
        )

    def test_pack_escapes_card_content(self):
        draft = card()
        draft["problem"] = "Do not render <script>alert('x')</script>."
        draft["evidence"][0]["reference"] = "<private-reference>"

        page = render_reviewer_pack([draft])

        self.assertIn("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;", page)
        self.assertIn("&lt;private-reference&gt;", page)
        self.assertNotIn("<private-reference>", page)

    def test_pack_rejects_duplicate_card_ids(self):
        with self.assertRaisesRegex(ReviewerPackError, "card_id must be unique"):
            render_reviewer_pack([card(), card()])

    def test_invalid_cards_are_never_rendered(self):
        draft = card()
        draft["visibility"] = "published"

        with self.assertRaisesRegex(ValueError, "learning cards are private-only"):
            render_reviewer_pack([draft])


if __name__ == "__main__":
    unittest.main()
