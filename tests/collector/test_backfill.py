from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import threading
import unittest
import uuid
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.backfill import (
    ARCHIVE_MANIFEST_PATH,
    BackfillError,
    discover_all_rollouts,
    export_archive,
    upload_archive,
)
from sherlock_collector.cli import _ProgressPrinter
from sherlock_collector.contract import (
    RECEIPT_VERSION,
    BatchManifest,
    build_rollout_batch,
    validate_stored_payload,
)
from sherlock_collector.drain import TransientUploadError
from sherlock_collector.http import (
    BULK_CONTENT_TYPE,
    BULK_MAGIC,
    BULK_RECEIPT_VERSION,
    HttpTransport,
    encode_bulk_request,
)
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool, SpoolItem


WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
PERSON_ID = "00000000-0000-4000-8000-000000000002"
COLLECTOR_KEY = "collector-backfill-test"
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "telemetry-collector" / "src"
EXPORT_SCRIPT = ROOT / "plugins" / "sherlock" / "scripts" / "export_history.py"
UPLOAD_SCRIPT = ROOT / "plugins" / "sherlock" / "scripts" / "upload_history.py"


def committed_receipt(manifest: BatchManifest) -> dict[str, object]:
    return {
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
            f"{manifest.start_offset}-{manifest.end_offset}-"
            f"{manifest.source_sha256}.jsonl.gz"
        ),
        "stored_byte_count": manifest.stored_byte_count,
        "stored_sha256": manifest.stored_sha256,
        "record_count": manifest.record_count,
        "contract_version": manifest.contract_version,
        "committed_at": "2026-08-15T00:00:00.000Z",
    }


class RecordingTransport:
    def __init__(self, transient_failures: int = 0):
        self.items = []
        self.transient_failures = transient_failures
        self.lock = threading.Lock()

    def upload(self, item):
        with self.lock:
            if self.transient_failures:
                self.transient_failures -= 1
                raise TransientUploadError("retry me")
            self.items.append(item)
        return committed_receipt(item.manifest)


class RecordingBulkTransport(RecordingTransport):
    max_batch_items = 32
    max_batch_request_bytes = 12 * 1024 * 1024
    max_batch_source_bytes = 20 * 1024 * 1024

    def __init__(self, transient_failures: int = 0):
        super().__init__(transient_failures)
        self.groups = []

    def upload_many(self, items):
        with self.lock:
            if self.transient_failures:
                self.transient_failures -= 1
                raise TransientUploadError("retry me")
            self.groups.append(tuple(item.manifest.spool_key for item in items))
            self.items.extend(items)
        return [committed_receipt(item.manifest) for item in items]


def read_manifest(archive: Path) -> dict[str, object]:
    with zipfile.ZipFile(archive) as handle:
        return json.loads(handle.read(ARCHIVE_MANIFEST_PATH))


def reconstructed_sessions(archive: Path) -> dict[tuple[str, str], bytes]:
    result = {}
    with zipfile.ZipFile(archive) as handle:
        top = json.loads(handle.read(ARCHIVE_MANIFEST_PATH))
        for session in top["sessions"]:
            source = bytearray()
            for key in session["batch_keys"]:
                prefix = f"batches/{key[:2]}/{key}"
                manifest = BatchManifest.from_dict(
                    json.loads(handle.read(f"{prefix}.manifest.json"))
                )
                source.extend(
                    validate_stored_payload(manifest, handle.read(f"{prefix}.jsonl.gz"))
                )
            result[(session["scope"], session["relative_path"])] = bytes(source)
    return result


def batch_members(archive: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(archive) as handle:
        return {
            item.filename: handle.read(item)
            for item in handle.infolist()
            if item.filename.startswith("batches/")
        }


class BackfillExportTests(unittest.TestCase):
    def test_export_contains_every_active_and_archived_rollout_exactly(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            active = (
                codex_home
                / "sessions"
                / "2026"
                / "08"
                / "15"
                / "rollout-2026-08-15T00-00-00-"
                "00000000-0000-4000-8000-000000000123.jsonl"
            )
            archived = codex_home / "archived_sessions" / "rollout-old.jsonl"
            ignored = codex_home / "sessions" / "notes.jsonl"
            active.parent.mkdir(parents=True)
            archived.parent.mkdir(parents=True)
            active_bytes = b"".join(
                json.dumps({"type": "event_msg", "payload": {"n": item}}).encode()
                + b"\n"
                for item in range(8)
            )
            archived_bytes = b'{"type":"session_meta"}\nunterminated-tail'
            active.write_bytes(active_bytes)
            archived.write_bytes(archived_bytes)
            ignored.write_text("not a rollout", encoding="utf-8")
            output = root / "history.zip"

            result = export_archive(codex_home, output, chunk_bytes=96)

            self.assertEqual(result.sessions, 2)
            self.assertGreater(result.batches, 2)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                reconstructed_sessions(output),
                {
                    (
                        "sessions",
                        "2026/08/15/" + active.name,
                    ): active_bytes,
                    ("archived_sessions", archived.name): archived_bytes,
                },
            )
            encoded_manifest = json.dumps(read_manifest(output))
            self.assertNotIn(str(root), encoded_manifest)
            observed = read_manifest(output)["sessions"][1][
                "observed_native_session_id"
            ]
            self.assertEqual(observed, "00000000-0000-4000-8000-000000000123")

    def test_discovery_rejects_symlinks_instead_of_silently_missing_history(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            sessions = codex_home / "sessions"
            sessions.mkdir(parents=True)
            rollout = sessions / "rollout-real.jsonl"
            rollout.write_text("{}\n", encoding="utf-8")
            (sessions / "other.jsonl").write_text("{}\n", encoding="utf-8")
            os.symlink(rollout, sessions / "rollout-link.jsonl")

            with self.assertRaisesRegex(BackfillError, "symlinked rollout"):
                discover_all_rollouts(codex_home)

    def test_export_refuses_to_replace_an_archive_without_force(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            (codex_home / "sessions").mkdir(parents=True)
            output = root / "history.zip"
            output.write_bytes(b"keep-me")

            with self.assertRaisesRegex(BackfillError, "already exists"):
                export_archive(codex_home, output)

            self.assertEqual(output.read_bytes(), b"keep-me")

    def test_parallel_compression_is_identical_to_single_worker_output(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = codex_home / "sessions" / "rollout-parallel.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_bytes(
                b"".join(
                    json.dumps({"type": "event", "value": "x" * 200}).encode()
                    + b"\n"
                    for _ in range(200)
                )
            )
            sequential = root / "sequential.zip"
            parallel = root / "parallel.zip"

            export_archive(codex_home, sequential, chunk_bytes=1_024, workers=1)
            export_archive(codex_home, parallel, chunk_bytes=1_024, workers=4)

            self.assertEqual(batch_members(sequential), batch_members(parallel))
            self.assertEqual(
                reconstructed_sessions(parallel),
                {("sessions", rollout.name): rollout.read_bytes()},
            )

    def test_export_rejects_unbounded_worker_count(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(BackfillError, "workers must be between"):
                export_archive(root, root / "history.zip", workers=33)

    def test_export_script_requires_acknowledgement_and_prints_json_summary(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = codex_home / "sessions" / "rollout-one.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_bytes(b'{"type":"event"}\n')
            output = root / "history.zip"
            environment = os.environ.copy()
            environment["SHERLOCK_COLLECTOR_SOURCE"] = str(SOURCE)
            command = [
                sys.executable,
                str(EXPORT_SCRIPT),
                "--codex-home",
                str(codex_home),
                "--output",
                str(output),
            ]

            refused = subprocess.run(
                command, capture_output=True, text=True, env=environment
            )
            self.assertEqual(refused.returncode, 64)
            self.assertFalse(output.exists())
            completed = subprocess.run(
                [*command, "--workers", "2", "--acknowledge-sensitive-data"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            summary = json.loads(completed.stdout)
            self.assertEqual(summary["sessions"], 1)
            self.assertEqual(summary["archive"], str(output.resolve()))

    def test_upload_script_has_operator_facing_help(self):
        completed = subprocess.run(
            [sys.executable, str(UPLOAD_SCRIPT), "--help"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("Verify and upload", completed.stdout)
        self.assertIn("--workers", completed.stdout)

    def test_export_reuses_live_generation_identity_after_append(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = codex_home / "sessions" / "rollout-live.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_bytes(b'{"type":"first"}\n')
            state_root = codex_home / "sherlock" / "telemetry"
            spool = DurableSpool(state_root / "queue")
            RolloutCapturer(state_root, spool).capture([rollout])
            live_manifest = spool.load(spool.list_pending()[0]).manifest
            with rollout.open("ab") as handle:
                handle.write(b'{"type":"second"}\n')
            output = root / "history.zip"

            export_archive(codex_home, output, state_root=state_root)

            session = read_manifest(output)["sessions"][0]
            self.assertEqual(session["generation_seq"], live_manifest.generation_seq)
            self.assertEqual(session["generation_key"], live_manifest.generation_key)

    def test_export_reuses_live_identity_after_codex_archives_a_rollout(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            active = codex_home / "sessions" / "rollout-live.jsonl"
            active.parent.mkdir(parents=True)
            active.write_bytes(b'{"type":"session_meta"}\n')
            state_root = codex_home / "sherlock" / "telemetry"
            spool = DurableSpool(state_root / "queue")
            RolloutCapturer(state_root, spool).capture([active])
            live_manifest = spool.load(spool.list_pending()[0]).manifest
            archived = codex_home / "archived_sessions" / active.name
            archived.parent.mkdir(parents=True)
            active.replace(archived)
            output = root / "history.zip"

            export_archive(codex_home, output, state_root=state_root)

            session = read_manifest(output)["sessions"][0]
            self.assertEqual(
                session["source_stream_key"], live_manifest.source_stream_key
            )
            self.assertEqual(session["generation_seq"], live_manifest.generation_seq)
            self.assertEqual(session["generation_key"], live_manifest.generation_key)

    def test_export_fragments_oversized_native_records_without_changing_bytes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = codex_home / "sessions" / "rollout-large.jsonl"
            rollout.parent.mkdir(parents=True)
            oversized = b'{"type":"event","data":"' + (b"x" * 2_500) + b'"}\n'
            original = b'{"type":"before"}\n' + oversized + b'{"type":"after"}\n'
            rollout.write_bytes(original)
            output = root / "history.zip"

            result = export_archive(
                codex_home,
                output,
                chunk_bytes=128,
                max_object_bytes=1_024,
            )

            self.assertGreater(result.batches, 3)
            self.assertEqual(
                reconstructed_sessions(output),
                {("sessions", rollout.name): original},
            )
            with zipfile.ZipFile(output) as archive:
                session = read_manifest(output)["sessions"][0]
                fragments = []
                for key in session["batch_keys"]:
                    prefix = f"batches/{key[:2]}/{key}"
                    manifest = BatchManifest.from_dict(
                        json.loads(archive.read(f"{prefix}.manifest.json"))
                    )
                    fragments.extend(
                        record
                        for record in manifest.records
                        if record.parse_status == "fragment"
                    )
            self.assertEqual([item.fragment_index for item in fragments], [0, 1, 2])
            self.assertEqual({item.fragment_count for item in fragments}, {3})
            self.assertEqual(
                {item.native_record_sha256 for item in fragments},
                {hashlib.sha256(oversized).hexdigest()},
            )


class BackfillUploadTests(unittest.TestCase):
    def make_archive(self, root: Path) -> Path:
        codex_home = root / "codex"
        for number in range(2):
            path = (
                codex_home
                / "sessions"
                / "2026"
                / "08"
                / "15"
                / f"rollout-{number}.jsonl"
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(
                b"".join(
                    json.dumps({"type": "event", "n": item}).encode() + b"\n"
                    for item in range(12)
                )
            )
        archive = root / "history.zip"
        export_archive(codex_home, archive, chunk_bytes=100)
        return archive

    def test_upload_retries_and_checkpoint_makes_second_run_a_noop(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.make_archive(root)
            first_transport = RecordingTransport(transient_failures=1)
            checkpoint_directory = root / "operator-state"
            checkpoint_directory.mkdir(mode=0o755)
            checkpoint = checkpoint_directory / "upload.json"

            first = upload_archive(
                archive,
                first_transport,
                workers=2,
                retries=1,
                state_path=checkpoint,
            )

            self.assertEqual(first.batches_uploaded, len(first_transport.items))
            self.assertGreater(first.batches_uploaded, 2)
            state = Path(first.state_path)
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            self.assertEqual(checkpoint_directory.stat().st_mode & 0o777, 0o755)
            second_transport = RecordingTransport()
            second = upload_archive(
                archive, second_transport, workers=2, state_path=checkpoint
            )
            self.assertEqual(second.batches_uploaded, 0)
            self.assertEqual(second.batches_skipped, first.batches_uploaded)
            self.assertEqual(second_transport.items, [])

    def test_upload_groups_batches_into_binary_bulk_requests(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.make_archive(root)
            transport = RecordingBulkTransport(transient_failures=1)

            result = upload_archive(
                archive,
                transport,
                workers=1,
                retries=1,
                resume=False,
            )

            self.assertEqual(result.batches_uploaded, len(transport.items))
            self.assertLess(len(transport.groups), result.batches_uploaded)
            self.assertTrue(any(len(group) > 1 for group in transport.groups))
            stream_by_key = {
                item.manifest.spool_key: item.manifest.source_stream_key
                for item in transport.items
            }
            self.assertTrue(
                any(
                    len({stream_by_key[key] for key in group}) > 1
                    for group in transport.groups
                )
            )
            encoded = encode_bulk_request(transport.items[:2])
            self.assertEqual(encoded[:8], BULK_MAGIC)
            self.assertEqual(int.from_bytes(encoded[8:12], "big"), 2)
            manifest_gzip_bytes = int.from_bytes(encoded[12:16], "big")
            manifest_bytes = int.from_bytes(encoded[16:20], "big")
            decoded_manifest = gzip.decompress(
                encoded[24 : 24 + manifest_gzip_bytes]
            )
            self.assertEqual(len(decoded_manifest), manifest_bytes)
            self.assertEqual(
                json.loads(decoded_manifest)["contract_version"],
                "sherlock.rollout-batch.v1",
            )
            self.assertNotIn(b"stored_payload_base64", encoded)

    def test_http_transport_reuses_https_connection_for_binary_requests(self):
        manifest, stored = build_rollout_batch(
            b'{"type":"event"}\n',
            source_stream_key="stream",
            generation_key="generation",
            generation_seq=0,
            start_offset=0,
        )
        item = SpoolItem(manifest, stored, {})

        class Response:
            status = 200

            def read(self, _maximum):
                return json.dumps(
                    {
                        "receipt_version": BULK_RECEIPT_VERSION,
                        "receipts": [{"ok": True}],
                    }
                ).encode()

            def getheader(self, _name, default=""):
                return default

        class Connection:
            def __init__(self):
                self.requests = []

            def request(self, method, target, *, body, headers):
                self.requests.append((method, target, body, headers))

            def getresponse(self):
                return Response()

            def close(self):
                pass

        connection = Connection()
        with patch(
            "sherlock_collector.http.http.client.HTTPSConnection",
            return_value=connection,
        ) as constructor:
            transport = HttpTransport(
                "https://project.supabase.co/functions/v1/ingest", "secret"
            )
            transport.upload(item)
            transport.upload(item)

        constructor.assert_called_once()
        self.assertEqual(len(connection.requests), 2)
        self.assertTrue(connection.requests[0][2].startswith(BULK_MAGIC))
        self.assertEqual(
            connection.requests[0][3]["Content-Type"], BULK_CONTENT_TYPE
        )

    def test_terminal_upload_progress_renders_one_in_place_bar(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True

        terminal = Terminal()
        progress = _ProgressPrinter("Uploading")
        with patch("sherlock_collector.cli.sys.stderr", terminal):
            progress(1, 2, "sessions/rollout-one.jsonl")
            progress(2, 2, "sessions/rollout-two.jsonl")

        rendered = terminal.getvalue()
        self.assertIn("\rUploading [", rendered)
        self.assertIn("2/2 100.0%", rendered)
        self.assertTrue(rendered.endswith("\n"))

    def test_corrupt_payload_is_rejected_before_transport(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = codex_home / "sessions" / "rollout-only.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_bytes(b'{"type":"event"}\n')
            original = root / "history.zip"
            export_archive(codex_home, original)
            corrupted = root / "corrupted.zip"
            with (
                zipfile.ZipFile(original) as source,
                zipfile.ZipFile(corrupted, "w") as destination,
            ):
                payload_changed = False
                for info in source.infolist():
                    data = source.read(info)
                    if not payload_changed and info.filename.endswith(".jsonl.gz"):
                        data = data[:-1] + bytes([data[-1] ^ 0xFF])
                        payload_changed = True
                    destination.writestr(info, data)
            transport = RecordingTransport()

            with self.assertRaisesRegex(BackfillError, "invalid batch payload"):
                upload_archive(corrupted, transport, workers=1, resume=False)

            self.assertEqual(transport.items, [])


if __name__ == "__main__":
    unittest.main()
