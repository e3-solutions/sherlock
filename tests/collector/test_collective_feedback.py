from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
CODEX = ROOT / "plugins/sherlock/scripts/collective_feedback.py"
CLAUDE = ROOT / "plugins/sherlock-claude-code/scripts/collective_feedback.py"
CODEX_LAUNCHER = ROOT / "plugins/sherlock/scripts/run_hook.py"


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
            "Submission stays private", "After fully reading each Forum post",
            "before completing the task", "kind=up", "kind=down", "kind=abstain",
            "post_id, body_sha256, explanation, and mutation_id",
            "No positive or negative sentiment is forced",
            "Concern is optional, separate, and only for a specific issue",
            "USE/SKIP line or prose report is not a saved feedback event",
            "same mutation_id and identical payload", "feedback remains unsaved",
            "do not seek broader access",
        ):
            self.assertIn(expected, module.FEEDBACK_CONTEXT)

    def test_codex_compaction_guidance_uses_supported_session_start_contract(self):
        spec = importlib.util.spec_from_file_location("codex_hook_fixture", CODEX_LAUNCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run([
                "git", "-C", str(repo), "remote", "add", "origin",
                "https://github.com/e3-solutions/fixture.git",
            ], check=True)
            payload = {
                "hook_event_name": "SessionStart", "source": "compact",
                "session_id": "session", "cwd": str(repo),
            }
            environment = {
                "E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED": "1",
                "E3_COLLECTIVE_HOOK_STATE_DIR": str(root / "state"),
            }
            output = io.StringIO()
            with patch.dict(os.environ, environment, clear=True), patch.object(
                sys, "path", [str(CODEX.parent), *sys.path]
            ), patch.object(module, "collector_source", return_value=None), patch.object(
                sys, "argv", [str(CODEX_LAUNCHER), "SessionStart"]
            ), patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(
                sys, "stdout", output
            ):
                self.assertEqual(module.main(), 0)
            response = json.loads(output.getvalue())
            self.assertTrue(response["continue"])
            self.assertEqual(
                response["hookSpecificOutput"]["hookEventName"], "SessionStart"
            )
            self.assertIn(
                "After fully reading each Forum post",
                response["hookSpecificOutput"]["additionalContext"],
            )

            output = io.StringIO()
            with patch.object(module, "collector_source", return_value=None), patch.object(
                sys, "argv", [str(CODEX_LAUNCHER), "PostCompact"]
            ), patch.object(sys, "stdin", io.StringIO(json.dumps({"trigger": "auto"}))), patch.object(
                sys, "stdout", output
            ):
                self.assertEqual(module.main(), 0)
            self.assertEqual(json.loads(output.getvalue()), {"continue": True})
