from __future__ import annotations

import json
import base64
import gzip
import hashlib
import os
import subprocess
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector import discovery as discovery_module
from sherlock_collector.claude_hook import write_observation
from sherlock_collector.contract import FRAGMENT_BYTES, MAX_SOURCE_BYTES
from sherlock_collector.discovery import (
    CLAUDE_BACKFILL_MAX_BYTES,
    CLAUDE_BACKFILL_MAX_FILES,
    discover_claude_transcripts,
)
from sherlock_collector.hook import POST_TOOL_DEBOUNCE_SECONDS, run_hook
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "telemetry-collector" / "src"
PLUGIN = ROOT / "plugins" / "sherlock-claude-code"
LAUNCHER = PLUGIN / "scripts" / "run_hook.py"
HOOKS = PLUGIN / "hooks" / "hooks.json"
MANIFEST = PLUGIN / ".claude-plugin" / "plugin.json"
ANALYSIS_SKILL = PLUGIN / "skills" / "sherlock-analysis" / "SKILL.md"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"


class ClaudePluginTests(unittest.TestCase):
    def test_analysis_skill_is_manual_and_matches_complete_review_workflow(self):
        skill = ANALYSIS_SKILL.read_text(encoding="utf-8")
        self.assertIn("disable-model-invocation: true", skill)
        self.assertIn("Follow every `nextCursor` until it is null", skill)
        self.assertIn("discard that traversal and restart", skill)
        self.assertIn("untrusted user-authored text", skill)
        self.assertIn("native file, search, history, and test tools", skill)
        self.assertIn("exactly once", skill)
        self.assertIn("Submit an empty array", skill)
        self.assertIn("never select, rank, or silently truncate", skill)
        self.assertIn("fixes the high-water mark", skill)
        self.assertIn("does not persist approval", skill)
        self.assertIn("does not verify submitter or reviewer identity", skill)

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
            self.assertNotIn("async", handler, event)
            self.assertEqual(handler["timeout"], 2, event)
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

    def test_discovery_backfills_recent_primary_and_subagent_transcripts(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            projects = claude_home / "projects" / "repo"
            current = projects / "current.jsonl"
            primary_id = "11111111-1111-4111-8111-111111111111"
            primary = projects / f"{primary_id}.jsonl"
            agent = (
                projects
                / primary_id
                / "subagents"
                / "agent-worker-456.jsonl"
            )
            flat_agent = projects / "agent-deadbeef.jsonl"
            empty = projects / "33333333-3333-4333-8333-333333333333.jsonl"
            conflicting = projects / "44444444-4444-4444-8444-444444444444.jsonl"
            stale = projects / "22222222-2222-4222-8222-222222222222.jsonl"
            unrelated = projects / "unrelated.jsonl"
            outside = root / "outside.jsonl"
            for path, record in (
                (current, {"type": "user", "sessionId": "current-123"}),
                (primary, {"type": "user", "sessionId": primary_id}),
                (
                    agent,
                    {
                        "type": "assistant",
                        "sessionId": primary_id,
                        "agentId": "worker-456",
                        "isSidechain": True,
                    },
                ),
                (
                    flat_agent,
                    {
                        "type": "assistant",
                        "sessionId": primary_id,
                        "agentId": "deadbeef",
                        "isSidechain": True,
                    },
                ),
                (
                    conflicting,
                    {"type": "user", "sessionId": "wrong-session"},
                ),
                (
                    stale,
                    {
                        "type": "user",
                        "sessionId": "22222222-2222-4222-8222-222222222222",
                    },
                ),
                (unrelated, {"type": "cache"}),
                (outside, {"type": "user", "sessionId": "outside-123"}),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            empty.write_bytes(b"")

            now = datetime.now(timezone.utc)
            old = (now - timedelta(hours=25)).timestamp()
            os.utime(current, (old, old))
            os.utime(stale, (old, old))
            outside_link = projects / "outside-link.jsonl"
            try:
                outside_link.symlink_to(outside)
            except OSError:
                outside_link = None

            result = discover_claude_transcripts(
                claude_home,
                hook_payload={
                    "session_id": "current-123",
                    "transcript_path": str(current),
                },
                lookback_seconds=24 * 60 * 60,
            )

            self.assertEqual(result.paths[0], current.resolve())
            self.assertEqual(
                set(result.paths[1:]),
                {
                    primary.resolve(),
                    agent.resolve(),
                    flat_agent.resolve(),
                    empty.resolve(),
                },
            )
            self.assertEqual(result.priority_count, 1)
            self.assertEqual(result.invalid_count, 1)
            self.assertEqual(
                result.native_session_ids[str(primary.resolve())], primary_id
            )
            self.assertEqual(
                result.native_session_ids[str(agent.resolve())], "worker-456"
            )
            self.assertEqual(
                result.parent_native_session_ids[str(agent.resolve())],
                primary_id,
            )
            self.assertEqual(
                result.native_session_ids[str(flat_agent.resolve())], "deadbeef"
            )
            self.assertEqual(
                result.parent_native_session_ids[str(flat_agent.resolve())],
                primary_id,
            )
            self.assertNotIn(stale.resolve(), result.paths)
            self.assertNotIn(unrelated.resolve(), result.paths)
            if outside_link is not None:
                self.assertNotIn(outside.resolve(), result.paths)

    def test_claude_backfill_cutoff_is_inclusive_and_deterministic(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            project = claude_home / "projects" / "repo"
            included_id = "55555555-5555-4555-8555-555555555555"
            excluded_id = "66666666-6666-4666-8666-666666666666"
            included = project / f"{included_id}.jsonl"
            excluded = project / f"{excluded_id}.jsonl"
            for path, session_id in (
                (included, included_id),
                (excluded, excluded_id),
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                    encoding="utf-8",
                )
            now_ns = 2_000_000_000_000_000_000
            cutoff_ns = now_ns - 24 * 60 * 60 * 1_000_000_000
            os.utime(included, ns=(cutoff_ns, cutoff_ns))
            os.utime(excluded, ns=(cutoff_ns - 1, cutoff_ns - 1))

            with patch(
                "sherlock_collector.discovery.time.time_ns",
                return_value=now_ns,
            ):
                result = discover_claude_transcripts(
                    claude_home,
                    lookback_seconds=24 * 60 * 60,
                )

            self.assertEqual(result.paths, (included.resolve(),))

    def test_claude_backfill_returns_all_candidates_for_durable_pagination(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            project = claude_home / "projects" / "repo"
            older_id = "abababab-abab-4bab-8bab-abababababab"
            newer_id = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
            older = project / f"{older_id}.jsonl"
            newer = project / f"{newer_id}.jsonl"
            for path, session_id in ((older, older_id), (newer, newer_id)):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                    encoding="utf-8",
                )
            now_ns = time.time_ns()
            os.utime(older, ns=(now_ns - 2, now_ns - 2))
            os.utime(newer, ns=(now_ns - 1, now_ns - 1))

            result = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )

            self.assertEqual(result.paths, (newer.resolve(), older.resolve()))
            self.assertEqual(result.omitted_count, 0)
            self.assertEqual(
                set(result.source_snapshots),
                {str(newer.resolve()), str(older.resolve())},
            )

    def test_claude_backfill_identity_open_rejects_raced_symlink(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            session_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
            candidate = project / f"{session_id}.jsonl"
            candidate.parent.mkdir(parents=True)
            candidate.write_text(
                json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                encoding="utf-8",
            )
            outside = root / "outside.jsonl"
            outside.write_text(candidate.read_text(encoding="utf-8"), encoding="utf-8")
            secure_open = discovery_module.open_regular_under_root

            def swap_before_open(allowed_root, path):
                candidate.unlink()
                candidate.symlink_to(outside)
                return secure_open(allowed_root, path)

            with patch.object(
                discovery_module,
                "open_regular_under_root",
                side_effect=swap_before_open,
            ):
                result = discover_claude_transcripts(
                    claude_home,
                    lookback_seconds=24 * 60 * 60,
                )

            self.assertEqual(result.paths, ())
            self.assertEqual(result.invalid_count, 1)

    def test_claude_backfill_identity_open_rejects_raced_fifo_without_blocking(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            session_id = "edededed-eded-4ded-8ded-edededededed"
            candidate = project / f"{session_id}.jsonl"
            candidate.parent.mkdir(parents=True)
            candidate.write_text(
                json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                encoding="utf-8",
            )
            secure_open = discovery_module.open_regular_under_root

            def swap_before_open(allowed_root, path):
                candidate.unlink()
                os.mkfifo(candidate)
                return secure_open(allowed_root, path)

            started = time.monotonic()
            with patch.object(
                discovery_module,
                "open_regular_under_root",
                side_effect=swap_before_open,
            ):
                result = discover_claude_transcripts(
                    claude_home,
                    lookback_seconds=24 * 60 * 60,
                )

            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(result.paths, ())
            self.assertEqual(result.invalid_count, 1)

    def test_claude_backfill_snapshot_clamps_growth_and_captures_other_files(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            project.mkdir(parents=True)
            session_ids = (
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
            )
            transcripts = [project / f"{session_id}.jsonl" for session_id in session_ids]
            initial = {}
            for transcript, session_id in zip(transcripts, session_ids, strict=True):
                source = (
                    json.dumps({"type": "user", "sessionId": session_id}) + "\n"
                ).encode()
                transcript.write_bytes(source)
                initial[str(transcript.resolve())] = source
            discovery = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            appended = (
                json.dumps({"type": "assistant", "sessionId": session_ids[0]})
                + "\n"
            ).encode()
            with transcripts[0].open("ab") as handle:
                handle.write(appended)
            state_root = root / "state"
            spool = DurableSpool(state_root / "queue")
            capturer = RolloutCapturer(
                state_root,
                spool,
                source_provider="claude_code",
                source_kind="transcript",
                state_name="claude-transcript",
                capture_unterminated_tail=False,
                allowed_root=claude_home / "projects",
            )

            first = capturer.capture(
                discovery.paths,
                native_session_ids=discovery.native_session_ids,
                source_snapshots=discovery.source_snapshots,
                max_files=CLAUDE_BACKFILL_MAX_FILES,
                max_sync_bytes=sum(len(source) for source in initial.values()),
                best_effort=True,
            )

            self.assertEqual(first.errors, 0)
            self.assertEqual(
                first.captured_bytes,
                sum(len(source) for source in initial.values()),
            )
            self.assertEqual(first.deferred_files, 0)
            manifests = [spool.load(path).manifest for path in spool.list_pending()]
            self.assertEqual(
                {manifest.source_byte_count for manifest in manifests},
                {len(source) for source in initial.values()},
            )

            resumed = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            second = capturer.capture(
                resumed.paths,
                native_session_ids=resumed.native_session_ids,
                source_snapshots=resumed.source_snapshots,
                max_files=CLAUDE_BACKFILL_MAX_FILES,
                max_sync_bytes=CLAUDE_BACKFILL_MAX_BYTES,
                best_effort=True,
            )
            self.assertEqual(second.captured_bytes, len(appended))
            self.assertEqual(second.deferred_files, 0)

    def test_claude_backfill_rejects_regular_file_replaced_after_discovery(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            project.mkdir(parents=True)
            session_id = "33333333-3333-4333-8333-333333333333"
            transcript = project / f"{session_id}.jsonl"
            source = (
                json.dumps({"type": "user", "sessionId": session_id}) + "\n"
            ).encode()
            transcript.write_bytes(source)
            discovery = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            replacement = project / "replacement"
            replacement.write_bytes(source)
            os.replace(replacement, transcript)
            state_root = root / "state"
            spool = DurableSpool(state_root / "queue")

            outcome = RolloutCapturer(
                state_root,
                spool,
                source_provider="claude_code",
                source_kind="transcript",
                state_name="claude-transcript",
                capture_unterminated_tail=False,
                allowed_root=claude_home / "projects",
            ).capture(
                discovery.paths,
                native_session_ids=discovery.native_session_ids,
                source_snapshots=discovery.source_snapshots,
                best_effort=True,
            )

            self.assertEqual(outcome.errors, 1)
            self.assertEqual(outcome.captured_bytes, 0)
            self.assertEqual(outcome.deferred_bytes, len(source))
            self.assertEqual(spool.list_pending(), [])

    def test_session_start_backfills_recent_claude_transcripts_once(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            session_id = "77777777-7777-4777-8777-777777777777"
            transcript = (
                claude_home / "projects" / "repo" / f"{session_id}.jsonl"
            )
            transcript.parent.mkdir(parents=True)
            source = (
                json.dumps({"type": "user", "sessionId": session_id}) + "\n"
            ).encode()
            transcript.write_bytes(source)
            state_root = claude_home / "sherlock" / "telemetry"

            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                started = run_hook(
                    "SessionStart",
                    {},
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                ordinary = run_hook(
                    "PostToolUse",
                    {},
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(started.discovered, 1)
            self.assertEqual(started.enqueued, 1)
            self.assertEqual(started.captured_bytes, len(source))
            self.assertEqual(ordinary.discovered, 0)
            self.assertEqual(ordinary.enqueued, 0)
            pending = list((state_root / "queue" / "pending").glob("*.json"))
            self.assertEqual(len(pending), 1)
            item = json.loads(pending[0].read_text())
            manifest = item["manifest"]
            self.assertEqual(manifest["observed_native_session_id"], session_id)
            self.assertEqual(item["metadata"]["workload_class"], "backfill")
            self.assertEqual(popen.call_count, 2)

    def test_claude_post_tool_use_is_captured_then_debounced(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            first_record = b'{"type":"user","sessionId":"session-123"}\n'
            second_record = b'{"type":"assistant","sessionId":"session-123"}\n'
            transcript.write_bytes(first_record)
            state_root = claude_home / "sherlock" / "telemetry"
            payload = {
                "session_id": "session-123",
                "transcript_path": str(transcript),
            }
            first_ns = 1_000_000_000_000

            with (
                patch("sherlock_collector.hook.subprocess.Popen") as popen,
                patch(
                    "sherlock_collector.hook.time.time_ns",
                    side_effect=[
                        first_ns,
                        first_ns + 1,
                        first_ns
                        + POST_TOOL_DEBOUNCE_SECONDS * 1_000_000_000,
                    ],
                ),
            ):
                first = run_hook(
                    "PostToolUse",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                with transcript.open("ab") as handle:
                    handle.write(second_record)
                second = run_hook(
                    "PostToolUse",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                third = run_hook(
                    "PostToolUse",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(first.captured_bytes, len(first_record))
            self.assertEqual(second.skipped, "debounced")
            self.assertEqual(third.captured_bytes, len(second_record))
            self.assertEqual(popen.call_count, 2)
            throttle = state_root / "claude_code-post-tool-capture.json"
            self.assertEqual(throttle.stat().st_mode & 0o777, 0o600)

    def test_session_start_keeps_current_transcript_out_of_backfill_lane(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            project = claude_home / "projects" / "repo"
            current_id = "78787878-7878-4878-8878-787878787878"
            recent_id = "79797979-7979-4979-8979-797979797979"
            current = project / f"{current_id}.jsonl"
            recent = project / f"{recent_id}.jsonl"
            for path, session_id in ((current, current_id), (recent, recent_id)):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                    encoding="utf-8",
                )
            state_root = claude_home / "sherlock" / "telemetry"

            with patch("sherlock_collector.hook.subprocess.Popen"):
                outcome = run_hook(
                    "SessionStart",
                    {
                        "session_id": current_id,
                        "transcript_path": str(current),
                    },
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(outcome.enqueued, 2)
            items = [
                json.loads(path.read_text())
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            by_session = {
                item["manifest"]["observed_native_session_id"]: item
                for item in items
            }
            self.assertNotIn("workload_class", by_session[current_id]["metadata"])
            self.assertEqual(
                by_session[recent_id]["metadata"]["workload_class"],
                "backfill",
            )

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

    def test_launcher_detaches_capture_and_preserves_hook_stdin(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            source = (
                b'{"sessionId":"session-detached","type":"assistant",'
                b'"timestamp":"2026-08-19T00:00:00Z",'
                b'"message":{"role":"assistant","content":"done"}}\n'
            )
            transcript.write_bytes(source)
            environment = {
                **os.environ,
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "SHERLOCK_COLLECTOR_SOURCE": str(SOURCE),
            }
            hook_input = json.dumps(
                {
                    "session_id": "session-detached",
                    "transcript_path": str(transcript),
                }
            )
            started = time.monotonic()
            completed = subprocess.run(
                [sys.executable, str(LAUNCHER), "Stop"],
                input=hook_input,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0)
            self.assertLess(time.monotonic() - started, 1.0)
            pending = claude_home / "sherlock" / "telemetry" / "queue" / "pending"
            deadline = time.monotonic() + 3
            paths = []
            while time.monotonic() < deadline:
                paths = list(pending.glob("*.json")) if pending.is_dir() else []
                if len(paths) >= 2:
                    break
                time.sleep(0.02)
            self.assertEqual(len(paths), 2)
            telemetry = claude_home / "sherlock" / "telemetry"
            state_paths = (
                telemetry / "claude-hook-state.json",
                telemetry / "claude-transcript-state.json",
            )
            while time.monotonic() < deadline:
                if all(path.is_file() for path in state_paths):
                    break
                time.sleep(0.02)
            self.assertTrue(all(path.is_file() for path in state_paths))
            # The launcher intentionally returns before its detached capture.
            # Give that child a short quiet window after both durable cursors
            # appear so temporary-directory cleanup cannot race its final fsync.
            time.sleep(0.1)
            items = [
                json.loads(path.read_text(encoding="utf-8")) for path in paths
            ]
            item = next(
                value
                for value in items
                if value["manifest"]["source_kind"] == "transcript"
            )
            self.assertEqual(item["manifest"]["source_provider"], "claude_code")
            stored = base64.b64decode(item["stored_payload_base64"], validate=True)
            self.assertEqual(gzip.decompress(stored), source)
            hook = next(
                value
                for value in items
                if value["manifest"]["source_kind"] == "hook"
            )
            hook_source = gzip.decompress(
                base64.b64decode(
                    hook["stored_payload_base64"], validate=True
                )
            )
            observation = json.loads(hook_source)
            self.assertEqual(
                base64.b64decode(observation["payload_base64"]),
                hook_input.encode(),
            )

    def test_terminal_launcher_waits_for_asynchronous_transcript_tail(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            first = b'{"sessionId":"session-late","type":"user"}\n'
            partial = b'{"sessionId":"session-late","type":"assistant","message":'
            completed_tail = b'{"role":"assistant","content":"done"}}\n'
            transcript.write_bytes(first + partial)
            environment = {
                **os.environ,
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "SHERLOCK_COLLECTOR_SOURCE": str(SOURCE),
            }
            launched = subprocess.run(
                [sys.executable, str(LAUNCHER), "SessionEnd"],
                input=json.dumps(
                    {
                        "session_id": "session-late",
                        "transcript_path": str(transcript),
                    }
                ),
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(launched.returncode, 0)
            with transcript.open("ab") as handle:
                handle.write(completed_tail)

            pending = claude_home / "sherlock" / "telemetry" / "queue" / "pending"
            deadline = time.monotonic() + 3
            paths = []
            while time.monotonic() < deadline:
                paths = list(pending.glob("*.json")) if pending.is_dir() else []
                if len(paths) >= 2:
                    break
                time.sleep(0.02)
            self.assertEqual(len(paths), 2)
            items = [
                json.loads(path.read_text(encoding="utf-8")) for path in paths
            ]
            item = next(
                value
                for value in items
                if value["manifest"]["source_kind"] == "transcript"
            )
            self.assertEqual(item["manifest"]["record_count"], 2)
            stored = base64.b64decode(item["stored_payload_base64"], validate=True)
            self.assertEqual(gzip.decompress(stored), first + partial + completed_tail)

    def test_stop_spools_an_order_independent_immutable_hook_fact(self):
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            session_id = "0e80d9f3-de3e-498d-91b1-18beb3790278"
            prompt_uuid = "1d1ab296-9746-4cca-bceb-768359d37b30"
            assistant_uuid = "d6d138fa-1ec7-4991-828d-fb3d672db7de"
            source = (
                json.dumps(
                    {
                        "parentUuid": None,
                        "sessionId": session_id,
                        "type": "user",
                        "uuid": prompt_uuid,
                        "message": {"role": "user", "content": "hello"},
                    },
                    separators=(",", ":"),
                )
                + "\n"
                + json.dumps(
                    {
                        "parentUuid": prompt_uuid,
                        "sessionId": session_id,
                        "type": "assistant",
                        "uuid": assistant_uuid,
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "done"}],
                            "stop_reason": None,
                        },
                    },
                    separators=(",", ":"),
                )
                + "\n"
            ).encode()
            transcript.write_bytes(source)
            payload = {
                "session_id": session_id,
                "transcript_path": str(transcript),
                "hook_event_name": "Stop",
                "stop_hook_active": False,
                "last_assistant_message": "done",
            }
            raw_payload = json.dumps(payload, separators=(",", ":")).encode()
            state_root = claude_home / "sherlock" / "telemetry"

            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                initial = run_hook(
                    "PostToolUse",
                    payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                terminal = run_hook(
                    "Stop",
                    payload,
                    raw_payload=raw_payload,
                    provider="claude_code",
                    claude_home=claude_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(initial.enqueued, 1)
            self.assertEqual(terminal.enqueued, 1)
            pending = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            self.assertEqual(len(pending), 2)
            hook = next(
                item
                for item in pending
                if item["manifest"]["source_kind"] == "hook"
            )
            self.assertEqual(
                hook["manifest"]["observed_native_session_id"], session_id
            )
            self.assertIsNone(
                hook["manifest"]["observed_parent_native_session_id"]
            )
            stored = base64.b64decode(
                hook["stored_payload_base64"], validate=True
            )
            observation = json.loads(gzip.decompress(stored))
            self.assertEqual(observation["type"], "claude_hook")
            self.assertEqual(
                observation["schema_version"], "sherlock.claude-hook.v1"
            )
            self.assertEqual(
                base64.b64decode(observation["payload_base64"]), raw_payload
            )
            self.assertEqual(observation["native_session_id"], session_id)
            self.assertEqual(observation["turn_anchor_id"], prompt_uuid)
            self.assertEqual(
                observation["terminal_assistant_uuid"], assistant_uuid
            )
            self.assertEqual(observation["transcript_byte_count"], len(source))
            self.assertEqual(
                observation["transcript_sha256"],
                hashlib.sha256(source).hexdigest(),
            )
            self.assertNotIn("transcript_path", observation)
            self.assertNotIn("transcript", observation)
            self.assertEqual(popen.call_count, 2)

    def test_legacy_stop_payload_anchors_only_the_final_non_tool_assistant(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            transcript = claude_home / "projects" / "repo" / "session.jsonl"
            transcript.parent.mkdir(parents=True)
            session_id = "0e80d9f3-de3e-498d-91b1-18beb3790278"
            prompt_uuid = "1d1ab296-9746-4cca-bceb-768359d37b30"
            assistant_uuid = "d6d138fa-1ec7-4991-828d-fb3d672db7de"
            records = [
                {
                    "parentUuid": None,
                    "sessionId": session_id,
                    "type": "user",
                    "uuid": prompt_uuid,
                    "message": {"role": "user", "content": "hello"},
                },
                {
                    "parentUuid": prompt_uuid,
                    "sessionId": session_id,
                    "type": "assistant",
                    "uuid": assistant_uuid,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                        "stop_reason": None,
                    },
                },
            ]
            source = b"".join(
                (
                    json.dumps(record, separators=(",", ":")) + "\n"
                ).encode()
                for record in records
            )
            transcript.write_bytes(source)
            payload = {
                "cwd": str(root),
                "hook_event_name": "Stop",
                "permission_mode": "default",
                "session_id": session_id,
                "stop_hook_active": False,
                "transcript_path": str(transcript),
            }
            raw_payload = json.dumps(payload, separators=(",", ":")).encode()

            path = write_observation(
                root / "state",
                "Stop",
                payload,
                raw_payload,
                transcript_path=transcript,
            )
            observation = json.loads(path.read_text(encoding="utf-8"))

            self.assertEqual(observation["turn_anchor_id"], prompt_uuid)
            self.assertEqual(
                observation["terminal_assistant_uuid"], assistant_uuid
            )
            self.assertEqual(
                base64.b64decode(observation["payload_base64"]), raw_payload
            )

            records.append(
                {
                    "parentUuid": assistant_uuid,
                    "sessionId": session_id,
                    "type": "assistant",
                    "uuid": "6b799f2b-720a-4be2-9abf-a9e575893e0c",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "using a tool"},
                            {
                                "type": "tool_use",
                                "id": "tool-1",
                                "name": "Read",
                            },
                        ],
                    },
                }
            )
            transcript.write_bytes(
                b"".join(
                    (
                        json.dumps(record, separators=(",", ":")) + "\n"
                    ).encode()
                    for record in records
                )
            )
            rejected_path = write_observation(
                root / "state",
                "Stop",
                payload,
                raw_payload,
                transcript_path=transcript,
            )
            rejected = json.loads(rejected_path.read_text(encoding="utf-8"))
            self.assertIsNone(rejected["turn_anchor_id"])
            self.assertIsNone(rejected["terminal_assistant_uuid"])

    def test_manual_claude_capture_uses_transcript_contract(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            transcript = root / "explicit-transcript.jsonl"
            transcript.write_bytes(b'{"type":"user","sessionId":"manual"}\n')
            state_root = root / "state"
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sherlock_collector.cli",
                    "--provider",
                    "claude_code",
                    "--claude-home",
                    str(claude_home),
                    "--state-root",
                    str(state_root),
                    "capture",
                    str(transcript),
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            pending = list((state_root / "queue" / "pending").glob("*.json"))
            self.assertEqual(len(pending), 1)
            manifest = json.loads(pending[0].read_text(encoding="utf-8"))["manifest"]
            self.assertEqual(manifest["source_provider"], "claude_code")
            self.assertEqual(manifest["source_kind"], "transcript")
            self.assertTrue((state_root / "claude-transcript-state.json").is_file())

    def test_manual_claude_backfill_is_bounded_and_idempotent(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            session_id = "88888888-8888-4888-8888-888888888888"
            transcript = (
                claude_home / "projects" / "repo" / f"{session_id}.jsonl"
            )
            transcript.parent.mkdir(parents=True)
            source = (
                json.dumps({"type": "user", "sessionId": session_id}) + "\n"
            ).encode()
            transcript.write_bytes(source)
            state_root = claude_home / "sherlock" / "telemetry"
            command = [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--provider",
                "claude_code",
                "--claude-home",
                str(claude_home),
                "--state-root",
                str(state_root),
                "--config",
                str(root / "missing-config.json"),
                "backfill",
                "--lookback-seconds",
                str(24 * 60 * 60),
            ]
            environment = {**os.environ, "PYTHONPATH": str(SOURCE)}

            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            repeated = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            first = json.loads(completed.stdout)
            second = json.loads(repeated.stdout)
            self.assertEqual(first["status"], "complete")
            self.assertEqual(first["discovered"], 1)
            self.assertEqual(first["enqueued"], 1)
            self.assertEqual(first["captured_bytes"], len(source))
            self.assertEqual(second["enqueued"], 0)
            self.assertEqual(second["captured_bytes"], 0)
            pending = list((state_root / "queue" / "pending").glob("*.json"))
            self.assertEqual(len(pending), 1)
            item = json.loads(pending[0].read_text())
            manifest = item["manifest"]
            self.assertEqual(manifest["source_provider"], "claude_code")
            self.assertEqual(manifest["source_kind"], "transcript")
            self.assertEqual(manifest["observed_native_session_id"], session_id)
            self.assertEqual(item["metadata"]["workload_class"], "backfill")

    def test_claude_backfill_chunks_a_large_transcript_without_byte_loss(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            session_id = "99999999-9999-4999-8999-999999999999"
            transcript = (
                claude_home / "projects" / "repo" / f"{session_id}.jsonl"
            )
            transcript.parent.mkdir(parents=True)
            record = (
                json.dumps(
                    {
                        "type": "assistant",
                        "sessionId": session_id,
                        "message": {"role": "assistant", "content": "stable"},
                    },
                    separators=(",", ":"),
                )
                + "\n"
            ).encode()
            source = record * 25_000
            self.assertGreater(len(source), 1024 * 1024)
            transcript.write_bytes(source)
            state_root = claude_home / "sherlock" / "telemetry"

            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sherlock_collector.cli",
                    "--provider",
                    "claude_code",
                    "--claude-home",
                    str(claude_home),
                    "--state-root",
                    str(state_root),
                    "--config",
                    str(root / "missing-config.json"),
                    "backfill",
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            outcome = json.loads(completed.stdout)
            self.assertEqual(outcome["status"], "complete")
            self.assertEqual(outcome["captured_bytes"], len(source))
            self.assertGreater(outcome["enqueued"], 1)
            items = [
                json.loads(path.read_text())
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            items.sort(key=lambda item: item["manifest"]["start_offset"])
            self.assertTrue(
                all(
                    item["manifest"]["source_provider"] == "claude_code"
                    and item["manifest"]["source_kind"] == "transcript"
                    for item in items
                )
            )
            reconstructed = b"".join(
                gzip.decompress(
                    base64.b64decode(item["stored_payload_base64"], validate=True)
                )
                for item in items
            )
            self.assertEqual(reconstructed, source)

    def test_oversized_claude_subagent_defers_then_fragments_provider_neutrally(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            primary_id = "11111111-1111-4111-8111-111111111111"
            agent_id = "worker-oversized"
            transcript = (
                claude_home
                / "projects"
                / "repo"
                / primary_id
                / "subagents"
                / f"agent-{agent_id}.jsonl"
            )
            transcript.parent.mkdir(parents=True)
            prefix = (
                json.dumps(
                    {
                        "type": "assistant",
                        "sessionId": primary_id,
                        "agentId": agent_id,
                        "isSidechain": True,
                        "message": {
                            "role": "assistant",
                            "content": "",
                        },
                    },
                    separators=(",", ":"),
                )[:-3]
                + '"'
            ).encode()
            suffix = b'"}}'
            target_without_newline = MAX_SOURCE_BYTES + 37
            oversized_partial = (
                prefix
                + b"x" * (target_without_newline - len(prefix) - len(suffix))
                + suffix
            )
            self.assertEqual(len(oversized_partial), target_without_newline)
            transcript.write_bytes(oversized_partial)
            state_root = root / "state"
            spool = DurableSpool(state_root / "queue")
            capturer = RolloutCapturer(
                state_root,
                spool,
                source_provider="claude_code",
                source_kind="transcript",
                state_name="claude-transcript",
                capture_unterminated_tail=False,
                allowed_root=claude_home / "projects",
            )

            partial_discovery = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            partial = capturer.capture(
                partial_discovery.paths,
                native_session_ids=partial_discovery.native_session_ids,
                parent_native_session_ids=(
                    partial_discovery.parent_native_session_ids
                ),
                source_snapshots=partial_discovery.source_snapshots,
                max_sync_bytes=1024 * 1024,
                backlog_workload_class="backfill",
            )
            self.assertEqual(partial.enqueued, 0)
            self.assertEqual(partial.captured_bytes, 0)
            self.assertEqual(partial.deferred_bytes, len(oversized_partial))

            later = (
                json.dumps(
                    {
                        "type": "user",
                        "sessionId": primary_id,
                        "agentId": agent_id,
                        "isSidechain": True,
                        "message": {"role": "user", "content": "later"},
                    },
                    separators=(",", ":"),
                )
                + "\n"
            ).encode()
            with transcript.open("ab") as handle:
                handle.write(b"\n" + later)
            complete_discovery = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            fragmented = capturer.capture(
                complete_discovery.paths,
                native_session_ids=complete_discovery.native_session_ids,
                parent_native_session_ids=(
                    complete_discovery.parent_native_session_ids
                ),
                source_snapshots=complete_discovery.source_snapshots,
                max_sync_bytes=1024 * 1024,
                backlog_workload_class="backfill",
            )
            oversized = oversized_partial + b"\n"
            expected_fragments = (
                len(oversized) + FRAGMENT_BYTES - 1
            ) // FRAGMENT_BYTES
            self.assertEqual(fragmented.enqueued, expected_fragments)
            self.assertEqual(fragmented.captured_bytes, len(oversized))
            self.assertEqual(fragmented.deferred_bytes, len(later))

            fragment_items = [
                json.loads(path.read_text())
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            fragment_items.sort(key=lambda item: item["manifest"]["start_offset"])
            self.assertEqual(len(fragment_items), expected_fragments)
            for index, item in enumerate(fragment_items):
                manifest = item["manifest"]
                locator = manifest["records"][0]
                self.assertEqual(manifest["source_provider"], "claude_code")
                self.assertEqual(manifest["source_kind"], "transcript")
                self.assertEqual(manifest["observed_native_session_id"], agent_id)
                self.assertEqual(
                    manifest["observed_parent_native_session_id"],
                    primary_id,
                )
                self.assertEqual(locator["parse_status"], "fragment")
                self.assertEqual(locator["fragment_index"], index)
                self.assertEqual(locator["fragment_count"], expected_fragments)
                self.assertEqual(item["metadata"]["workload_class"], "backfill")
            reconstructed = b"".join(
                gzip.decompress(
                    base64.b64decode(item["stored_payload_base64"], validate=True)
                )
                for item in fragment_items
            )
            self.assertEqual(reconstructed, oversized)

            resumed = capturer.capture(
                complete_discovery.paths,
                native_session_ids=complete_discovery.native_session_ids,
                parent_native_session_ids=(
                    complete_discovery.parent_native_session_ids
                ),
                source_snapshots=complete_discovery.source_snapshots,
                backlog_workload_class="backfill",
            )
            self.assertEqual(resumed.enqueued, 1)
            self.assertEqual(resumed.captured_bytes, len(later))
            self.assertEqual(resumed.deferred_bytes, 0)
            all_items = [
                json.loads(path.read_text())
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            ordinary = next(
                item
                for item in all_items
                if item["manifest"]["records"][0]["parse_status"] != "fragment"
            )
            self.assertEqual(ordinary["manifest"]["source_provider"], "claude_code")
            self.assertEqual(
                ordinary["manifest"]["observed_parent_native_session_id"],
                primary_id,
            )

    def test_claude_backfill_does_not_stop_at_live_hook_file_limit(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            project.mkdir(parents=True)
            for index in range(70):
                session_id = f"aaaaaaaa-aaaa-4aaa-8aaa-{index:012d}"
                (project / f"{session_id}.jsonl").write_text(
                    json.dumps({"type": "user", "sessionId": session_id}) + "\n",
                    encoding="utf-8",
                )
            state_root = claude_home / "sherlock" / "telemetry"

            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sherlock_collector.cli",
                    "--provider",
                    "claude_code",
                    "--claude-home",
                    str(claude_home),
                    "--state-root",
                    str(state_root),
                    "--config",
                    str(root / "missing-config.json"),
                    "backfill",
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            outcome = json.loads(completed.stdout)
            self.assertEqual(outcome["discovered"], 70)
            self.assertEqual(outcome["enqueued"], 70)
            self.assertEqual(outcome["omitted"], 0)
            self.assertEqual(
                len(list((state_root / "queue" / "pending").glob("*.json"))),
                70,
            )

    def test_claude_backfill_cursor_eventually_covers_4097_files(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            project.mkdir(parents=True)
            for index in range(CLAUDE_BACKFILL_MAX_FILES):
                session_id = str(uuid.UUID(int=index + 1))
                (project / f"{session_id}.jsonl").write_bytes(b"")
            final_id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
            final = project / f"{final_id}.jsonl"
            final_source = (
                json.dumps({"type": "user", "sessionId": final_id}) + "\n"
            ).encode()
            final.write_bytes(final_source)
            discovery = discover_claude_transcripts(
                claude_home,
                lookback_seconds=24 * 60 * 60,
            )
            state_root = root / "state"
            spool = DurableSpool(state_root / "queue")
            capturer = RolloutCapturer(
                state_root,
                spool,
                source_provider="claude_code",
                source_kind="transcript",
                state_name="claude-transcript",
                capture_unterminated_tail=False,
                allowed_root=claude_home / "projects",
            )

            first = capturer.capture(
                discovery.paths,
                native_session_ids=discovery.native_session_ids,
                source_snapshots=discovery.source_snapshots,
                max_files=CLAUDE_BACKFILL_MAX_FILES,
                max_sync_bytes=CLAUDE_BACKFILL_MAX_BYTES,
                best_effort=True,
            )
            second = capturer.capture(
                discovery.paths,
                native_session_ids=discovery.native_session_ids,
                source_snapshots=discovery.source_snapshots,
                max_files=CLAUDE_BACKFILL_MAX_FILES,
                max_sync_bytes=CLAUDE_BACKFILL_MAX_BYTES,
                best_effort=True,
            )

            self.assertEqual(len(discovery.paths), CLAUDE_BACKFILL_MAX_FILES + 1)
            self.assertEqual(discovery.omitted_count, 0)
            self.assertEqual(first.captured_bytes, 0)
            self.assertEqual(first.deferred_files, 1)
            self.assertEqual(first.deferred_bytes, len(final_source))
            self.assertEqual(second.captured_bytes, len(final_source))
            self.assertEqual(second.deferred_files, 0)
            state = json.loads(
                (state_root / "claude-transcript-state.json").read_text()
            )
            self.assertEqual(
                len(state["streams"]),
                CLAUDE_BACKFILL_MAX_FILES + 1,
            )

    def test_claude_backfill_reports_and_resumes_unterminated_tail_exactly_once(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            project = claude_home / "projects" / "repo"
            project.mkdir(parents=True)
            session_id = "44444444-4444-4444-8444-444444444444"
            transcript = project / f"{session_id}.jsonl"
            complete = (
                json.dumps({"type": "user", "sessionId": session_id}) + "\n"
            ).encode()
            partial = b'{"type":"assistant"'
            transcript.write_bytes(complete + partial)
            state_root = root / "state"
            command = [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--provider",
                "claude_code",
                "--claude-home",
                str(claude_home),
                "--state-root",
                str(state_root),
                "--config",
                str(root / "missing-config.json"),
                "backfill",
            ]
            environment = {**os.environ, "PYTHONPATH": str(SOURCE)}

            first_process = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            first = json.loads(first_process.stdout)
            with transcript.open("ab") as handle:
                handle.write(b"}\n")
            second_process = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            second = json.loads(second_process.stdout)
            third_process = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            third = json.loads(third_process.stdout)

            self.assertEqual(first_process.returncode, 0, first_process.stderr)
            self.assertEqual(first["status"], "partial")
            self.assertEqual(first["captured_bytes"], len(complete))
            self.assertEqual(first["deferred_files"], 1)
            self.assertEqual(first["deferred_bytes"], len(partial))
            self.assertEqual(second_process.returncode, 0, second_process.stderr)
            self.assertEqual(second["status"], "complete")
            self.assertEqual(second["captured_bytes"], len(partial) + 2)
            self.assertEqual(second["deferred_files"], 0)
            self.assertEqual(third_process.returncode, 0, third_process.stderr)
            self.assertEqual(third["captured_bytes"], 0)
            pending = [
                json.loads(path.read_text())
                for path in (state_root / "queue" / "pending").glob("*.json")
            ]
            pending.sort(key=lambda item: item["manifest"]["start_offset"])
            reconstructed = b"".join(
                gzip.decompress(
                    base64.b64decode(item["stored_payload_base64"], validate=True)
                )
                for item in pending
            )
            self.assertEqual(reconstructed, complete + partial + b"}\n")

    def test_install_verifier_requires_enabled_plugin(self):
        verifier = PLUGIN / "scripts" / "verify_install.py"
        with TemporaryDirectory() as temporary:
            claude_home = Path(temporary) / "claude"
            claude_home.mkdir()
            settings = claude_home / "settings.json"
            settings.write_text('{"enabledPlugins":{}}\n', encoding="utf-8")
            environment = {**os.environ, "CLAUDE_CONFIG_DIR": str(claude_home)}

            disabled = subprocess.run(
                [sys.executable, str(verifier)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertNotEqual(disabled.returncode, 0)

            settings.write_text(
                json.dumps(
                    {"enabledPlugins": {"sherlock-claude-code@sherlock": True}}
                ),
                encoding="utf-8",
            )
            enabled = subprocess.run(
                [sys.executable, str(verifier)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(enabled.returncode, 0, enabled.stderr)
            self.assertEqual(json.loads(enabled.stdout)["check"], "local_plugin_enabled")

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
            self.assertEqual(health["processing_batches"], 0)

            dead_letter = (
                claude_home
                / "sherlock"
                / "telemetry"
                / "queue"
                / "dead-letter"
                / "failed.json"
            )
            dead_letter.write_text("{}\n", encoding="utf-8")
            degraded = subprocess.run(
                completed.args,
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )
            self.assertEqual(degraded.returncode, 1)
            degraded_health = json.loads(degraded.stdout)
            self.assertEqual(degraded_health["status"], "degraded")
            self.assertEqual(degraded_health["dead_letter_batches"], 1)


if __name__ == "__main__":
    unittest.main()
