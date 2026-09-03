from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

PACKAGE_SOURCE = (
    Path(__file__).resolve().parents[2] / "packages" / "work_episode" / "src"
)
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

from sherlock_work_episode.candidate import CandidateError, build_unknown_manifest
from sherlock_work_episode.contract import validate_episode
from sherlock_work_episode.views import build_catalog_card

PRIVATE_SENTINEL = "this-must-never-appear-in-a-manifest"
SESSION_ID = "01a0404e-2e3e-7ed2-acf9-bad7448a7d9b"


class CandidateTests(unittest.TestCase):
    def test_hashes_without_parsing_or_emitting_source_content(self):
        source_bytes = f"private event: {PRIVATE_SENTINEL}".encode()
        with TemporaryDirectory() as directory:
            path = Path(directory) / f"rollout-2026-09-03T00-00-00-{SESSION_ID}.jsonl"
            path.write_bytes(source_bytes)

            manifest = build_unknown_manifest(path, episode_id="candidate-001")

        self.assertEqual(validate_episode(manifest), [])
        self.assertEqual(manifest["outcome"]["state"], "unknown")
        self.assertEqual(
            manifest["evidence"][0]["content_sha256"],
            hashlib.sha256(source_bytes).hexdigest(),
        )
        self.assertNotIn(PRIVATE_SENTINEL, json.dumps(manifest, sort_keys=True))
        card = build_catalog_card(manifest, "retrieval")
        self.assertNotIn(PRIVATE_SENTINEL, json.dumps(card, sort_keys=True))

    def test_requires_explicit_session_id_when_filename_is_not_a_rollout(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "private-source.jsonl"
            path.write_text("private")

            with self.assertRaisesRegex(CandidateError, "session_id is required"):
                build_unknown_manifest(path, episode_id="candidate-002")

            manifest = build_unknown_manifest(
                path, episode_id="candidate-002", session_id=SESSION_ID
            )

        self.assertEqual(validate_episode(manifest), [])


if __name__ == "__main__":
    unittest.main()
