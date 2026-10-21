from __future__ import annotations

import fcntl
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.config import load_config
from sherlock_collector.cross_provider import schedule_claude_catchup
from sherlock_collector.cli import main
from sherlock_collector.spool import secure_lock


class CrossProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.claude = self.root / "claude"
        self.codex_config = self.root / "codex/sherlock/collector.json"
        self.claude_config = self.claude / "sherlock/collector.json"
        self.values = {
            "endpoint": "https://example.test/ingest", "name": "Test User",
            "github_id": "test-user", "email": "test@e3group.ai",
            "installation_id": "00000000-0000-4000-8000-000000000001",
        }
        for path in (self.codex_config, self.claude_config):
            self.config(path, self.values)

    def config(self, path, values):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(values))
        path.chmod(0o600)

    def schedule(self, event="PostToolUse", environment=None):
        return schedule_claude_catchup(
            event, codex_config=self.codex_config, claude_home=self.claude,
            environment=environment or {"PYTHONPATH": str(Path(__file__).resolve().parents[2] / "packages/telemetry-collector/src")},
        )

    def test_provider_overrides_cannot_change_sibling_attribution(self):
        environment = {"SHERLOCK_EMAIL": "other@e3group.ai", "SHERLOCK_INGEST_URL": "https://other.test", "SHERLOCK_CONFIG_PATH": "wrong.json"}
        with patch.dict(os.environ, environment), patch("sherlock_collector.cross_provider.subprocess.Popen") as spawn:
            self.assertEqual(self.schedule(environment=environment), "scheduled")
            self.assertEqual(load_config(self.claude_config, use_environment=False).identity.email, "test@e3group.ai")
        command = spawn.call_args.args[0]
        self.assertEqual(command[command.index("--provider") + 1], "claude_code")
        self.assertEqual(command[command.index("--config") + 1], str(self.claude_config))
        self.assertEqual(command[-3:], ["backfill", "--lookback-seconds", "259200"])
        child_environment = spawn.call_args.kwargs["env"]
        self.assertNotIn("SHERLOCK_EMAIL", child_environment)
        self.assertNotIn("SHERLOCK_INGEST_URL", child_environment)
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])

    def test_debounces_tool_hooks_but_catches_final_bytes_at_stop(self):
        with patch("sherlock_collector.cross_provider.subprocess.Popen") as spawn, patch("sherlock_collector.cross_provider.time.time_ns", side_effect=[10**12, 10**12+1, 10**12+2]):
            self.assertEqual(self.schedule(), "scheduled")
            self.assertEqual(self.schedule(), "debounced")
            self.assertEqual(self.schedule("Stop"), "scheduled")
        self.assertEqual(spawn.call_count, 2)

    def test_missing_or_mismatched_configuration_does_not_capture(self):
        with patch("sherlock_collector.cross_provider.subprocess.Popen") as spawn:
            self.config(self.claude_config, {**self.values, "email": "other@e3group.ai"})
            self.assertEqual(self.schedule(), "identity_mismatch")
            self.claude_config.unlink()
            self.assertEqual(self.schedule(), "not_configured")
        spawn.assert_not_called()

    def test_disabled_plugin_and_recovery_opt_out_are_respected(self):
        with patch("sherlock_collector.cross_provider.subprocess.Popen") as spawn:
            self.assertEqual(self.schedule(environment={"SHERLOCK_CLAUDE_CATCHUP_ENABLED": "0"}), "disabled")
            (self.claude / "settings.json").write_text(json.dumps({"enabledPlugins": {"sherlock-claude-code@sherlock": False}}))
            self.assertEqual(self.schedule(), "disabled")
        spawn.assert_not_called()

    def test_busy_or_failed_spawn_remains_retryable(self):
        lock_path = self.claude / "sherlock/telemetry/codex-claude-catchup.lock"
        with secure_lock(lock_path) as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.schedule(), "busy")
        with patch("sherlock_collector.cross_provider.subprocess.Popen", side_effect=OSError("failed")):
            self.assertEqual(self.schedule(), "unavailable")
        self.assertFalse((lock_path.parent / "codex-claude-catchup.json").exists())

    def test_codex_cli_hook_schedules_catchup_even_without_codex_bytes(self):
        with patch("sherlock_collector.cli.schedule_claude_catchup") as schedule, patch("sherlock_collector.cli._payload_from_stdin", return_value=({}, b"{}")):
            result = main(["--codex-home", str(self.root / "codex"), "hook", "PostToolUse"])
        self.assertEqual(result, 0)
        self.assertEqual(schedule.call_args.args, ("PostToolUse",))
        self.assertEqual(schedule.call_args.kwargs["codex_config"], self.codex_config)

    def test_recovery_captures_hookless_primary_transcript_with_usage(self):
        session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        path = self.claude / "projects/repo" / f"{session_id}.jsonl"
        path.parent.mkdir(parents=True)
        raw = (json.dumps({"type": "assistant", "sessionId": session_id,
            "timestamp": "2026-10-12T15:00:00.000Z", "message": {"id": "response",
            "usage": {"input_tokens": 10, "output_tokens": 5}}}) + "\n").encode()
        path.write_bytes(raw)
        with patch("sherlock_collector.cross_provider.subprocess.Popen") as spawn:
            self.assertEqual(self.schedule(), "scheduled")
            command = spawn.call_args.args[0]
        with patch("sherlock_collector.hook.subprocess.Popen"):
            self.assertEqual(main(command[3:]), 0)
            self.assertEqual(main(command[3:]), 0)
        queue = self.claude / "sherlock/telemetry/queue/pending"
        batches = list(queue.glob("*.json"))
        self.assertEqual(len(batches), 1)
        manifest = json.loads(batches[0].read_text())["manifest"]
        self.assertEqual(manifest["source_provider"], "claude_code")
        self.assertEqual(manifest["observed_native_session_id"], session_id)
        self.assertIsNone(manifest["observed_parent_native_session_id"])
        self.assertEqual(manifest["source_byte_count"], len(raw))
        self.assertEqual(path.read_bytes(), raw)
