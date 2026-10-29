"""COR-5023: reconciler progress, hook-named sources, and dead-letter visibility."""

from __future__ import annotations
import _isolation  # noqa: F401  (must precede collector imports)

import fcntl
import gzip
import json
import os
import subprocess
import sys
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector import pending_sources
from sherlock_collector.contract import build_source_batch
from sherlock_collector.drain import Drain, PermanentUploadError
from sherlock_collector.exclusions import load_policy
from sherlock_collector.hook import run_hook
from sherlock_collector.overlap_repair import repair_overlap_dead_letters
from sherlock_collector.reconcile import reconcile
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool, secure_lock
from test_collector import SuccessTransport, receipt

SOURCE = Path(__file__).resolve().parents[2] / "packages" / "telemetry-collector" / "src"
NO_DRAIN = [sys.executable, "-c", "pass"]


def transcript(home: Path, index: int, *, records: int = 1) -> tuple[Path, str]:
    """A root Claude transcript whose path sorts by ``index``."""
    native_id = str(uuid.UUID(int=index + 1))
    path = home / "projects" / "repo" / f"{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"type": "user", "sessionId": native_id}).encode() + b"\n"
    path.write_bytes(line * records)
    return path.resolve(), native_id


def policy_excluding(directory: str, session_ids: list[str]):
    path = Path(directory) / "session-exclusions.json"
    path.write_text(json.dumps({"version": 1, "excluded_session_ids": session_ids}))
    return load_policy(path)


def uploaded_ids(transport: SuccessTransport) -> set[str]:
    return {item.manifest.observed_native_session_id for item in transport.items}


def transcript_capturer(state: Path, home: Path) -> RolloutCapturer:
    return RolloutCapturer(
        state,
        DurableSpool(state / "queue"),
        source_provider="claude_code",
        source_kind="transcript",
        state_name="claude-transcript",
        capture_unterminated_tail=False,
        allowed_root=home / "projects",
    )


class ReconcilerCursorTests(unittest.TestCase):
    def test_hook_capture_does_not_reset_the_reconciler_cursor(self):
        """Regression: a hook (empty backlog) used to write candidate_cursor=0.

        On a machine whose first sorted files are owner-excluded, the
        reconciler then re-examined the same blocked files on every run and
        never reached the eligible ones (Vansh: 55 runs, 0 bytes).
        """
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            blocked = [transcript(home, index)[1] for index in range(4)]
            eligible = [transcript(home, 10 + index)[1] for index in range(2)]
            live_path, live_id = transcript(home, 99)
            policy = policy_excluding(directory, blocked)
            transport = SuccessTransport()
            # One blocked file per budgeted file: the cursor must persist across
            # runs for the reconciler to step over all four blocked files.
            with patch("sherlock_collector.rollout.BLOCKED_SCAN_FACTOR", 1), patch(
                "sherlock_collector.rollout.load_policy", return_value=policy
            ), patch("sherlock_collector.drain.load_policy", return_value=policy):
                for _ in range(4):
                    reconcile(home, state, "claude_code", transport, max_files=2)
                    # A hook capture naming only its own live transcript.
                    with live_path.open("ab") as handle:
                        handle.write(
                            json.dumps({"type": "user", "sessionId": live_id}).encode()
                            + b"\n"
                        )
                    hook = transcript_capturer(state, home).capture(
                        [live_path],
                        native_session_ids={str(live_path): live_id},
                        priority_count=1,
                        best_effort=True,
                    )
                    self.assertFalse(hook.locked)
                    self.assertEqual(hook.enqueued, 1)
            self.assertTrue(set(eligible) <= uploaded_ids(transport))
            self.assertFalse(set(blocked) & uploaded_ids(transport))
            saved = json.loads((state / "claude-transcript-state.json").read_text())
            self.assertIn("reconcile", saved["cursors"])

    def test_blocked_backlog_files_do_not_use_the_file_budget(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            blocked = [transcript(home, index)[1] for index in range(10)]
            eligible = [transcript(home, 20 + index)[1] for index in range(2)]
            policy = policy_excluding(directory, blocked)
            transport = SuccessTransport()
            with patch("sherlock_collector.rollout.load_policy", return_value=policy), \
                    patch("sherlock_collector.drain.load_policy", return_value=policy):
                result = reconcile(home, state, "claude_code", transport, max_files=2)
            self.assertEqual(uploaded_ids(transport), set(eligible))
            self.assertEqual(result["eligible_unfinished_sources"], 0)
            self.assertEqual(result["runs_without_progress"], 0)

    def test_reconcile_counts_runs_without_progress(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            path, native_id = transcript(home, 1)
            # A record that never ends cannot be captured; nothing else is due.
            with path.open("ab") as handle:
                handle.write(b'{"type":"user","sessionId":"' + native_id.encode())
            reconcile(home, state, "claude_code", SuccessTransport())
            reconcile(home, state, "claude_code", SuccessTransport())
            result = reconcile(home, state, "claude_code", SuccessTransport())
            self.assertEqual(result["eligible_unfinished_sources"], 1)
            self.assertEqual(result["runs_without_progress"], 2)
            status = json.loads((state / "collector-status.json").read_text())
            self.assertEqual(status["runs_without_progress"], 2)
            self.assertEqual(status["eligible_unfinished_sources"], 1)
            self.assertEqual(status["dead_letters"], 0)


class CaptureJournalTests(unittest.TestCase):
    def test_interrupted_capture_never_recaptures_the_same_start_offset(self):
        """A kill between enqueue and the state save caused HTTP 409 range_overlap."""
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            path, native_id = transcript(home, 1, records=2)
            ids = {str(path): native_id}

            class Killed(BaseException):
                pass

            original = RolloutCapturer._save_state

            def killed(self, *args, **kwargs):
                raise Killed()

            with patch.object(RolloutCapturer, "_save_state", killed):
                with self.assertRaises(Killed):
                    transcript_capturer(state, home).capture(
                        [path], native_session_ids=ids, priority_count=1
                    )
            self.assertIs(RolloutCapturer._save_state, original)
            with path.open("ab") as handle:
                handle.write(json.dumps({"type": "user", "sessionId": native_id}).encode() + b"\n")
            transcript_capturer(state, home).capture(
                [path], native_session_ids=ids, priority_count=1
            )
            spool = DurableSpool(state / "queue")
            ranges = sorted(
                (item.manifest.start_offset, item.manifest.end_offset)
                for item in (spool.load(entry) for entry in spool.list_pending())
            )
            self.assertEqual(len(ranges), 2)
            self.assertEqual(ranges[0][1], ranges[1][0])
            self.assertEqual(ranges[1][1], path.stat().st_size)
            self.assertFalse((state / "claude-transcript-journal.jsonl").exists())

    def test_unspooled_journal_entries_are_ignored(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            path, native_id = transcript(home, 1)
            capturer = transcript_capturer(state, home)
            spool_enqueue = DurableSpool.enqueue

            def lost(self, *args, **kwargs):
                raise KeyboardInterrupt()

            with patch.object(DurableSpool, "enqueue", lost):
                with self.assertRaises(KeyboardInterrupt):
                    capturer.capture([path], native_session_ids={str(path): native_id})
            self.assertIs(DurableSpool.enqueue, spool_enqueue)
            # The journaled advance has no spooled batch, so capture starts at 0.
            transcript_capturer(state, home).capture(
                [path], native_session_ids={str(path): native_id}
            )
            spool = DurableSpool(state / "queue")
            (only,) = [spool.load(entry).manifest for entry in spool.list_pending()]
            self.assertEqual((only.start_offset, only.end_offset), (0, path.stat().st_size))


class HookNamedSourceTests(unittest.TestCase):
    def test_locked_subagent_stop_is_captured_by_a_later_hook(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            parent_path, parent_id = transcript(home, 1)
            agent_id = "a0123456789abcdef"
            agent_path = home / "projects" / "repo" / parent_id / "subagents" / f"agent-{agent_id}.jsonl"
            agent_path.parent.mkdir(parents=True)
            agent_path.write_bytes(
                json.dumps(
                    {"type": "assistant", "sessionId": parent_id, "agentId": agent_id}
                ).encode()
                + b"\n"
            )
            payload = {
                "hook_event_name": "SubagentStop",
                "session_id": parent_id,
                "agent_id": agent_id,
                "transcript_path": str(parent_path),
                "agent_transcript_path": str(agent_path),
            }
            state.mkdir(parents=True)
            # Another capture (a parallel subagent's hook) holds the lock.
            with secure_lock(state / "claude-transcript-sync.lock") as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX)
                skipped = run_hook(
                    "SubagentStop",
                    payload,
                    raw_payload=json.dumps(payload).encode(),
                    provider="claude_code",
                    claude_home=home,
                    state_root=state,
                    drain_command=NO_DRAIN,
                )
            self.assertTrue(skipped.locked)
            self.assertEqual(pending_sources.count(state, "claude-transcript"), 2)

            other_path, other_id = transcript(home, 5)
            later = run_hook(
                "Stop",
                {"hook_event_name": "Stop", "session_id": other_id,
                 "transcript_path": str(other_path)},
                raw_payload=b"{}",
                provider="claude_code",
                claude_home=home,
                state_root=state,
                drain_command=NO_DRAIN,
            )
            self.assertFalse(later.locked)
            spool = DurableSpool(state / "queue")
            captured = {
                (item.manifest.source_kind, item.manifest.observed_native_session_id,
                 item.manifest.observed_parent_native_session_id)
                for item in (spool.load(entry) for entry in spool.list_pending())
            }
            self.assertIn(("transcript", agent_id, parent_id), captured)
            self.assertIn(("transcript", parent_id, None), captured)
            self.assertEqual(pending_sources.count(state, "claude-transcript"), 0)

    def test_reconcile_captures_marked_sources_before_its_backlog(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            for index in range(3):
                transcript(home, index)
            marked_path, marked_id = transcript(home, 50)
            pending_sources.remember(
                state, "claude-transcript", [str(marked_path)], {str(marked_path): marked_id}, {}
            )
            transport = SuccessTransport()
            result = reconcile(home, state, "claude_code", transport, max_files=1)
            self.assertEqual(uploaded_ids(transport), {marked_id})
            self.assertEqual(result["pending_source_markers"], 0)


    def test_unfinishable_markers_age_out_and_never_starve_the_backlog(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            stuck = []
            for index in range(pending_sources.MAX_MARKERS_PER_CAPTURE + 2):
                path, native_id = transcript(home, 100 + index)
                with path.open("ab") as handle:
                    handle.write(b'{"partial":')  # never terminated
                stuck.append((str(path), native_id))
            eligible = [transcript(home, index)[1] for index in range(3)]
            for path, native_id in stuck:
                pending_sources.remember(
                    state, "claude-transcript", [path], {path: native_id}, {}
                )
            transport = SuccessTransport()
            # Markers take at most a quarter of the file budget, so the first
            # run already reaches the backlog.
            reconcile(home, state, "claude_code", transport, max_files=8)
            self.assertTrue(set(eligible) <= uploaded_ids(transport))
            # Each stuck marker is retried MAX_MARKER_ATTEMPTS times, round robin.
            for _ in range(pending_sources.MAX_MARKER_ATTEMPTS * 3):
                reconcile(home, state, "claude_code", transport, max_files=32)
            self.assertEqual(pending_sources.count(state, "claude-transcript"), 0)

    def test_marker_rewritten_during_a_capture_is_not_settled(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            path, native_id = transcript(home, 1)
            pending_sources.remember(state, "claude-transcript", [str(path)], {}, {})
            (loaded,) = pending_sources.load(
                state, "claude-transcript", allowed_root=(home / "projects").resolve()
            )
            # A newer hook names the same source while the capture runs.
            later = loaded.modified_ns + 5_000_000_000
            os.utime(loaded.marker, ns=(later, later))
            removed = pending_sources.settle(
                [loaded],
                visited={str(path)},
                completed={str(path)},
                source_issues={},
                blocked_reasons=frozenset(),
            )
            self.assertEqual(removed, 0)
            self.assertTrue(loaded.marker.exists())


class DeadLetterVisibilityTests(unittest.TestCase):
    def overlap_fixture(self, state: Path):
        spool = DurableSpool(state / "queue")
        lines = [
            json.dumps({"type": "user", "n": index}).encode() + b"\n" for index in range(3)
        ]
        common = dict(
            source_stream_key="stream-overlap",
            generation_key="generation-overlap",
            generation_seq=0,
            start_offset=0,
            source_provider="codex",
            source_kind="rollout",
            observed_native_session_id="11111111-1111-4111-8111-111111111111",
        )
        first, first_stored = build_source_batch(b"".join(lines[:2]), **common)
        longer, longer_stored = build_source_batch(b"".join(lines), **common)
        return spool, lines, first, first_stored, longer, longer_stored

    def test_range_overlap_is_counted_by_code_and_its_tail_is_requeued(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            spool, lines, first, first_stored, longer, longer_stored = self.overlap_fixture(state)
            spool.enqueue(first, first_stored)
            spool.enqueue(longer, longer_stored)

            class Transport:
                def upload(self, item):
                    if item.manifest.end_offset == first.end_offset:
                        return receipt(item.manifest)
                    raise PermanentUploadError(
                        'ingest returned HTTP 409: {"error":{"code":"range_overlap"}}',
                        error_code="range_overlap",
                        http_status=409,
                    )

            result = Drain(spool, Transport()).run()
            self.assertEqual(result.uploaded, 1)
            self.assertEqual(result.dead_lettered, 1)
            self.assertEqual(result.dead_letter_codes, {"409_range_overlap": 1})
            summary = spool.dead_letter_summary()
            self.assertEqual(summary["dead_letter_codes"], {"409_range_overlap": 1})
            self.assertEqual(summary["dead_letters_total"], 1)
            self.assertEqual(summary["dead_letters_total_by_code"], {"409_range_overlap": 1})

            repairs = repair_overlap_dead_letters(spool)
            self.assertEqual(repairs["requeued_batches"], 1)
            (tail_path,) = spool.list_pending()
            tail = spool.load(tail_path)
            self.assertEqual(
                (tail.manifest.start_offset, tail.manifest.end_offset),
                (first.end_offset, longer.end_offset),
            )
            self.assertEqual(gzip.decompress(tail.stored_payload), lines[2])
            self.assertEqual(tail.manifest.generation_key, "generation-overlap")
            # Idempotent: a repaired dead letter is not repaired again.
            self.assertEqual(repair_overlap_dead_letters(spool)["examined"], 0)
            (dead,) = spool.dead_letter.glob("*.json")
            marked = json.loads(dead.read_text())["metadata"]["overlap_repair"]
            self.assertEqual(marked["status"], "requeued")

    def test_overlap_without_a_local_receipt_is_marked_unrepairable(self):
        with TemporaryDirectory() as directory:
            state = Path(directory)
            spool, _, _, _, longer, longer_stored = self.overlap_fixture(state)
            spool.enqueue(longer, longer_stored)

            class Rejecting:
                def upload(self, item):
                    raise PermanentUploadError(
                        "ingest returned HTTP 409", error_code="range_overlap", http_status=409
                    )

            Drain(spool, Rejecting()).run()
            repairs = repair_overlap_dead_letters(spool)
            self.assertEqual(repairs, {"examined": 1, "requeued_batches": 0, "unrepairable": 1})
            self.assertEqual(spool.list_pending(), [])

    def test_health_reports_dead_letter_codes(self):
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
                )
            )
            config.chmod(0o600)
            spool = DurableSpool(claude_home / "sherlock" / "telemetry" / "queue")
            _, _, first, first_stored, _, _ = self.overlap_fixture(Path(temporary) / "x")
            spool.enqueue(first, first_stored)

            class Rejecting:
                def upload(self, item):
                    raise PermanentUploadError(
                        "ingest returned HTTP 409",
                        error_code="storage_integrity_conflict",
                        http_status=409,
                    )

            Drain(spool, Rejecting()).run()
            completed = subprocess.run(
                [
                    sys.executable, "-m", "sherlock_collector.cli",
                    "--provider", "claude_code", "--claude-home", str(claude_home),
                    "--config", str(config), "health",
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": str(SOURCE)},
            )
            self.assertEqual(completed.returncode, 1)
            health = json.loads(completed.stdout)
            self.assertEqual(health["status"], "degraded")
            self.assertEqual(health["dead_letter_batches"], 1)
            self.assertEqual(
                health["dead_letter_codes"], {"409_storage_integrity_conflict": 1}
            )
            self.assertEqual(health["dead_letters_total"], 1)


if __name__ == "__main__":
    unittest.main()
