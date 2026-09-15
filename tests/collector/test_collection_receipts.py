from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.collection_receipt import (
    COLLECTION_RECEIPT_VERSION,
    record_token_payload,
    scan_token_payload,
    scan_token_records,
)
from sherlock_collector.contract import (
    FRAGMENT_BYTES,
    MAX_SOURCE_BYTES,
    RECEIPT_FIELDS,
    RECEIPT_VERSION,
    ContractError,
    build_rollout_batch,
    build_source_batch,
)
from sherlock_collector.drain import Drain, TransientUploadError
from sherlock_collector.spool import DurableSpool


WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
PERSON_ID = "00000000-0000-4000-8000-000000000002"
COLLECTOR_KEY = "collector-receipt-test"


def committed_receipt(manifest, **overrides):
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
            f"workspaces/{WORKSPACE_ID}/collectors/{COLLECTOR_KEY}/"
            f"{manifest.source_kind}/{manifest.source_stream_key}/generations/"
            f"{manifest.generation_seq}-{manifest.generation_key}/"
            f"{manifest.start_offset}-{manifest.end_offset}-"
            f"{manifest.source_sha256}.jsonl.gz"
        ),
        "stored_byte_count": manifest.stored_byte_count,
        "stored_sha256": manifest.stored_sha256,
        "record_count": manifest.record_count,
        "contract_version": manifest.contract_version,
        "committed_at": "2026-09-15T00:00:00.000Z",
    }
    value.update(overrides)
    return value


def codex_batch(source: bytes, *, native_session_id: str = "native-session-1"):
    return build_rollout_batch(
        source,
        source_stream_key="receipt-stream",
        generation_key="receipt-generation",
        generation_seq=0,
        start_offset=40,
        observed_native_session_id=native_session_id,
        collector_version="0.1.0",
    )


def claude_batch(source: bytes):
    return build_source_batch(
        source,
        source_provider="claude_code",
        source_kind="transcript",
        source_stream_key="claude-receipt-stream",
        generation_key="claude-receipt-generation",
        generation_seq=0,
        start_offset=0,
        observed_native_session_id="claude-native-session",
    )


class CollectionReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.spool = DurableSpool(self.root / "queue")

    def tearDown(self):
        self.temporary.cleanup()

    def test_success_persists_validated_receipt_before_acknowledging_raw_spool(self):
        source = (
            b'{"type":"event_msg","payload":{"type":"token_count","info":'
            b'{"total_token_usage":{"input_tokens":7}}}}\n'
        )
        manifest, stored = codex_batch(source)
        pending = self.spool.enqueue(manifest, stored)
        queued_before = pending.read_bytes()
        uploaded = []
        order = []
        self.assertNotIn("token_payload", self.spool.load(pending).metadata)

        class Success:
            def upload(inner_self, item):
                order.append("upload")
                uploaded.append(item)
                return committed_receipt(item.manifest)

        original_acknowledge = self.spool.acknowledge

        def assert_receipt_precedes_delete(path):
            order.append("acknowledge")
            self.assertTrue(path.exists())
            self.assertEqual(len(self.spool.list_collection_receipts()), 1)
            original_acknowledge(path)

        def inspect_before_upload(item_manifest, item_payload):
            order.append("scan")
            return scan_token_payload(item_manifest, item_payload)

        with (
            patch(
                "sherlock_collector.drain.scan_token_payload",
                side_effect=inspect_before_upload,
            ),
            patch.object(
                self.spool,
                "acknowledge",
                side_effect=assert_receipt_precedes_delete,
            ),
        ):
            result = Drain(self.spool, Success()).run()

        self.assertEqual(result.uploaded, 1)
        self.assertEqual(order, ["scan", "upload", "acknowledge"])
        self.assertEqual(self.spool.list_pending(), [])
        self.assertEqual(len(uploaded), 1)
        self.assertEqual(uploaded[0].stored_payload, stored)
        self.assertEqual(uploaded[0].manifest, manifest)
        self.assertEqual(json.loads(queued_before)["stored_payload_base64"],
                         uploaded[0].to_dict()["stored_payload_base64"])

        paths = self.spool.list_collection_receipts()
        self.assertEqual(len(paths), 1)
        value = self.spool.load_collection_receipt(paths[0])
        self.assertEqual(value["collection_receipt_version"],
                         COLLECTION_RECEIPT_VERSION)
        self.assertEqual(set(value["server_receipt"]), RECEIPT_FIELDS)
        self.assertEqual(value["source"], manifest.to_dict())
        self.assertEqual(
            value["token_payload"],
            {
                "presence": "present",
                "scanned_complete_records": 1,
                "uninspectable_records": 0,
                "record_count": 1,
                "token_count_records": 1,
                "token_payload_records": 1,
                "scope": {
                    "start_offset": manifest.start_offset,
                    "end_offset": manifest.end_offset,
                    "source_sha256": manifest.source_sha256,
                },
            },
        )
        receipt_text = paths[0].read_text(encoding="utf-8")
        self.assertNotIn("input_tokens", receipt_text)
        self.assertNotIn("total_token_usage", receipt_text)
        self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.spool.receipts.stat().st_mode & 0o777, 0o700)

    def test_token_marker_without_payload_is_absent_only_for_complete_range(self):
        source = (
            b'{"type":"event_msg","payload":{"type":"token_count","info":null}}\n'
            b'{"type":"event_msg","payload":{"type":"turn_complete"}}\n'
        )
        manifest, stored = codex_batch(source)

        observation = scan_token_payload(manifest, stored)

        self.assertEqual(observation["presence"], "absent")
        self.assertEqual(observation["scanned_complete_records"], 2)
        self.assertEqual(observation["uninspectable_records"], 0)
        self.assertEqual(observation["token_count_records"], 1)
        self.assertEqual(observation["token_payload_records"], 0)
        self.assertEqual(
            observation["scope"],
            {
                "start_offset": manifest.start_offset,
                "end_offset": manifest.end_offset,
                "source_sha256": manifest.source_sha256,
            },
        )

    def test_nonempty_codex_and_claude_usage_objects_are_presence_not_totals(self):
        scope = {
            "start_offset": 0,
            "end_offset": 100,
            "source_sha256": "a" * 64,
        }
        codex = scan_token_records(
            [{
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {"last_token_usage": {"future_field": "opaque"}},
                },
            }],
            source_provider="codex",
            source_kind="rollout",
            scope=scope,
        )
        claude = scan_token_records(
            [{
                "type": "assistant",
                "message": {"usage": {"future_field": "opaque"}},
            }],
            source_provider="claude_code",
            source_kind="transcript",
            scope=scope,
        )
        empty = scan_token_records(
            [{
                "type": "assistant",
                "message": {"usage": {}},
            }],
            source_provider="claude_code",
            source_kind="transcript",
            scope=scope,
        )

        self.assertEqual(codex["presence"], "present")
        self.assertEqual(codex["token_count_records"], 1)
        self.assertEqual(claude["presence"], "present")
        self.assertEqual(empty["presence"], "absent")
        self.assertIs(
            record_token_payload(
                {"type": "assistant", "message": {"usage": {"opaque": True}}},
                "claude_code",
            ),
            True,
        )
        self.assertIs(record_token_payload({}, "codex"), False)
        self.assertIsNone(record_token_payload({}, "future-provider"))

    def test_malformed_and_fragmented_records_never_claim_absence(self):
        malformed_manifest, malformed_stored = codex_batch(b"{not-json}\n")
        malformed = scan_token_payload(malformed_manifest, malformed_stored)

        fragment_source = b"x" * FRAGMENT_BYTES
        fragment_manifest, fragment_stored = build_rollout_batch(
            fragment_source,
            source_stream_key="fragment-stream",
            generation_key="fragment-generation",
            generation_seq=0,
            start_offset=0,
            native_record_fragment={
                "native_record_start_offset": 0,
                "native_record_end_offset": MAX_SOURCE_BYTES + 1,
                "native_record_sha256": "f" * 64,
                "fragment_index": 0,
                "fragment_count": 5,
            },
        )
        fragment = scan_token_payload(fragment_manifest, fragment_stored)

        self.assertEqual(malformed["presence"], "unknown")
        self.assertEqual(malformed["scanned_complete_records"], 0)
        self.assertEqual(malformed["uninspectable_records"], 1)
        self.assertEqual(fragment["presence"], "unknown")
        self.assertEqual(fragment["scanned_complete_records"], 0)
        self.assertEqual(fragment["uninspectable_records"], 1)

    def test_mismatched_or_failed_upload_never_writes_committed_receipt(self):
        manifest, stored = codex_batch(b'{"type":"event_msg"}\n')

        class Mismatch:
            def upload(inner_self, item):
                return committed_receipt(item.manifest, source_sha256="0" * 64)

        self.spool.enqueue(manifest, stored)
        mismatch = Drain(self.spool, Mismatch()).run()
        self.assertEqual(mismatch.requeued, 1)
        self.assertEqual(self.spool.list_collection_receipts(), [])

        class Failed:
            def upload(inner_self, _item):
                raise TransientUploadError("offline")

        failed = Drain(self.spool, Failed()).run()
        self.assertEqual(failed.requeued, 1)
        self.assertEqual(self.spool.list_collection_receipts(), [])

    def test_success_preserves_unrelated_same_name_dead_letter_raw_bytes(self):
        manifest, stored = codex_batch(b'{"type":"event_msg"}\n')
        pending = self.spool.enqueue(manifest, stored)
        historical = self.spool.dead_letter / pending.name
        historical_bytes = b"historical-corrupt-raw-artifact"
        historical.write_bytes(historical_bytes)

        class Success:
            def upload(inner_self, item):
                return committed_receipt(item.manifest)

        result = Drain(self.spool, Success()).run()

        self.assertEqual(result.uploaded, 1)
        self.assertEqual(historical.read_bytes(), historical_bytes)

    def test_existing_receipt_conflict_requeues_instead_of_discarding_fresh_evidence(self):
        source = (
            b'{"type":"event_msg","payload":{"type":"token_count","info":'
            b'{"total_token_usage":{"opaque":true}}}}\n'
        )
        manifest, stored = codex_batch(source)
        pending = self.spool.enqueue(manifest, stored)
        item = self.spool.load(pending)
        server_receipt = committed_receipt(manifest)
        stale_absence = {
            "presence": "absent",
            "scanned_complete_records": 1,
            "uninspectable_records": 0,
            "record_count": 1,
            "token_count_records": 1,
            "token_payload_records": 0,
            "scope": {
                "start_offset": manifest.start_offset,
                "end_offset": manifest.end_offset,
                "source_sha256": manifest.source_sha256,
            },
        }
        self.spool.record_collection_receipt(item, server_receipt, stale_absence)

        class SameCommit:
            def upload(inner_self, _item):
                return server_receipt

        result = Drain(self.spool, SameCommit()).run()

        self.assertEqual(result.uploaded, 0)
        self.assertEqual(result.requeued, 1)
        self.assertEqual(len(self.spool.list_pending()), 1)
        persisted = self.spool.load_collection_receipt(
            self.spool.list_collection_receipts()[0]
        )
        self.assertEqual(persisted["token_payload"]["presence"], "absent")

    def test_loader_rejects_provider_impossible_token_evidence(self):
        codex_manifest, codex_stored = codex_batch(b'{"type":"event_msg"}\n')
        codex_item_path = self.spool.enqueue(codex_manifest, codex_stored)
        codex_item = self.spool.load(codex_item_path)
        codex_scan = scan_token_payload(codex_manifest, codex_stored)
        codex_scan["presence"] = "present"
        codex_scan["token_payload_records"] = 1
        with self.assertRaisesRegex(ContractError, "requires a token marker"):
            self.spool.record_collection_receipt(
                codex_item,
                committed_receipt(codex_manifest),
                codex_scan,
            )

        claude_source = (
            b'{"type":"assistant","message":{"usage":{"opaque":true}}}\n'
        )
        claude_manifest, claude_stored = claude_batch(claude_source)
        claude_path = self.spool.enqueue(claude_manifest, claude_stored)
        claude_item = self.spool.load(claude_path)
        claude_scan = scan_token_payload(claude_manifest, claude_stored)
        claude_scan["token_count_records"] = 1
        with self.assertRaisesRegex(ContractError, "unsupported for this source kind"):
            self.spool.record_collection_receipt(
                claude_item,
                committed_receipt(claude_manifest),
                claude_scan,
            )

    def test_loader_normalizes_malformed_nested_values_to_contract_error(self):
        manifest, stored = codex_batch(b'{"type":"event_msg"}\n')
        pending = self.spool.enqueue(manifest, stored)
        item = self.spool.load(pending)
        path = self.spool.record_collection_receipt(
            item,
            committed_receipt(manifest),
            scan_token_payload(manifest, stored),
        )
        malformed = json.loads(path.read_text(encoding="utf-8"))
        malformed["token_payload"]["presence"] = []
        path.write_text(json.dumps(malformed), encoding="utf-8")

        with self.assertRaisesRegex(ContractError, "presence is unsupported"):
            self.spool.load_collection_receipt(path)

    def test_local_receipt_write_failure_requeues_unchanged_artifact(self):
        source = b'{"type":"event_msg"}\n'
        manifest, stored = codex_batch(source)
        self.spool.enqueue(manifest, stored)

        class Success:
            def upload(inner_self, item):
                return committed_receipt(item.manifest)

        synced_directories = []
        with (
            patch(
                "sherlock_collector.spool._fsync_directory",
                side_effect=synced_directories.append,
            ),
            patch.object(
                self.spool,
                "record_collection_receipt",
                side_effect=OSError("disk full"),
            ),
        ):
            result = Drain(self.spool, Success()).run()

        self.assertEqual(result.uploaded, 0)
        self.assertEqual(result.requeued, 1)
        self.assertEqual(self.spool.list_collection_receipts(), [])
        pending = self.spool.list_pending()
        self.assertEqual(len(pending), 1)
        item = self.spool.load(pending[0])
        self.assertEqual(item.manifest, manifest)
        self.assertEqual(item.stored_payload, stored)
        self.assertIn("disk full", item.metadata["last_upload_error"])
        self.assertGreaterEqual(synced_directories.count(self.spool.pending), 2)
        self.assertGreaterEqual(synced_directories.count(self.spool.processing), 2)


if __name__ == "__main__":
    unittest.main()
