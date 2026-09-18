from __future__ import annotations

import io
import json
import stat
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "learning-cards" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_learning_cards.contract import validate_card
from sherlock_learning_cards.workflow import (
    WorkflowError,
    build_draft_card,
    build_review_receipt,
    finalize_approved_card,
    load_json_object,
    main,
    write_private_json,
)


def card() -> dict[str, object]:
    return {
        "card_version": "sherlock.learning-card.v1",
        "card_id": "private-card-001",
        "visibility": "private",
        "status": "draft",
        "problem": "A cache-backed timeline needs preparation before traffic.",
        "learning": "Warm required cache state before serving and bound cleanup work.",
        "attempts": [{"approach": "Warm the cache", "result": "worked"}],
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


class LearningCardWorkflowTests(unittest.TestCase):
    def test_create_command_owns_the_private_lifecycle_fields(self):
        input_card = card()
        for field in ("card_version", "visibility", "status"):
            input_card.pop(field)
        with TemporaryDirectory() as directory:
            source = Path(directory) / "candidate.json"
            output = Path(directory) / "draft.json"
            source.write_text(json.dumps(input_card), encoding="utf-8")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(
                    ["create", "--input", str(source), "--output", str(output)]
                )

            self.assertEqual(exit_code, 0)
            created = json.loads(output.read_text(encoding="utf-8"))
            output_mode = stat.S_IMODE(output.stat().st_mode)

        self.assertEqual(created["visibility"], "private")
        self.assertEqual(created["status"], "draft")
        self.assertEqual(output_mode, 0o600)
        self.assertEqual(json.loads(stdout.getvalue())["card_id"], "private-card-001")

    def test_intake_rejects_unknown_or_raw_fields_without_copying_them(self):
        candidate = card()
        for field in ("card_version", "visibility", "status"):
            candidate.pop(field)
        candidate["transcript"] = "private source material"

        with self.assertRaisesRegex(WorkflowError, "unsupported fields: transcript"):
            build_draft_card(candidate)

    def test_validate_command_only_reads_its_input(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "card.json"
            source.write_text(json.dumps(card()), encoding="utf-8")
            before = source.read_bytes()
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["validate", str(source)])

            self.assertEqual(exit_code, 0)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(json.loads(stdout.getvalue())["valid"], True)

    def test_review_receipt_is_private_and_does_not_copy_card_content(self):
        private_marker = "private-card-sentence-must-not-leak"
        draft = card()
        draft["problem"] = private_marker
        receipt = build_review_receipt(
            draft,
            decision="approved",
            reviewer="Vansh",
            rationale="Evidence supports the stated outcome.",
            recorded_at="2026-09-02T00:00:00Z",
        )
        with TemporaryDirectory() as directory:
            output = Path(directory) / "receipt.json"
            write_private_json(output, receipt)

            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            written = output.read_text(encoding="utf-8")

        self.assertNotIn(private_marker, written)
        self.assertEqual(json.loads(written)["decision"], "approved")

    def test_matching_approval_finalizes_the_same_card(self):
        draft = card()
        receipt = build_review_receipt(
            draft,
            decision="approved",
            reviewer="Vansh",
            rationale="The evidence is sufficient for reuse.",
            recorded_at="2026-09-02T00:00:00Z",
        )

        finalized = finalize_approved_card(draft, receipt)

        self.assertEqual(finalized["status"], "reviewed")
        self.assertEqual(finalized["review"], receipt)
        self.assertEqual(validate_card(finalized), [])

    def test_changed_card_cannot_reuse_an_older_approval(self):
        draft = card()
        receipt = build_review_receipt(
            draft,
            decision="approved",
            reviewer="Vansh",
            rationale="The evidence is sufficient for reuse.",
            recorded_at="2026-09-02T00:00:00Z",
        )
        draft["learning"] = "A materially different claim."

        with self.assertRaisesRegex(WorkflowError, "does not bind"):
            finalize_approved_card(draft, receipt)

    def test_needs_evidence_receipt_cannot_finalize_a_card(self):
        receipt = build_review_receipt(
            card(),
            decision="needs_evidence",
            reviewer="Vansh",
            rationale="The outcome needs stronger evidence.",
            recorded_at="2026-09-02T00:00:00Z",
        )

        with self.assertRaisesRegex(WorkflowError, "only an approved"):
            finalize_approved_card(card(), receipt)

    def test_cli_refuses_to_overwrite_a_review_receipt(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "card.json"
            output = Path(directory) / "receipt.json"
            source.write_text(json.dumps(card()), encoding="utf-8")
            output.write_text("do not overwrite", encoding="utf-8")
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                exit_code = main(
                    [
                        "record-review",
                        "--card",
                        str(source),
                        "--decision",
                        "approved",
                        "--reviewer",
                        "Vansh",
                        "--rationale",
                        "Good evidence.",
                        "--output",
                        str(output),
                    ]
                )

            self.assertEqual(exit_code, 2)
            self.assertEqual(output.read_text(encoding="utf-8"), "do not overwrite")
            self.assertIn("refusing to overwrite", stderr.getvalue())

    def test_pack_command_creates_an_owner_only_local_review_file(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "cards.json"
            output = Path(directory) / "review.html"
            source.write_text(json.dumps([card()]), encoding="utf-8")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(
                    ["pack", "--cards", str(source), "--output", str(output)]
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            rendered = output.read_text(encoding="utf-8")

        self.assertIn("Private review only.", rendered)
        self.assertNotIn("<script", rendered)
        self.assertEqual(json.loads(stdout.getvalue())["card_count"], 1)

    def test_pack_command_rejects_a_non_object_card(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "cards.json"
            output = Path(directory) / "review.html"
            source.write_text(json.dumps([card(), "not a card"]), encoding="utf-8")
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                exit_code = main(
                    ["pack", "--cards", str(source), "--output", str(output)]
                )

            self.assertEqual(exit_code, 2)
            self.assertFalse(output.exists())
            self.assertIn("only objects", stderr.getvalue())

    def test_pilot_summary_command_writes_only_aggregate_private_results(self):
        from sherlock_learning_cards.measurement import PILOT_MEASUREMENT_VERSION

        draft = card()
        receipt = build_review_receipt(
            draft,
            decision="approved",
            reviewer="Vansh",
            rationale="The card is reusable.",
            recorded_at="2026-09-02T00:00:00Z",
        )
        reviewed = finalize_approved_card(draft, receipt)
        measurement = {
            "measurement_version": PILOT_MEASUREMENT_VERSION,
            "pilot_id": "private-pilot-001",
            "visibility": "private",
            "reviews": [
                {
                    "card_id": reviewed["card_id"],
                    "decision": "approved",
                    "review_reference": "local-review:001",
                }
            ],
            "reuses": [
                {
                    "reuse_id": "reuse-001",
                    "card_id": reviewed["card_id"],
                    "timing": "before_work",
                    "helpfulness": "helpful",
                    "effect": "avoided_repeat_investigation",
                    "work_item_reference": "e3-solutions/sherlock#91",
                }
            ],
        }
        with TemporaryDirectory() as directory:
            cards_path = Path(directory) / "cards.json"
            measurement_path = Path(directory) / "measurement.json"
            output = Path(directory) / "summary.json"
            cards_path.write_text(json.dumps([reviewed]), encoding="utf-8")
            measurement_path.write_text(json.dumps(measurement), encoding="utf-8")

            self.assertEqual(
                main(
                    [
                        "pilot-summary",
                        "--cards",
                        str(cards_path),
                        "--measurement",
                        str(measurement_path),
                        "--output",
                        str(output),
                    ]
                ),
                0,
            )

            summary = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(summary["helpful_before_or_during_work_count"], 1)
        self.assertNotIn(draft["problem"], json.dumps(summary))

    def test_duplicate_keys_are_rejected_before_card_validation(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "ambiguous-card.json"
            source.write_text('{"card_id":"one","card_id":"two"}', encoding="utf-8")

            with self.assertRaisesRegex(WorkflowError, "not unambiguous JSON"):
                load_json_object(source)


if __name__ == "__main__":
    unittest.main()
