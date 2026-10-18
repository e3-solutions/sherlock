from __future__ import annotations

import fcntl
import io
import json
import os
import subprocess
import sys
import time
import unittest
import uuid
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.cli import main
from sherlock_collector.contract import MAX_SOURCE_BYTES, validate_stored_payload
from sherlock_collector.drain import (
    CollectorUploadError,
    Drain,
    PermanentUploadError,
    TransientUploadError,
)
from sherlock_collector.hook import run_hook
from sherlock_collector.inventory import collection_inventory
from sherlock_collector.reconcile import reconcile
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool, secure_lock
from test_collector import SuccessTransport, batch


def native_file(home, provider, *, tail=b"", archived=False, native_id=None):
    native_id = native_id or str(uuid.uuid4())
    if provider == "codex":
        path = (
            home
            / ("archived_sessions" if archived else "sessions")
            / f"rollout-{native_id}.jsonl"
        )
        record = {"type": "session_meta", "payload": {"id": native_id}}
    else:
        path = home / "projects" / "repo" / f"{native_id}.jsonl"
        record = {"type": "user", "sessionId": native_id}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(record).encode() + b"\n" + tail)
    return path.resolve()


class ReconcileTests(unittest.TestCase):
    def test_old_unindexed_sources_are_captured_and_deferred_work_never_expires(self):
        for provider in ("codex", "claude_code"):
            with self.subTest(provider=provider), TemporaryDirectory() as directory:
                home, state = Path(directory) / provider, Path(directory) / "state"
                paths = [
                    native_file(home, provider, archived=index == 2)
                    for index in range(3)
                ]
                for path in paths:
                    os.utime(path, (1, 1))
                transport = SuccessTransport()
                first = reconcile(home, state, provider, transport, max_files=1)
                self.assertEqual(first["unfinished_sources"], 2)
                ledger_path = state / f"{provider}-reconcile.json"
                self.assertEqual(len(json.loads(ledger_path.read_text())["sources"]), 3)
                for _ in range(3):
                    result = reconcile(home, state, provider, transport, max_files=1)
                self.assertEqual(result["status"], "complete")
                self.assertEqual(len(transport.items), 3)
                self.assertTrue(
                    all(
                        item.metadata["workload_class"] == "backfill"
                        for item in transport.items
                    )
                )

    def test_byte_budget_resumes_without_loss_or_starvation(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            paths = [native_file(home, "codex", tail=b"{}\n" * 20) for _ in range(3)]
            transport = SuccessTransport()
            for _ in range(12):
                result = reconcile(home, state, "codex", transport, max_bytes=128)
                self.assertLessEqual(result["capture"]["captured_bytes"], 128)
            self.assertEqual(result["status"], "complete")
            self.assertEqual(
                sum(item.manifest.source_byte_count for item in transport.items),
                sum(p.stat().st_size for p in paths),
            )

    def test_retry_backoff_and_recovery_without_new_source_or_hook(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(home, "claude_code")

            class Offline:
                def upload(self, item):
                    raise TransientUploadError("offline")

            failed = reconcile(home, state, "claude_code", Offline())
            self.assertEqual(failed["drain"]["requeued"], 1)
            spool = DurableSpool(state / "queue")
            item = spool.load(spool.list_pending()[0])
            self.assertEqual(item.metadata["upload_attempts"], 1)
            self.assertGreater(item.metadata["next_upload_at"], time.time())
            transport = SuccessTransport()
            delayed = reconcile(home, state, "claude_code", transport)
            self.assertEqual(delayed["drain"]["uploaded"], 0)
            # Recovery is independent of discovery; even a missing source is fine.
            path.unlink()
            with patch(
                "sherlock_collector.drain.time.time", return_value=time.time() + 3600
            ):
                recovered = reconcile(home, state, "claude_code", transport)
            self.assertEqual(recovered["drain"]["uploaded"], 1)
            ledger = json.loads((state / "claude_code-reconcile.json").read_text())
            self.assertEqual(
                ledger["sources"][str(path)]["status"], "source_missing_or_invalid"
            )

    def test_collector_outage_is_reported_and_new_capture_stays_queued(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            native_file(home, "codex")

            class Forbidden:
                def upload(self, item):
                    raise CollectorUploadError(
                        "HTTP 401", error_code="invalid_jwt", http_status=401
                    )

            failed = reconcile(home, state, "codex", Forbidden())
            self.assertEqual(failed["status"], "partial")
            self.assertEqual(failed["drain"]["collector_failure"]["http_status"], 401)
            native_file(home, "codex")
            transport = SuccessTransport()
            delayed = reconcile(home, state, "codex", transport)
            self.assertEqual(delayed["pending_uploads"], 2)
            self.assertEqual(
                delayed["drain"]["collector_failure"]["error_code"], "invalid_jwt"
            )
            self.assertEqual(transport.items, [])
            self.assertEqual(delayed["dead_letters"], 0)
            with patch(
                "sherlock_collector.drain.time.time", return_value=time.time() + 3600
            ):
                recovered = reconcile(home, state, "codex", transport)
            self.assertEqual(recovered["status"], "complete")
            self.assertEqual(recovered["drain"]["uploaded"], 2)

    def test_abandoned_processing_is_recovered_on_idle_machine(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            home.mkdir()
            spool = DurableSpool(state / "queue")
            manifest, stored = batch("abandoned")
            spool.claim(spool.enqueue(manifest, stored))
            result = reconcile(home, state, "codex", SuccessTransport())
            self.assertEqual(result["drain"]["recovered"], 1)
            self.assertEqual(result["drain"]["uploaded"], 1)

    def test_dead_letter_retains_exact_payload_and_does_not_block_later_ranges(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            home.mkdir()
            spool = DurableSpool(state / "queue")
            first, stored = batch("a")
            spool.enqueue(first, stored)
            second, second_stored = batch("a", first.end_offset)
            spool.enqueue(second, second_stored)
            other, other_stored = batch("b")
            spool.enqueue(other, other_stored)

            class RejectFirst(SuccessTransport):
                def upload(self, item):
                    if item.manifest == first:
                        raise PermanentUploadError(
                            "HTTP 400: invalid manifest",
                            error_code="invalid_manifest",
                            http_status=400,
                        )
                    return super().upload(item)

            result = reconcile(home, state, "codex", RejectFirst())
            self.assertEqual(result["drain"]["dead_lettered"], 1)
            self.assertEqual(result["drain"]["uploaded"], 2)
            self.assertEqual(result["status"], "partial")
            evidence = spool.load(next(spool.dead_letter.glob("*.json")))
            self.assertEqual(evidence.manifest, first)
            self.assertEqual(evidence.stored_payload, stored)
            self.assertEqual(
                evidence.metadata["dead_letter"]["error_code"], "invalid_manifest"
            )
            self.assertEqual(evidence.metadata["dead_letter"]["http_status"], 400)

    def test_hook_capture_and_drain_lock_contention_are_respected(self):
        for provider in ("codex", "claude_code"):
            with self.subTest(provider=provider), TemporaryDirectory() as directory:
                home, state = Path(directory) / "home", Path(directory) / "state"
                native_file(home, provider)
                name = "claude-transcript" if provider == "claude_code" else "rollout"
                with secure_lock(state / f"{name}-sync.lock") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    result = reconcile(home, state, provider, SuccessTransport())
                    self.assertTrue(result["locked"])
                    self.assertEqual(result["capture"]["enqueued"], 0)
                spool = DurableSpool(state / "queue")
                with secure_lock(spool.lock_path) as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    result = reconcile(home, state, provider, SuccessTransport())
                    self.assertTrue(result["drain"]["locked"])
                self.assertEqual(
                    reconcile(home, state, provider, SuccessTransport())["status"],
                    "complete",
                )
                with secure_lock(state / f"{provider}-reconcile.lock") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.assertTrue(
                        reconcile(home, state, provider, SuccessTransport())["locked"]
                    )

    def test_blocked_record_is_durable_and_other_sources_progress(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            bad = native_file(home, "codex", tail=b"x" * (MAX_SOURCE_BYTES + 1) + b"\n")
            good = native_file(home, "codex")
            transport = SuccessTransport()
            # Exercise the existing hard limit without allocating 100 MiB.
            original = RolloutCapturer._native_record_fragment_plan

            def blocked(self, *args):
                self.max_record_bytes = MAX_SOURCE_BYTES
                return original(self, *args)

            with patch.object(RolloutCapturer, "_native_record_fragment_plan", blocked):
                result = reconcile(home, state, "codex", transport)
            ledger = json.loads((state / "codex-reconcile.json").read_text())["sources"]
            self.assertIn("exceeds", ledger[str(bad)]["reason"])
            self.assertGreater(ledger[str(bad)]["deferred_bytes"], 0)
            self.assertEqual(ledger[str(good)]["status"], "captured")
            self.assertEqual(result["unfinished_sources"], 1)
            self.assertTrue(bad.exists())

    def test_incomplete_tail_is_retained_until_completed(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(home, "codex", tail=b'{"value":"hel')
            transport = SuccessTransport()
            reconcile(home, state, "codex", transport)
            ledger = json.loads((state / "codex-reconcile.json").read_text())["sources"]
            self.assertEqual(ledger[str(path)]["reason"], "incomplete_trailing_record")
            with path.open("ab") as handle:
                handle.write(b'lo"}\n')
            self.assertEqual(
                reconcile(home, state, "codex", transport)["status"], "complete"
            )
            raw = b"".join(
                validate_stored_payload(i.manifest, i.stored_payload)
                for i in sorted(transport.items, key=lambda i: i.manifest.start_offset)
            )
            self.assertEqual(raw, path.read_bytes())

    def test_codex_hook_never_advances_into_half_a_line(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(home, "codex", tail=b'{"value":"hel')
            with patch("sherlock_collector.hook._spawn_drain"):
                run_hook(
                    "Stop",
                    {"transcript_path": str(path), "rollout_path": str(path)},
                    codex_home=home,
                    state_root=state,
                    drain_command=["unused"],
                )
            spool = DurableSpool(state / "queue")
            first = [spool.load(p) for p in spool.list_pending()]
            self.assertTrue(first)
            self.assertTrue(
                all(
                    validate_stored_payload(i.manifest, i.stored_payload).endswith(
                        b"\n"
                    )
                    for i in first
                )
            )
            with path.open("ab") as handle:
                handle.write(b'lo"}\n')
            reconcile(home, state, "codex", None)
            items = sorted(
                [spool.load(p) for p in spool.list_pending()],
                key=lambda i: i.manifest.start_offset,
            )
            self.assertEqual(
                b"".join(
                    validate_stored_payload(i.manifest, i.stored_payload) for i in items
                ),
                path.read_bytes(),
            )

    def test_codex_stop_tail_is_captured_by_next_hook_in_same_generation(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(
                home, "codex", tail=b'{"type":"response_item","payload":'
            )
            payload = {"transcript_path": str(path), "rollout_path": str(path)}
            with patch("sherlock_collector.hook._spawn_drain"):
                initial = run_hook(
                    "Stop",
                    payload,
                    codex_home=home,
                    state_root=state,
                    drain_command=["unused"],
                )
                with path.open("ab") as handle:
                    handle.write(
                        b'{"type":"message","role":"assistant","content":[]}}\n'
                    )
                completed = run_hook(
                    "Stop",
                    payload,
                    codex_home=home,
                    state_root=state,
                    drain_command=["unused"],
                )
            self.assertGreater(completed.captured_bytes, 0)
            self.assertEqual(
                initial.captured_bytes + completed.captured_bytes, path.stat().st_size
            )
            spool = DurableSpool(state / "queue")
            items = [spool.load(p) for p in spool.list_pending()]
            self.assertEqual(len({i.manifest.generation_key for i in items}), 1)
            self.assertEqual(sum(i.manifest.record_count for i in items), 2)

    def test_install_verifiers_surface_persisted_collector_failure(self):
        repository = Path(__file__).resolve().parents[2]
        for provider, plugin, variable in (
            ("codex", "sherlock", "CODEX_HOME"),
            ("claude_code", "sherlock-claude-code", "CLAUDE_CONFIG_DIR"),
        ):
            with self.subTest(provider=provider), TemporaryDirectory() as directory:
                home = Path(directory)
                config = home / "sherlock" / "collector.json"
                config.parent.mkdir()
                config.write_text(
                    json.dumps(
                        {
                            "name": "Test User",
                            "github_id": "test-user",
                            "email": "test@e3group.ai",
                            "endpoint": "https://example.test/ingest",
                            "installation_id": "00000000-0000-4000-8000-000000000001",
                        }
                    )
                )
                config.chmod(0o600)
                (home / "settings.json").write_text(
                    json.dumps(
                        {"enabledPlugins": {"sherlock-claude-code@sherlock": True}}
                    )
                )
                (home / "sherlock" / "scheduler.json").write_text(
                    '{"status":"disabled"}'
                )
                spool = DurableSpool(home / "sherlock" / "telemetry" / "queue")
                spool.defer_uploads(
                    CollectorUploadError(
                        "HTTP 403",
                        error_code="collector_domain_forbidden",
                        http_status=403,
                    )
                )
                output = io.StringIO()
                home_flag = (
                    "--claude-home" if provider == "claude_code" else "--codex-home"
                )
                with redirect_stdout(output):
                    exit_code = main(
                        ["--provider", provider, home_flag, str(home), "reconcile"]
                    )
                self.assertEqual(exit_code, 75)
                self.assertEqual(
                    json.loads(output.getvalue())["drain"]["collector_failure"][
                        "http_status"
                    ],
                    403,
                )
                script = (
                    repository / "plugins" / plugin / "scripts" / "verify_install.py"
                )
                failed = subprocess.run(
                    [sys.executable, str(script)],
                    capture_output=True,
                    text=True,
                    env={**os.environ, variable: str(home)},
                    check=False,
                )
                self.assertEqual(failed.returncode, 1, failed.stderr)
                report = json.loads(failed.stdout)
                self.assertEqual(report["status"], "degraded")
                self.assertEqual(
                    report["upload"]["error_code"], "collector_domain_forbidden"
                )
                self.assertEqual(report["upload"]["http_status"], 403)
                spool.clear_upload_failure()
                recovered = subprocess.run(
                    [sys.executable, str(script)],
                    capture_output=True,
                    text=True,
                    env={**os.environ, variable: str(home)},
                    check=False,
                )
                self.assertEqual(
                    recovered.returncode, 0, recovered.stdout + recovered.stderr
                )
                self.assertEqual(
                    json.loads(recovered.stdout)["upload"]["status"], "ready"
                )

    def test_legacy_partial_cursor_continues_same_generation_without_rewriting_evidence(
        self,
    ):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(home, "codex", tail=b'{"value":"hel')
            spool = DurableSpool(state / "queue")
            RolloutCapturer(state, spool, capture_unterminated_tail=True).capture(
                [path]
            )
            original = {p: p.read_bytes() for p in spool.list_pending()}
            original_end = path.stat().st_size
            original_item = spool.load(next(iter(original)))
            # Mark the legacy condition even before the writer grows the file.
            reconcile(home, state, "codex", None)
            with path.open("ab") as handle:
                handle.write(b'lo"}')
            waiting = reconcile(home, state, "codex", None)
            self.assertEqual(waiting["capture"]["enqueued"], 0)
            with path.open("ab") as handle:
                handle.write(b'\n{"next":"record"}\n')
            reconcile(home, state, "codex", None)
            self.assertEqual({p: p.read_bytes() for p in original}, original)
            items = sorted(
                [spool.load(p) for p in spool.list_pending()],
                key=lambda i: i.manifest.start_offset,
            )
            self.assertEqual(len(items), 2)
            self.assertTrue(all(i.manifest.generation_seq == 0 for i in items))
            self.assertTrue(
                all(
                    i.manifest.generation_key == original_item.manifest.generation_key
                    for i in items
                )
            )
            self.assertEqual(items[1].manifest.start_offset, original_end)
            self.assertEqual(
                validate_stored_payload(items[1].manifest, items[1].stored_payload),
                b'lo"}\n{"next":"record"}\n',
            )
            self.assertEqual(
                b"".join(
                    validate_stored_payload(i.manifest, i.stored_payload) for i in items
                ),
                path.read_bytes(),
            )
            ledger = json.loads((state / "codex-reconcile.json").read_text())["sources"]
            self.assertEqual(
                ledger[str(path)]["recovery_reason"],
                "legacy_unterminated_cursor_continued",
            )
            self.assertEqual(ledger[str(path)]["status"], "captured")

    def test_drain_run_upload_budget_is_enforced(self):
        with TemporaryDirectory() as directory:
            spool = DurableSpool(Path(directory) / "queue")
            for index in range(5):
                manifest, stored = batch(str(index))
                spool.enqueue(manifest, stored)
            self.assertEqual(
                Drain(spool, SuccessTransport()).run(max_items=2).uploaded, 2
            )
            self.assertEqual(len(spool.list_pending()), 3)

    def test_fragmented_record_waits_for_budget_then_resumes_exactly(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(
                home, "codex", tail=b"x" * (MAX_SOURCE_BYTES + 1) + b"\n"
            )
            transport = SuccessTransport()
            first = reconcile(home, state, "codex", transport, max_bytes=1024 * 1024)
            self.assertLessEqual(first["capture"]["captured_bytes"], 1024 * 1024)
            ledger = json.loads((state / "codex-reconcile.json").read_text())["sources"]
            self.assertEqual(
                ledger[str(path)]["reason"], "record_exceeds_remaining_run_budget"
            )
            second = reconcile(home, state, "codex", transport)
            self.assertEqual(second["status"], "complete")
            raw = b"".join(
                validate_stored_payload(i.manifest, i.stored_payload)
                for i in sorted(transport.items, key=lambda i: i.manifest.start_offset)
            )
            self.assertEqual(raw, path.read_bytes())

    def test_partial_capture_failure_still_consumes_byte_budget(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            bad, good = root / "a.jsonl", root / "b.jsonl"
            bad.write_bytes(b"{}\n" + b"x" * 1025 + b"\n")
            good.write_bytes(b"{}\n" * 100)
            spool = DurableSpool(root / "queue")
            result = RolloutCapturer(
                root / "state",
                spool,
                max_object_bytes=1024,
                chunk_bytes=128,
            ).capture([bad, good], best_effort=True, max_sync_bytes=128)
            durable_bytes = sum(
                spool.load(path).manifest.source_byte_count
                for path in spool.list_pending()
            )
            self.assertEqual(result.errors, 1)
            self.assertEqual(result.captured_bytes, durable_bytes)
            self.assertLessEqual(durable_bytes, 128)

    def test_corrupt_ledger_is_preserved_and_upload_recovery_still_runs(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            home.mkdir()
            spool = DurableSpool(state / "queue")
            manifest, stored = batch("recovery")
            spool.enqueue(manifest, stored)
            ledger = state / "codex-reconcile.json"
            ledger.write_bytes(b"broken ledger evidence")
            result = reconcile(home, state, "codex", SuccessTransport())
            self.assertEqual(result["status"], "partial")
            self.assertIn("ledger_error", result)
            self.assertEqual(result["drain"]["uploaded"], 1)
            self.assertEqual(ledger.read_bytes(), b"broken ledger evidence")

    def test_dead_letter_collision_preserves_prior_evidence(self):
        with TemporaryDirectory() as directory:
            spool = DurableSpool(Path(directory) / "queue")
            manifest, stored = batch("rejected")
            pending = spool.enqueue(manifest, stored)
            historical = spool.dead_letter / pending.name
            historical.write_bytes(b"prior raw evidence")

            class Rejected:
                def upload(self, item):
                    raise PermanentUploadError(
                        "HTTP 409: range overlap",
                        error_code="range_overlap",
                        http_status=409,
                    )

            self.assertEqual(Drain(spool, Rejected()).run().dead_lettered, 1)
            self.assertEqual(historical.read_bytes(), b"prior raw evidence")
            self.assertEqual(len(list(spool.dead_letter.glob("*.json"))), 2)

    def test_drain_stops_scheduling_at_time_budget(self):
        with TemporaryDirectory() as directory:
            spool = DurableSpool(Path(directory) / "queue")
            for index in range(5):
                manifest, stored = batch(str(index))
                spool.enqueue(manifest, stored)
            now = [0]

            class Slow(SuccessTransport):
                def upload(self, item):
                    now[0] = 200
                    return super().upload(item)

            with patch(
                "sherlock_collector.drain.time.monotonic", side_effect=lambda: now[0]
            ):
                self.assertEqual(
                    Drain(spool, Slow(), max_workers=1).run(max_seconds=120).uploaded, 1
                )
            self.assertEqual(len(spool.list_pending()), 4)

    def test_cli_rejects_zero_budget_before_writing(self):
        with TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            self.assertEqual(
                main(["--state-root", str(state), "reconcile", "--max-files", "0"]), 2
            )
            self.assertFalse(state.exists())


class ClaudeInventoryTests(unittest.TestCase):
    def test_inventory_uses_provider_specific_receipts_and_detects_appends(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            path = native_file(home, "claude_code")
            report = collection_inventory(home, state, provider="claude_code")
            self.assertEqual(report["sources"][0]["status"], "pending")
            reconcile(home, state, "claude_code", SuccessTransport())
            report = collection_inventory(home, state, provider="claude_code")
            self.assertEqual(report["scope"]["provider"], "claude_code")
            self.assertEqual(report["status"], "complete")
            with path.open("ab") as handle:
                handle.write(b'{"type":"assistant"')
            report = collection_inventory(home, state, provider="claude_code")
            self.assertEqual(report["status"], "partial")
            self.assertTrue(report["sources"][0]["incomplete_trailing_record"])
            self.assertEqual(report["sources"][0]["status"], "pending")

    def test_uuid_inventory_includes_subagents_and_ignores_lookback(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "home", Path(directory) / "state"
            native_id = str(uuid.uuid4())
            path = native_file(home, "claude_code", native_id=native_id)
            subagent = path.parent / native_id / "subagents" / "agent-child.jsonl"
            subagent.parent.mkdir(parents=True)
            subagent.write_text(
                json.dumps({"sessionId": native_id, "agentId": "child"}) + "\n"
            )
            for source in (path, subagent):
                os.utime(source, (1, 1))
            reconcile(home, state, "claude_code", SuccessTransport())
            report = collection_inventory(
                home, state, provider="claude_code", session_id=native_id
            )
            self.assertEqual(report["status"], "complete")
            self.assertEqual(len(report["sources"]), 2)
            self.assertEqual(
                collection_inventory(home, state, provider="claude_code")["status"],
                "partial",
            )
