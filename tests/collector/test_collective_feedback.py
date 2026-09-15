from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
CODEX = ROOT / "plugins/sherlock/scripts/collective_feedback.py"
CLAUDE = ROOT / "plugins/sherlock-claude-code/scripts/collective_feedback.py"


class CollectiveFeedbackTests(unittest.TestCase):
    def test_independent_packages_have_identical_guidance_and_gate(self):
        self.assertEqual(CODEX.read_bytes(), CLAUDE.read_bytes())
        for path in (CODEX, CLAUDE):
            spec = importlib.util.spec_from_file_location("feedback_fixture", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with tempfile.TemporaryDirectory() as temporary:
                env = {"E3_COLLECTIVE_HOOK_STATE_DIR": temporary}
                payload = {"source": "startup", "session_id": "fixture", "cwd": "unused"}
                with patch.dict(os.environ, env, clear=True), patch.object(module, "_e3_repository", return_value=True):
                    self.assertIn("E3 Collective / Forum:", module.feedback_context(payload, event_name="SessionStart", agent="codex"))
                    payload["session_id"] = "explicit-enabled"
                    for invalid in ("", "0", "true"):
                        os.environ["E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED"] = invalid
                        self.assertIsNone(module.feedback_context(payload, event_name="SessionStart", agent="codex"))
                    os.environ["E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED"] = "1"
                    for source in ("startup", "resume", "clear", "compact"):
                        payload["source"] = source
                        self.assertIn("E3 Collective / Forum:", module.feedback_context(payload, event_name="SessionStart", agent="codex"))
                    for event in ("Stop", "UserPromptSubmit", "PostToolUse", "PostCompact", "SubagentStart"):
                        self.assertIsNone(module.feedback_context(payload, event_name=event, agent="codex"))
                    os.environ["E3_COLLECTIVE_HOOK_ENABLED"] = "0"
                    payload["session_id"] = "new"
                    self.assertIsNone(module.feedback_context(payload, event_name="SessionStart", agent="codex"))

    def test_guidance_never_promises_backend_readiness_or_moderation_authority(self):
        spec = importlib.util.spec_from_file_location("feedback_fixture", CODEX)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for expected in (
            "tools being listed is not proof they are enabled",
            "Only a designated librarian in a user-requested review session",
            "Submission stays private", "No post or vote is owed on every request",
            "body_sha256", "do not seek broader access",
        ):
            self.assertIn(expected, module.FEEDBACK_CONTEXT)
