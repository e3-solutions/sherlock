from __future__ import annotations

import sys
import unittest
from pathlib import Path

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "learning-cards" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_learning_cards.contract import validate_card
from sherlock_learning_cards.evidence import verify_evidence_provenance

COMMIT_SHA = "a" * 40
OTHER_COMMIT_SHA = "b" * 40
REPOSITORY = "e3-solutions/sherlock"


def linked_evidence(*, conclusion: str = "success") -> list[dict[str, object]]:
    return [
        {
            "evidence_id": "commit",
            "kind": "commit",
            "reference": f"git:{COMMIT_SHA}",
            "supports": ["learning"],
            "verification": "direct",
            "provenance": {
                "repository": REPOSITORY,
                "commit_sha": COMMIT_SHA,
            },
        },
        {
            "evidence_id": "pr",
            "kind": "pull_request",
            "reference": f"{REPOSITORY}#38",
            "supports": ["problem", "learning"],
            "verification": "direct",
            "provenance": {
                "repository": REPOSITORY,
                "pull_number": 38,
                "head_commit_sha": COMMIT_SHA,
            },
        },
        {
            "evidence_id": "ci",
            "kind": "ci_run",
            "reference": "github-actions:32290381473",
            "supports": ["outcome"],
            "verification": "direct",
            "provenance": {
                "repository": REPOSITORY,
                "run_id": "32290381473",
                "head_commit_sha": COMMIT_SHA,
                "conclusion": conclusion,
            },
        },
    ]


def high_confidence_card() -> dict[str, object]:
    return {
        "card_version": "sherlock.learning-card.v1",
        "card_id": "private-card-linked-001",
        "visibility": "private",
        "status": "draft",
        "problem": "A change needs a trustworthy record of its outcome.",
        "learning": "Link the exact PR, commit, and CI result before claiming high confidence.",
        "attempts": [{"approach": "Run the verifier", "result": "worked"}],
        "reuse_when": ["A reusable learning makes a high-confidence claim."],
        "confidence": "high",
        "evidence": linked_evidence(),
    }


class EvidenceProvenanceTests(unittest.TestCase):
    def test_exact_commit_pull_request_ci_chain_is_verified_offline(self):
        result = verify_evidence_provenance(linked_evidence())

        self.assertTrue(result["valid"])
        self.assertEqual(result["independent_outcome_evidence_ids"], ["ci"])
        self.assertEqual(result["linked_chains"][0]["commit_sha"], COMMIT_SHA)
        self.assertEqual(
            result["linked_chains"][0]["pull_request_evidence_ids"], ["pr"]
        )

    def test_ci_for_a_different_commit_is_not_a_linked_outcome(self):
        evidence = linked_evidence()
        evidence[2]["provenance"]["head_commit_sha"] = OTHER_COMMIT_SHA  # type: ignore[index]

        result = verify_evidence_provenance(evidence)

        self.assertFalse(result["valid"])
        self.assertEqual(result["independent_outcome_evidence_ids"], [])
        self.assertIn(
            "CI evidence ci must link to the exact commit and pull-request artifacts",
            result["errors"],
        )

    def test_reference_cannot_disagree_with_locally_supplied_pull_request_id(self):
        evidence = linked_evidence()
        evidence[1]["reference"] = f"{REPOSITORY}#39"

        result = verify_evidence_provenance(evidence)

        self.assertFalse(result["valid"])
        self.assertIn(
            f"pull request evidence pr reference must equal {REPOSITORY}#38",
            result["errors"],
        )

    def test_failed_ci_is_not_independent_outcome_evidence(self):
        result = verify_evidence_provenance(linked_evidence(conclusion="failure"))

        self.assertTrue(result["valid"])
        self.assertEqual(result["independent_outcome_evidence_ids"], [])

    def test_high_confidence_requires_a_linked_successful_independent_result(self):
        self.assertEqual(validate_card(high_confidence_card()), [])

        failed = high_confidence_card()
        failed["evidence"][2]["provenance"]["conclusion"] = "failure"  # type: ignore[index]
        self.assertIn(
            "high confidence requires a direct independent outcome verifier",
            validate_card(failed),
        )

    def test_high_confidence_cannot_rely_on_an_unlinked_ci_reference(self):
        draft = high_confidence_card()
        draft["evidence"] = draft["evidence"][1:]

        errors = validate_card(draft)

        self.assertIn(
            "evidence provenance: pull request evidence pr must link to an exact commit artifact",
            errors,
        )
        self.assertIn(
            "high confidence requires a direct independent outcome verifier",
            errors,
        )


if __name__ == "__main__":
    unittest.main()
