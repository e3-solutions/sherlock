from __future__ import annotations

import json
import os
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.contract import (
    ContractError,
    RECEIPT_VERSION,
    build_rollout_batch,
)
from sherlock_collector.config import CollectorIdentity
from sherlock_collector.drain import (
    Drain,
    PermanentUploadError,
    TransientUploadError,
)
from sherlock_collector.hook import capture_and_spawn_drain
from sherlock_collector.http import HttpTransport
from sherlock_collector.rollout import (
    DEFAULT_MAX_FILES,
    RolloutCapturer,
)
from sherlock_collector.spool import DurableSpool, SpoolItem


WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
PERSON_ID = "00000000-0000-4000-8000-000000000002"
COLLECTOR_KEY = "collector-test"


def batch(
    stream: str,
    start: int = 0,
    *,
    generation_seq: int = 0,
    generation_key: str = "generation-test",
):
    raw = (
        json.dumps({"type": "event", "timestamp": "2026-08-14T00:00:00Z"}).encode()
        + b"\n"
    )
    return build_rollout_batch(
        raw,
        source_stream_key=stream,
        generation_key=generation_key,
        generation_seq=generation_seq,
        start_offset=start,
    )


def receipt(manifest, **overrides):
    value = {
        "receipt_version": RECEIPT_VERSION,
        "status": "committed",
        "batch_id": str(uuid.uuid4()),
        "workspace_id": WORKSPACE_ID,
        "person_id": PERSON_ID,
        "collector_key": COLLECTOR_KEY,
        "source_kind": manifest.source_kind,
        "source_stream_key": manifest.source_stream_key,
        "generation_key": manifest.generation_key,
        "generation_seq": manifest.generation_seq,
        "start_offset": manifest.start_offset,
        "end_offset": manifest.end_offset,
        "source_byte_count": manifest.source_byte_count,
        "source_sha256": manifest.source_sha256,
        "storage_path": (
            f"workspaces/{WORKSPACE_ID}/collectors/{COLLECTOR_KEY}/rollout/"
            f"{manifest.source_stream_key}/generations/"
            f"{manifest.generation_seq}-{manifest.generation_key}/"
            f"{manifest.start_offset}-{manifest.end_offset}-{manifest.source_sha256}.jsonl.gz"
        ),
        "stored_byte_count": manifest.stored_byte_count,
        "stored_sha256": manifest.stored_sha256,
        "record_count": manifest.record_count,
        "contract_version": manifest.contract_version,
        "committed_at": "2026-08-14T00:00:00.000Z",
    }
    value.update(overrides)
    return value


class SuccessTransport:
    def __init__(self):
        self.items = []

    def upload(self, item):
        self.items.append(item)
        return receipt(item.manifest)


class HttpTransportTests(unittest.TestCase):
    def test_upload_sends_normalized_collector_identity_without_authorization(self):
        manifest, stored = batch("stream-http")
        item = SpoolItem(manifest, stored, {})

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return json.dumps(receipt(manifest)).encode()

        with patch(
            "sherlock_collector.http.urllib.request.urlopen",
            return_value=Response(),
        ) as urlopen:
            value = HttpTransport(
                "https://example.test/ingest",
                CollectorIdentity(
                    name="Test User",
                    github_id="test-user",
                    email="test@example.com",
                    installation_id="00000000-0000-4000-8000-000000000001",
                ),
            ).upload(item)

        request = urlopen.call_args.args[0]
        body = json.loads(request.data)
        self.assertNotIn("Authorization", request.headers)
        self.assertEqual(body["collector"]["email"], "test@example.com")
        self.assertEqual(body["collector"]["github_id"], "test-user")
        self.assertEqual(value["status"], "committed")


class CollectorDrainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.spool = DurableSpool(self.root / "queue")

    def tearDown(self):
        self.temporary.cleanup()

    def enqueue(self, stream="stream-a", start=0):
        manifest, stored = batch(stream, start)
        return manifest, self.spool.enqueue(manifest, stored)

    def test_processing_items_are_recovered_after_crash(self):
        _, pending = self.enqueue()
        self.spool.claim(pending)
        transport = SuccessTransport()

        result = Drain(self.spool, transport).run()

        self.assertEqual(result.recovered, 1)
        self.assertEqual(result.uploaded, 1)
        self.assertEqual(self.spool.list_pending(), [])
        self.assertEqual(list(self.spool.processing.glob("*.json")), [])

    def test_sensitive_spool_directories_and_files_are_owner_only(self):
        _, pending = self.enqueue()
        directory_modes = {
            self.spool.root.stat().st_mode & 0o777,
            self.spool.pending.stat().st_mode & 0o777,
            self.spool.processing.stat().st_mode & 0o777,
            self.spool.dead_letter.stat().st_mode & 0o777,
        }
        self.assertEqual(directory_modes, {0o700})
        self.assertEqual(pending.stat().st_mode & 0o777, 0o600)

        Drain(self.spool, SuccessTransport()).run()
        self.assertEqual(self.spool.lock_path.stat().st_mode & 0o777, 0o600)

    def test_concurrent_drain_loser_does_not_upload(self):
        self.enqueue()
        started = threading.Event()
        release = threading.Event()

        class BlockingTransport(SuccessTransport):
            def upload(inner_self, item):
                started.set()
                release.wait(2)
                return super().upload(item)

        transport = BlockingTransport()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(Drain(self.spool, transport).run)
            self.assertTrue(started.wait(1))
            second = Drain(self.spool, transport).run()
            release.set()
            first_result = first.result()

        self.assertTrue(second.locked)
        self.assertEqual(first_result.uploaded, 1)
        self.assertEqual(len(transport.items), 1)

    def test_transient_failure_is_requeued_once_per_drain(self):
        self.enqueue()

        class Transient:
            calls = 0

            def upload(inner_self, _item):
                inner_self.calls += 1
                raise TransientUploadError("try later")

        transport = Transient()
        result = Drain(self.spool, transport).run()

        self.assertEqual(result.requeued, 1)
        self.assertEqual(transport.calls, 1)
        queued = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(queued.metadata["last_upload_error"], "try later")

    def test_permanent_failure_is_quarantined(self):
        self.enqueue()

        class Permanent:
            def upload(self, _item):
                raise PermanentUploadError("bad payload")

        result = Drain(self.spool, Permanent()).run()

        self.assertEqual(result.dead_lettered, 1)
        self.assertEqual(self.spool.list_pending(), [])
        dead = list(self.spool.dead_letter.glob("*.json"))
        self.assertEqual(len(dead), 1)
        self.assertEqual(
            self.spool.load(dead[0]).metadata["dead_letter"]["reason"],
            "bad payload",
        )

    def test_success_removes_stale_matching_dead_letter(self):
        manifest, pending = self.enqueue()
        stale = self.spool.dead_letter / pending.name
        stale.write_bytes(pending.read_bytes())

        result = Drain(self.spool, SuccessTransport()).run()

        self.assertEqual(result.uploaded, 1)
        self.assertFalse(stale.exists())
        self.assertEqual(manifest.source_stream_key, "stream-a")

    def test_items_enqueued_during_upload_are_drained_before_return(self):
        first_manifest, _ = self.enqueue("stream-a")
        enqueued = False
        transport = SuccessTransport()

        def upload(item):
            nonlocal enqueued
            transport.items.append(item)
            if not enqueued:
                enqueued = True
                next_manifest, stored = batch("stream-b")
                self.spool.enqueue(next_manifest, stored)
            return receipt(item.manifest)

        transport.upload = upload
        result = Drain(self.spool, transport).run()

        self.assertEqual(result.uploaded, 2)
        self.assertEqual(len(transport.items), 2)
        self.assertEqual(transport.items[0].manifest, first_manifest)

    def test_independent_streams_upload_concurrently(self):
        self.enqueue("stream-a")
        self.enqueue("stream-b")
        active = 0
        peak = 0
        lock = threading.Lock()
        gate = threading.Barrier(2)

        class Concurrent:
            def upload(inner_self, item):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                gate.wait(timeout=1)
                time.sleep(0.02)
                with lock:
                    active -= 1
                return receipt(item.manifest)

        result = Drain(self.spool, Concurrent(), max_workers=2).run()

        self.assertEqual(result.uploaded, 2)
        self.assertEqual(peak, 2)

    def test_same_stream_uploads_in_offset_order_without_overlap(self):
        first_manifest, first_stored = batch("stream-a", 0)
        second_manifest, second_stored = batch("stream-a", first_manifest.end_offset)
        # Enqueue in reverse order to prove ordering comes from the manifest.
        self.spool.enqueue(second_manifest, second_stored)
        self.spool.enqueue(first_manifest, first_stored)
        order = []
        active = 0
        peak = 0

        class Ordered:
            def upload(inner_self, item):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                order.append(item.manifest.start_offset)
                time.sleep(0.01)
                active -= 1
                return receipt(item.manifest)

        result = Drain(self.spool, Ordered(), max_workers=4).run()

        self.assertEqual(result.uploaded, 2)
        self.assertEqual(order, [0, first_manifest.end_offset])
        self.assertEqual(peak, 1)

    def test_receipt_mismatch_retains_artifact(self):
        self.enqueue()

        class Mismatch:
            def upload(inner_self, item):
                return receipt(item.manifest, source_sha256="0" * 64)

        result = Drain(self.spool, Mismatch()).run()

        self.assertEqual(result.requeued, 1)
        self.assertEqual(len(self.spool.list_pending()), 1)

    def test_invalid_local_artifact_is_dead_lettered_without_transport(self):
        bad = self.spool.pending / "bad.json"
        bad.write_text("not json", encoding="utf-8")
        transport = SuccessTransport()

        result = Drain(self.spool, transport).run()

        self.assertEqual(result.dead_lettered, 1)
        self.assertEqual(transport.items, [])


class RolloutCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.spool = DurableSpool(self.root / "queue")
        self.rollout = self.root / "rollout.jsonl"
        self.capturer = RolloutCapturer(
            self.root / "state", self.spool, chunk_bytes=128
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_capture_limits_reject_unbounded_inverse_configuration(self):
        with self.assertRaises(ValueError):
            RolloutCapturer(
                self.root / "invalid-state",
                self.spool,
                chunk_bytes=2048,
                max_object_bytes=1024,
            )

    def test_offsets_advance_only_after_durable_enqueue(self):
        source = b'{"type":"one"}\n{"type":"two"}\n'
        self.rollout.write_bytes(source)

        result = self.capturer.capture([self.rollout])

        self.assertEqual(result.captured_bytes, len(source))
        item = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(item.manifest.source_byte_count, len(source))
        state = json.loads((self.root / "state" / "rollout-state.json").read_text())
        only = next(iter(state["streams"].values()))
        self.assertEqual(only["offset"], len(source))

    def test_replacement_advances_monotonic_generation_sequence(self):
        self.rollout.write_bytes(b'{"type":"first"}\n')
        self.capturer.capture([self.rollout])
        first = self.spool.load(self.spool.list_pending()[0]).manifest
        replacement = self.root / "replacement"
        replacement.write_bytes(b'{"type":"second"}\n')
        os.replace(replacement, self.rollout)

        self.capturer.capture([self.rollout])

        manifests = [
            self.spool.load(path).manifest for path in self.spool.list_pending()
        ]
        second = max(manifests, key=lambda item: item.generation_seq)
        self.assertEqual(first.generation_seq, 0)
        self.assertEqual(second.generation_seq, 1)
        self.assertNotEqual(first.generation_key, second.generation_key)

    def test_unterminated_tail_is_preserved_exactly(self):
        source = b'{"type":"tail","value":"exact"}'
        self.rollout.write_bytes(source)

        self.capturer.capture([self.rollout])

        item = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(
            item.manifest.source_sha256,
            __import__("hashlib").sha256(source).hexdigest(),
        )
        self.assertEqual(item.manifest.end_offset, len(source))

    def test_corrupt_primary_state_recovers_from_durable_backup(self):
        first = b'{"type":"first"}\n'
        second = b'{"type":"second"}\n'
        self.rollout.write_bytes(first)
        self.capturer.capture([self.rollout])
        state_root = self.root / "state"
        (state_root / "rollout-state.json").write_text(
            "not-json\n",
            encoding="utf-8",
        )
        with self.rollout.open("ab") as handle:
            handle.write(second)

        result = self.capturer.capture([self.rollout])

        self.assertEqual(result.enqueued, 1)
        manifests = [
            self.spool.load(path).manifest for path in self.spool.list_pending()
        ]
        self.assertEqual({item.generation_seq for item in manifests}, {0})
        self.assertEqual(len({item.generation_key for item in manifests}), 1)
        appended = max(manifests, key=lambda item: item.start_offset)
        self.assertEqual(appended.start_offset, len(first))

    def test_occurred_bounds_use_time_order_not_record_order(self):
        source = (
            b'{"type":"later","timestamp":"2026-08-14T02:00:00Z"}\n'
            b'{"type":"earlier","timestamp":"2026-08-14T01:00:00Z"}\n'
        )
        self.rollout.write_bytes(source)

        self.capturer.capture([self.rollout])

        item = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(item.manifest.first_occurred_at, "2026-08-14T01:00:00Z")
        self.assertEqual(item.manifest.last_occurred_at, "2026-08-14T02:00:00Z")

    def test_hook_spools_before_detached_drain_without_network(self):
        self.rollout.write_bytes(b'{"type":"hook"}\n')

        with patch("sherlock_collector.hook.subprocess.Popen") as popen:
            result = capture_and_spawn_drain(
                self.capturer,
                [self.rollout],
                ["sherlock-collector", "drain"],
            )

        self.assertEqual(result.enqueued, 1)
        self.assertEqual(len(self.spool.list_pending()), 1)
        popen.assert_called_once()

    def test_hook_still_starts_recovery_drain_when_capture_fails(self):
        with (
            patch.object(self.capturer, "capture", side_effect=ContractError("bad")),
            patch("sherlock_collector.hook.subprocess.Popen") as popen,
            self.assertRaises(ContractError),
        ):
            capture_and_spawn_drain(
                self.capturer, [self.rollout], ["sherlock-collector", "drain"]
            )

        popen.assert_called_once()

    def test_append_does_not_advance_generation(self):
        first_source = b'{"type":"first"}\n'
        self.rollout.write_bytes(first_source)
        self.capturer.capture([self.rollout])
        with self.rollout.open("ab") as handle:
            handle.write(b'{"type":"second"}\n')

        self.capturer.capture([self.rollout])

        manifests = [
            self.spool.load(path).manifest for path in self.spool.list_pending()
        ]
        self.assertEqual({item.generation_seq for item in manifests}, {0})
        appended = max(manifests, key=lambda item: item.start_offset)
        self.assertEqual(appended.start_offset, len(first_source))

    def test_bounded_candidate_cursor_prevents_file_starvation(self):
        second = self.root / "second.jsonl"
        self.rollout.write_bytes(b'{"type":"first"}\n')
        second.write_bytes(b'{"type":"second"}\n')

        first_result = self.capturer.capture([self.rollout, second], max_files=1)
        second_result = self.capturer.capture([self.rollout, second], max_files=1)

        self.assertEqual(first_result.enqueued, 1)
        self.assertEqual(second_result.enqueued, 1)
        streams = {
            self.spool.load(path).manifest.source_stream_key
            for path in self.spool.list_pending()
        }
        self.assertEqual(len(streams), 2)

    def test_capture_preserves_caller_priority_before_cursor_rotation(self):
        prioritized = self.root / "z-prioritized.jsonl"
        fallback = self.root / "a-fallback.jsonl"
        prioritized.write_bytes(b'{"type":"prioritized"}\n')
        fallback.write_bytes(b'{"type":"fallback"}\n')

        result = self.capturer.capture(
            [prioritized, fallback],
            max_files=1,
            priority_count=1,
        )

        self.assertEqual(result.enqueued, 1)
        state = json.loads((self.root / "state" / "rollout-state.json").read_text())
        only = next(iter(state["streams"].values()))
        self.assertEqual(only["path"], str(prioritized.resolve()))

    def test_priority_is_preserved_after_backlog_cursor_advances(self):
        old = self.root / "old.jsonl"
        backlog = self.root / "backlog.jsonl"
        current = self.root / "current.jsonl"
        for path in (old, backlog, current):
            path.write_bytes(b'{"type":"event"}\n')
        self.capturer.capture([old, backlog], max_files=1)

        result = self.capturer.capture(
            [current, old, backlog],
            max_files=1,
            priority_count=1,
        )

        self.assertEqual(result.enqueued, 1)
        state = json.loads((self.root / "state" / "rollout-state.json").read_text())
        self.assertIn(
            str(current.resolve()),
            {value["path"] for value in state["streams"].values()},
        )

    def test_default_capture_advances_large_backlog_with_priority_and_fairness(self):
        current = self.root / "z-current.jsonl"
        backlog = [
            self.root / f"a-backlog-{index:02d}.jsonl"
            for index in range(DEFAULT_MAX_FILES + 1)
        ]
        record = b'{"type":"event","padding":"' + b"x" * (20 * 1024) + b'"}\n'
        for path in [current, *backlog]:
            path.write_bytes(record)
        capturer = RolloutCapturer(self.root / "catch-up-state", self.spool)

        first = capturer.capture([current, *backlog], priority_count=1)

        state_path = self.root / "catch-up-state" / "rollout-state.json"
        first_state = json.loads(state_path.read_text())
        first_paths = {
            value["path"] for value in first_state["streams"].values()
        }
        self.assertEqual(first.enqueued, DEFAULT_MAX_FILES)
        self.assertGreater(first.captured_bytes, 1024 * 1024)
        self.assertEqual(len(first_paths), DEFAULT_MAX_FILES)
        self.assertIn(str(current.resolve()), first_paths)

        second = capturer.capture([current, *backlog], priority_count=1)

        second_state = json.loads(state_path.read_text())
        second_paths = {
            value["path"] for value in second_state["streams"].values()
        }
        self.assertEqual(second.enqueued, 2)
        self.assertEqual(
            second_paths,
            {str(path.resolve()) for path in [current, *backlog]},
        )

    def test_configured_byte_limit_bounds_ordinary_records(self):
        record = b'{"type":"event"}\n'
        source = record * 10
        self.rollout.write_bytes(source)
        byte_limit = len(record) * 3

        result = self.capturer.capture(
            [self.rollout],
            max_sync_bytes=byte_limit,
        )

        self.assertEqual(result.captured_bytes, byte_limit)
        state = json.loads((self.root / "state" / "rollout-state.json").read_text())
        only = next(iter(state["streams"].values()))
        self.assertEqual(only["offset"], byte_limit)

    def test_best_effort_capture_does_not_let_bad_file_starve_good_file(self):
        bad = self.root / "bad.jsonl"
        good = self.root / "good.jsonl"
        bad.write_bytes(b"x" * 1025)
        good.write_bytes(b'{"type":"good"}\n')
        capturer = RolloutCapturer(
            self.root / "best-effort-state",
            self.spool,
            chunk_bytes=128,
            max_object_bytes=1024,
        )

        result = capturer.capture([bad, good], best_effort=True)

        self.assertEqual(result.errors, 1)
        self.assertEqual(result.enqueued, 1)
        state = json.loads(
            (self.root / "best-effort-state" / "rollout-state.json").read_text()
        )
        self.assertEqual(
            {value["path"] for value in state["streams"].values()},
            {str(good.resolve())},
        )

    def test_capture_splits_before_server_record_limit(self):
        self.rollout.write_bytes(b"{}\n" * 20_001)
        capturer = RolloutCapturer(
            self.root / "record-limit-state",
            self.spool,
            chunk_bytes=512 * 1024,
        )

        result = capturer.capture([self.rollout])

        self.assertEqual(result.enqueued, 2)
        manifests = [
            self.spool.load(path).manifest for path in self.spool.list_pending()
        ]
        self.assertEqual(sorted(item.record_count for item in manifests), [1, 20_000])

    def test_only_lf_delimits_jsonl_records(self):
        self.rollout.write_bytes(b"{}\r" * 20_001)

        result = self.capturer.capture([self.rollout])

        self.assertEqual(result.enqueued, 1)
        item = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(item.manifest.record_count, 1)

    def test_oversized_native_record_is_rejected_without_checkpointing(self):
        self.rollout.write_bytes(b"x" * 1025)
        capturer = RolloutCapturer(
            self.root / "oversized-state",
            self.spool,
            chunk_bytes=128,
            max_object_bytes=1024,
        )

        with self.assertRaisesRegex(ContractError, "native rollout record exceeds"):
            capturer.capture([self.rollout])

        self.assertEqual(self.spool.list_pending(), [])
        self.assertFalse(
            (self.root / "oversized-state" / "rollout-state.json").exists()
        )


if __name__ == "__main__":
    unittest.main()
