from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.discovery import discover_claude_transcripts
from sherlock_collector.hook import run_hook


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "telemetry-collector" / "src"
PLUGIN = ROOT / "plugins" / "sherlock-claude-code"
LAUNCHER = PLUGIN / "scripts" / "run_hook.py"
HOOKS = PLUGIN / "hooks" / "hooks.json"
MANIFEST = PLUGIN / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"


class ClaudePluginTests(unittest.TestCase):
    def test_plugin_is_separate_and_covers_supported_lifecycle_events(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        marketplace = json.loads(MARKETPLACE.read_text(encoding="utf-8"))
        hooks = json.loads(HOOKS.read_text(encoding="utf-8"))["hooks"]

        self.assertEqual(manifest["name"], "sherlock-claude-code")
        self.assertEqual(
            marketplace["plugins"][0]["source"],
            "./plugins/sherlock-claude-code",
        )
        self.assertEqual(
            set(hooks),
            {
                "SessionStart",
                "UserPromptSubmit",
                "PostToolUse",
                "Stop",
                "SubagentStart",
                "SubagentStop",
                "SessionEnd",
            },
        )
        for event, entries in hooks.items():
            handler = entries[0]["hooks"][0]
            self.assertEqual(handler["type"], "command", event)
            self.assertTrue(handler["async"], event)
            self.assertIn("${CLAUDE_PLUGIN_ROOT}/scripts/run_hook.py", handler["command"])

    def test_discovery_prioritizes_main_and_subagent_transcripts(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            session = claude_home / "projects" / "repo" / "session.jsonl"
            agent = (
                claude_home
                / "projects"
                / "repo"
                / "session"
                / "subagents"
                / "agent-worker.jsonl"
            )
            outside = root / "outside.jsonl"
            for path in (session, agent, outside):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{"type":"user"}\n', encoding="utf-8")

            result = discover_claude_transcripts(
                claude_home,
                hook_payload={
                    "session_id": "session-123",
                    "agent_id": "worker-456",
                    "transcript_path": str(session),
                    "agent_transcript_path": str(agent),
                },
            )

            self.assertEqual(result.paths, (session.resolve(), agent.resolve()))
            self.assertEqual(
                result.native_session_ids[str(session.resolve())], "session-123"
            )
            self.assertEqual(
                result.native_session_ids[str(agent.resolve())], "worker-456"
            )
            self.assertEqual(
                result.parent_native_session_ids[str(agent.resolve())], "session-123"
            )
            rejected = discover_claude_transcripts(
                claude_home,
                hook_payload={"transcript_path": str(outside)},
            )
            self.assertEqual(rejected.paths, ())

    def test_claude_hook_spools_provider_specific_exact_bytes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            source = (
                b'{"sessionId":"session-123","type":"user",'
                b'"timestamp":"2026-08-19T00:00:00Z",'
                b'"message":{"role":"user","content":"hello"}}\n'
            )
            transcript.write_bytes(source)
            state_root = claude_home / "sherlock" / "telemetry"

            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                outcome = run_hook(
                    "Stop",
                    {
                        "session_id": "session-123",
                        "transcript_path": str(transcript),
                    },
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(outcome.enqueued, 1)
            self.assertEqual(outcome.captured_bytes, len(source))
            pending = next((state_root / "queue" / "pending").glob("*.json"))
            item = json.loads(pending.read_text(encoding="utf-8"))
            manifest = item["manifest"]
            self.assertEqual(manifest["source_provider"], "claude_code")
            self.assertEqual(manifest["source_kind"], "transcript")
            self.assertEqual(manifest["observed_native_session_id"], "session-123")
            self.assertTrue(
                (state_root / "claude-transcript-state.json").is_file()
            )
            popen.assert_called_once()

    def test_launcher_is_fail_open_when_runtime_is_missing(self):
        with TemporaryDirectory() as temporary:
            environment = os.environ.copy()
            environment["CLAUDE_CONFIG_DIR"] = str(Path(temporary) / "claude")
            started = time.monotonic()
            completed = subprocess.run(
                [sys.executable, str(LAUNCHER), "SessionStart"],
                input="{}",
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0)
            self.assertLess(time.monotonic() - started, 1.0)

    def test_hook_defers_a_transcript_tail_until_the_record_is_complete(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            first = b'{"type":"user","sessionId":"session-123"}\n'
            partial = b'{"type":"assistant","message":'
            transcript.write_bytes(first + partial)
            payload = {
                "session_id": "session-123",
                "transcript_path": str(transcript),
            }
            state_root = claude_home / "sherlock" / "telemetry"

            with patch("sherlock_collector.hook.subprocess.Popen"):
                initial = run_hook(
                    "PostToolUse",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                with transcript.open("ab") as handle:
                    handle.write(b'{"role":"assistant","content":"done"}}\n')
                completed = run_hook(
                    "Stop",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(initial.captured_bytes, len(first))
            self.assertEqual(completed.captured_bytes, transcript.stat().st_size - len(first))
            manifests = [
                json.loads(path.read_text(encoding="utf-8"))["manifest"]
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            self.assertEqual(
                sorted((item["start_offset"], item["end_offset"]) for item in manifests),
                [(0, len(first)), (len(first), transcript.stat().st_size)],
            )

    def test_collector_health_checks_claude_configuration_without_network(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            config = claude_home / "sherlock" / "collector.json"
            config.parent.mkdir(parents=True)
            config.write_text(
                json.dumps(
                    {
                        "endpoint": "https://example.test/ingest",
                        "name": "Test User",
                        "github_id": "test-user",
                        "email": "test@example.com",
                        "installation_id": "00000000-0000-4000-8000-000000000001",
                    }
                ),
                encoding="utf-8",
            )
            config.chmod(0o600)

            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sherlock_collector.cli",
                    "--provider",
                    "claude_code",
                    "--claude-home",
                    str(claude_home),
                    "--config",
                    str(config),
                    "health",
                ],
                check=True,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )

            health = json.loads(completed.stdout)
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["provider"], "claude_code")
            self.assertEqual(health["pending_batches"], 0)


if __name__ == "__main__":
    unittest.main()
