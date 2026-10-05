import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


PROBE = Path(__file__).parents[1] / "cloud_contracts" / "sesh_handoff_probe.py"
spec = importlib.util.spec_from_file_location("sesh_boundary_probe", PROBE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class SeshBoundaryProbeTests(unittest.TestCase):
    def test_positive_control_has_consistent_synthetic_integrity(self):
        envelope = probe.timetracker_export()
        message = envelope["messages"][0]
        text = message["content"]["content"]
        self.assertTrue(text.startswith("SYNTHETIC_ONLY:"))
        self.assertEqual(message["content_byte_size"], len(text.encode()))
        self.assertEqual(message["content_sha256"], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(message["content_sha256"], message["content"]["content_sha256"])

    def test_handoff_labels_partial_content_without_native_source_claim(self):
        handoff = probe.hosted_handoff()
        self.assertFalse(handoff["coverage"]["full_transcript"])
        self.assertEqual(handoff["source"], "codex-app.read_thread.v1")
        self.assertNotIn("chat", handoff)
        self.assertNotEqual(probe.consent("selected_excerpt_indexing")["scope"], "full_transcript_indexing")

    def test_external_checkout_must_be_the_reviewed_clean_revision(self):
        with patch.object(probe.subprocess, "check_output", side_effect=["other-revision", ""]):
            with self.assertRaisesRegex(ValueError, "pinned_clean_sesh_checkout_required"):
                probe.run("/synthetic/sesh")
        with patch.object(probe.subprocess, "check_output", side_effect=[probe.SESH_REVISION, " M source.py"]):
            with self.assertRaisesRegex(ValueError, "pinned_clean_sesh_checkout_required"):
                probe.run("/synthetic/sesh")
