"""Focused, local tests for the provenance-first work-episode pilot.

These tests deliberately exercise only pure manifest code.  They neither read
Sherlock telemetry nor connect to any database or network service.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "work_episode" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_work_episode.contract import (
    ContractError,
    seal_snapshot,
    validate_episode,
    verify_snapshot,
)
from sherlock_work_episode.views import build_catalog_card

PRIVATE_SENTINEL = "PRIVATE-SESSION-CONTENT-MUST-NOT-LEAK"
OPAQUE_SENTINEL = "opaque-source-locator-must-not-leak"


def valid_manifest() -> dict[str, object]:
    """Return the smallest verified, internal-only episode manifest."""

    return {
        "contract_version": "sherlock.work-episode.v2",
        "episode_id": "episode-private-001",
        "evidence": [
            {
                "evidence_id": "session-primary",
                "kind": "session",
                "source_ref": OPAQUE_SENTINEL,
                "content_sha256": "a" * 64,
                "content_byte_count": 100,
            },
            {
                "evidence_id": "linear-intent",
                "kind": "linear_issue",
                "source_ref": "linear:COR-4003",
            },
            {
                "evidence_id": "ci-verifier",
                "kind": "ci_run",
                "source_ref": "ci:run-opaque-001",
            },
        ],
        "session_links": [
            {
                "role": "primary",
                "session_id": OPAQUE_SENTINEL,
                "evidence_id": "session-primary",
            }
        ],
        "claims": [
            {
                "claim_id": "intent",
                "statement": f"Implement a pilot without exposing {PRIVATE_SENTINEL}.",
                "evidence_ids": ["linear-intent"],
            },
            {
                "claim_id": "outcome",
                "statement": "The verification run completed successfully.",
                "evidence_ids": ["ci-verifier"],
            },
        ],
        "outcome": {
            "state": "verified_success",
            "evidence_ids": ["ci-verifier"],
        },
        "eligibility": {
            "sensitivity": "internal",
            "purposes": ["retrieval"],
        },
    }


class WorkEpisodeContractTests(unittest.TestCase):
    def test_sealed_snapshot_verifies_when_unchanged(self):
        receipt = seal_snapshot(valid_manifest())

        self.assertEqual(verify_snapshot(receipt), [])
        self.assertEqual(receipt["episode_id"], "episode-private-001")
        self.assertRegex(receipt["manifest_sha256"], r"^[0-9a-f]{64}$")

    def test_snapshot_tamper_is_detected(self):
        receipt = seal_snapshot(valid_manifest())
        receipt["manifest"]["claims"][0]["statement"] = "changed after sealing"

        errors = verify_snapshot(receipt)

        self.assertIn("receipt.manifest_sha256 does not match manifest", errors)

    def test_session_evidence_requires_both_source_reference_and_hash(self):
        for missing_field in ("source_ref", "content_sha256", "content_byte_count"):
            with self.subTest(missing_field=missing_field):
                manifest = valid_manifest()
                manifest["evidence"][0].pop(missing_field)

                errors = validate_episode(manifest)

                self.assertTrue(any(missing_field in error for error in errors), errors)
                with self.assertRaises(ContractError):
                    seal_snapshot(manifest)

    def test_claim_cannot_reference_evidence_outside_the_episode(self):
        manifest = valid_manifest()
        manifest["claims"][0]["evidence_ids"] = ["not-in-this-episode"]

        errors = validate_episode(manifest)

        self.assertIn("claims[0].evidence_ids contains an unknown evidence_id", errors)

    def test_verified_success_cannot_be_proven_by_session_or_linear_alone(self):
        manifest = valid_manifest()
        manifest["outcome"]["evidence_ids"] = [
            "session-primary",
            "linear-intent",
        ]

        errors = validate_episode(manifest)

        self.assertIn(
            "verified outcomes require independent verifier evidence",
            errors,
        )

    def test_verified_success_requires_a_verifier_not_just_a_commit(self):
        manifest = valid_manifest()
        manifest["evidence"].append(
            {
                "evidence_id": "implementation-commit",
                "kind": "github_commit",
                "source_ref": "git:abcdef123456",
            }
        )
        manifest["outcome"]["evidence_ids"] = ["implementation-commit"]

        errors = validate_episode(manifest)

        self.assertIn(
            "verified outcomes require independent verifier evidence",
            errors,
        )

    def test_restricted_episode_cannot_be_training_eligible(self):
        manifest = valid_manifest()
        manifest["eligibility"] = {
            "sensitivity": "restricted",
            "purposes": ["retrieval", "training"],
        }

        errors = validate_episode(manifest)

        self.assertIn(
            "private or restricted episodes cannot be training-eligible",
            errors,
        )
        with self.assertRaises(ValueError):
            build_catalog_card(manifest, "training")

    def test_catalog_card_contains_no_raw_or_private_source_content(self):
        manifest = valid_manifest()

        card = build_catalog_card(manifest, "retrieval")
        serialized_card = json.dumps(card, sort_keys=True)

        self.assertEqual(card["purpose"], "retrieval")
        self.assertNotIn(PRIVATE_SENTINEL, serialized_card)
        self.assertNotIn(OPAQUE_SENTINEL, serialized_card)
        self.assertNotIn("ci:run-opaque-001", serialized_card)
        self.assertNotIn("a" * 64, serialized_card)
        self.assertNotIn("statement", serialized_card)
        self.assertNotIn("source_ref", serialized_card)
        self.assertNotIn("content_sha256", serialized_card)


if __name__ == "__main__":
    unittest.main()
