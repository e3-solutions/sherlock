from __future__ import annotations

import contextlib
import gzip
import json
import os
import subprocess
import sys
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

from sherlock_collector.contract import build_rollout_batch
from sherlock_collector.config import ConfigurationError, _read_owner_only
from sherlock_collector.platform import (
    is_owner_only,
    secure_path,
)
from sherlock_collector.rollout import (
    RolloutCapturer,
    StreamState,
    open_regular_under_root,
)
from sherlock_collector.spool import DurableSpool, _atomic_json


PACKAGE_SRC = Path(__file__).parents[2] / "packages" / "telemetry-collector" / "src"


def child_environment() -> dict[str, str]:
    environment = dict(os.environ)
    existing = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = str(PACKAGE_SRC) + (
        os.pathsep + existing if existing else ""
    )
    return environment


class ReceiptServer:
    def __init__(self, *, block_first: bool = False):
        self.started = threading.Event()
        self.release = threading.Event()
        self.requests: list[dict[str, object]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                request = json.loads(self.rfile.read(length))
                outer.requests.append(request)
                outer.started.set()
                if block_first and len(outer.requests) == 1:
                    outer.release.wait(10)
                manifest = request["manifest"]
                workspace = "00000000-0000-4000-8000-000000000001"
                person = "00000000-0000-4000-8000-000000000002"
                collector = "portable-test"
                echoed = {
                    key: manifest[key]
                    for key in (
                        "source_kind",
                        "source_stream_key",
                        "generation_key",
                        "generation_seq",
                        "start_offset",
                        "end_offset",
                        "source_byte_count",
                        "source_sha256",
                        "stored_byte_count",
                        "stored_sha256",
                        "record_count",
                        "contract_version",
                    )
                }
                receipt = {
                    **echoed,
                    "receipt_version": "sherlock.committed-receipt.v1",
                    "status": "committed",
                    "batch_id": str(uuid.uuid4()),
                    "workspace_id": workspace,
                    "person_id": person,
                    "collector_key": collector,
                    "storage_path": (
                        f"workspaces/{workspace}/collectors/{collector}/"
                        f"{manifest['source_kind']}/{manifest['source_stream_key']}/generations/"
                        f"{manifest['generation_seq']}-{manifest['generation_key']}/"
                        f"{manifest['start_offset']}-{manifest['end_offset']}-"
                        f"{manifest['source_sha256']}.jsonl.gz"
                    ),
                    "committed_at": "2026-09-12T00:00:00Z",
                }
                encoded = json.dumps(receipt).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/ingest"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class PortableRuntimeTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "native Windows ACL boundary")
    def test_windows_acl_round_trip_is_owner_only(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary) / "collector"
            directory.mkdir()
            secure_path(directory, directory=True)
            path = directory / "collector.json"
            path.write_text("{}")
            # The inherited DACL is safe but not yet pinned/protected as required
            # for identity-bearing configuration.
            self.assertFalse(is_owner_only(path))
            secure_path(path, directory=False)
            self.assertTrue(is_owner_only(path), "Expected protected owner/SYSTEM permissions")

    @unittest.skipUnless(os.name == "nt", "native Windows ACL boundary")
    def test_windows_everyone_read_acl_is_rejected_for_config(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "collector.json"
            path.write_text("{}")
            secure_path(path, directory=False)
            granted = subprocess.run(
                ["icacls", str(path), "/grant", "*S-1-1-0:R"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(granted.returncode, 0, granted.stderr)
            self.assertFalse(is_owner_only(path), "Everyone read access must be rejected")
            with self.assertRaisesRegex(ConfigurationError, "owner-only"):
                _read_owner_only(path)

    @unittest.skipUnless(os.name == "nt", "native Windows junction boundary")
    def test_windows_directory_junction_outside_root_is_rejected(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            allowed = base / "allowed"
            outside = base / "outside"
            allowed.mkdir()
            outside.mkdir()
            source = outside / "rollout.jsonl"
            source.write_text('{"type":"event"}\n')
            junction = allowed / "escape"
            created = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            with self.assertRaisesRegex(ValueError, "outside allowed_root"):
                open_regular_under_root(allowed, junction / source.name)

    @unittest.skipUnless(os.name == "nt", "native Windows replacement boundary")
    def test_windows_failed_replace_leaves_valid_original(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            _atomic_json(path, {"generation": "original"})
            with path.open("rb"):
                with self.assertRaises(OSError):
                    _atomic_json(path, {"generation": "replacement"})
            self.assertEqual(json.loads(path.read_text()), {"generation": "original"})

    def test_cli_imports_in_a_fresh_interpreter(self):
        completed = subprocess.run(
            [sys.executable, "-c", "import sherlock_collector.cli"],
            env=child_environment(),
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_real_process_lock_excludes_then_recovers_after_killed_owner(self):
        with TemporaryDirectory() as temporary:
            lock_path = Path(temporary) / "collector.lock"
            program = (
                "import sys,time\n"
                "from pathlib import Path\n"
                "from sherlock_collector.platform import nonblocking_lock\n"
                "with nonblocking_lock(Path(sys.argv[1])) as acquired:\n"
                " print('acquired' if acquired else 'busy', flush=True)\n"
                " time.sleep(30) if acquired else None\n"
            )
            owner = subprocess.Popen(
                [sys.executable, "-c", program, str(lock_path)],
                env=child_environment(),
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(owner.stdout.readline().strip(), "acquired")
                contender = subprocess.run(
                    [sys.executable, "-c", program, str(lock_path)],
                    env=child_environment(),
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(contender.stdout.strip(), "busy")
                owner.kill()
                owner.wait(timeout=5)
                recovered = subprocess.Popen(
                    [sys.executable, "-c", program, str(lock_path)],
                    env=child_environment(),
                    stdout=subprocess.PIPE,
                    text=True,
                )
                try:
                    self.assertEqual(recovered.stdout.readline().strip(), "acquired")
                finally:
                    recovered.kill()
                    recovered.wait(timeout=5)
                    if recovered.stdout is not None:
                        recovered.stdout.close()
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                if owner.stdout is not None:
                    owner.stdout.close()

    def test_claim_crash_recovery_retains_exact_source_bytes(self):
        with TemporaryDirectory() as temporary:
            queue = Path(temporary) / "queue"
            source = b'{"type":"event","text":"raw \\u2603 bytes"}\n'
            manifest, stored = build_rollout_batch(
                source,
                source_stream_key="stream",
                generation_key="generation",
                generation_seq=0,
                start_offset=0,
            )
            pending = DurableSpool(queue).enqueue(manifest, stored)
            program = (
                "import os,sys\nfrom pathlib import Path\n"
                "from sherlock_collector.spool import DurableSpool\n"
                "spool=DurableSpool(Path(sys.argv[1])); spool.claim(Path(sys.argv[2])); os._exit(23)"
            )
            crashed = subprocess.run(
                [sys.executable, "-c", program, str(queue), str(pending)],
                env=child_environment(),
                timeout=10,
            )
            self.assertEqual(crashed.returncode, 23)
            spool = DurableSpool(queue)
            self.assertEqual(spool.recover_processing(), 1)
            recovered = spool.load(spool.list_pending()[0])
            self.assertEqual(recovered.stored_payload, stored)
            self.assertEqual(gzip.decompress(recovered.stored_payload), source)

    def test_actual_drains_exclude_competitor_and_upload_once(self):
        with TemporaryDirectory() as temporary, ReceiptServer(
            block_first=True
        ) as server:
            queue = Path(temporary) / "queue"
            manifest, stored = build_rollout_batch(
                b'{"type":"event"}\n',
                source_stream_key="stream",
                generation_key="generation",
                generation_seq=0,
                start_offset=0,
            )
            DurableSpool(queue).enqueue(manifest, stored)
            program = (
                "import sys\nfrom pathlib import Path\n"
                "from sherlock_collector.config import CollectorIdentity\n"
                "from sherlock_collector.drain import Drain\n"
                "from sherlock_collector.http import HttpTransport\n"
                "from sherlock_collector.spool import DurableSpool\n"
                "identity=CollectorIdentity('Test','test','test@e3group.ai',"
                "'00000000-0000-4000-8000-000000000004')\n"
                "result=Drain(DurableSpool(Path(sys.argv[1])),HttpTransport(sys.argv[2],identity)).run()\n"
                "print('locked' if result.locked else 'done')\n"
                "raise SystemExit(75 if result.locked else 0)"
            )
            owner = subprocess.Popen(
                [sys.executable, "-c", program, str(queue), server.endpoint],
                env=child_environment(),
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertTrue(server.started.wait(5))
                contender = subprocess.run(
                    [sys.executable, "-c", program, str(queue), server.endpoint],
                    env=child_environment(),
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(contender.returncode, 75, contender.stderr)
                self.assertEqual(contender.stdout.strip(), "locked")
                server.release.set()
                self.assertEqual(owner.wait(timeout=5), 0)
                self.assertEqual(owner.stdout.read().strip(), "done")
            finally:
                server.release.set()
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                if owner.stdout is not None:
                    owner.stdout.close()
            self.assertEqual(len(server.requests), 1)
            remaining = DurableSpool(queue).list_pending()
            self.assertEqual(
                remaining,
                [],
                DurableSpool(queue).load(remaining[0]).metadata if remaining else None,
            )

    def test_killed_actual_drain_recovers_processing_and_source_bytes(self):
        with TemporaryDirectory() as temporary, ReceiptServer(
            block_first=True
        ) as server:
            queue = Path(temporary) / "queue"
            source = b'{"type":"event","durable":true}\n'
            manifest, stored = build_rollout_batch(
                source,
                source_stream_key="stream",
                generation_key="generation",
                generation_seq=0,
                start_offset=0,
            )
            DurableSpool(queue).enqueue(manifest, stored)
            program = (
                "import sys\nfrom pathlib import Path\n"
                "from sherlock_collector.config import CollectorIdentity\n"
                "from sherlock_collector.drain import Drain\n"
                "from sherlock_collector.http import HttpTransport\n"
                "from sherlock_collector.spool import DurableSpool\n"
                "i=CollectorIdentity('Test','test','test@e3group.ai','00000000-0000-4000-8000-000000000004')\n"
                "r=Drain(DurableSpool(Path(sys.argv[1])),HttpTransport(sys.argv[2],i)).run()\n"
                "print(r.uploaded)"
            )
            owner = subprocess.Popen(
                [sys.executable, "-c", program, str(queue), server.endpoint],
                env=child_environment(),
                stdout=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(server.started.wait(5))
            owner.kill()
            owner.wait(timeout=5)
            owner.stdout.close()
            server.release.set()
            recovered = subprocess.run(
                [sys.executable, "-c", program, str(queue), server.endpoint],
                env=child_environment(),
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            self.assertEqual(recovered.stdout.strip(), "1")
            self.assertEqual(DurableSpool(queue).list_pending(), [])
            payloads = [request["stored_payload_base64"] for request in server.requests]
            self.assertEqual(len(set(payloads)), 1)

    def test_requeue_and_ack_keep_payload_until_ack(self):
        with TemporaryDirectory() as temporary:
            spool = DurableSpool(Path(temporary) / "queue")
            source = b'{"type":"event","value":1}\n'
            manifest, stored = build_rollout_batch(
                source,
                source_stream_key="stream",
                generation_key="generation",
                generation_seq=0,
                start_offset=0,
            )
            claimed = spool.claim(spool.enqueue(manifest, stored))
            item = spool.load(claimed)
            spool.requeue(claimed, item, RuntimeError("offline"))
            pending = spool.list_pending()[0]
            self.assertEqual(spool.load(pending).stored_payload, stored)
            claimed = spool.claim(pending)
            spool.acknowledge(claimed)
            self.assertEqual(list(spool.processing.glob("*.json")), [])

    def test_generation_comparison_uses_explicit_identity_when_inode_is_zero(self):
        class ZeroInode:
            st_size = 100
            st_dev = 0
            st_ino = 0

        state = StreamState("source", 9, 41, 4, "prefix", 0, "key", 10)
        self.assertTrue(
            RolloutCapturer._same_generation(
                state, Path("source"), ZeroInode(), 4, "prefix", 9, 41
            )
        )
        self.assertFalse(
            RolloutCapturer._same_generation(
                state, Path("source"), ZeroInode(), 4, "prefix", 9, 42
            )
        )

    def test_append_then_same_size_replacement_creates_new_exact_generation(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_path = root / "sessions" / "rollout.jsonl"
            source_path.parent.mkdir()
            first = b'{"type":"first"}\n'
            appended = b'{"type":"append"}\n'
            replacement_line = b'{"type":"other"}\n'
            replacement_bytes = (
                replacement_line.rstrip(b"\n")
                + b" " * (len(first + appended) - len(replacement_line))
                + b"\n"
            )
            source_path.write_bytes(first)
            spool = DurableSpool(root / "queue")
            capturer = RolloutCapturer(
                root / "state", spool, allowed_root=source_path.parent
            )
            self.assertEqual(capturer.capture([source_path]).enqueued, 1)
            with source_path.open("ab") as handle:
                handle.write(appended)
                handle.flush()
                os.fsync(handle.fileno())
            self.assertEqual(capturer.capture([source_path]).enqueued, 1)
            replacement = source_path.with_name("replacement.jsonl")
            replacement.write_bytes(replacement_bytes)
            os.replace(replacement, source_path)
            self.assertEqual(capturer.capture([source_path]).enqueued, 1)
            items = [spool.load(path) for path in spool.list_pending()]
            self.assertEqual(
                sorted(item.manifest.generation_seq for item in items), [0, 0, 1]
            )
            generation_zero = b"".join(
                gzip.decompress(item.stored_payload)
                for item in sorted(
                    (item for item in items if item.manifest.generation_seq == 0),
                    key=lambda item: item.manifest.start_offset,
                )
            )
            generation_one = b"".join(
                gzip.decompress(item.stored_payload)
                for item in items
                if item.manifest.generation_seq == 1
            )
            self.assertEqual(generation_zero, first + appended)
            self.assertEqual(generation_one, replacement_bytes)

    def test_hook_process_exits_before_detached_http_drain_completes(self):
        with TemporaryDirectory() as temporary, ReceiptServer(
            block_first=True
        ) as server:
            root = Path(temporary)
            codex_home = root / "codex"
            rollout = (
                codex_home
                / "sessions"
                / "2026"
                / "09"
                / "12"
                / (
                    "rollout-2026-09-12T00-00-00-00000000-0000-4000-8000-000000000007.jsonl"
                )
            )
            rollout.parent.mkdir(parents=True)
            rollout.write_bytes(
                b'{"type":"event","timestamp":"2026-09-12T00:00:00Z"}\n'
            )
            state_root = root / "state"
            config = root / "collector.json"
            config.write_text(
                json.dumps(
                    {
                        "endpoint": server.endpoint,
                        "name": "Portable Test",
                        "github_id": "portable-test",
                        "email": "portable@e3group.ai",
                        "installation_id": "00000000-0000-4000-8000-000000000004",
                    }
                )
            )
            secure_path(config, directory=False)
            hook = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sherlock_collector.cli",
                    "--codex-home",
                    str(codex_home),
                    "--state-root",
                    str(state_root),
                    "--config",
                    str(config),
                    "hook",
                    "Stop",
                ],
                input=json.dumps({"transcript_path": str(rollout)}),
                env=child_environment(),
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(hook.returncode, 0, hook.stderr)
            self.assertTrue(
                server.started.wait(5),
                f"stdout={hook.stdout!r} stderr={hook.stderr!r} "
                f"pending={list((state_root / 'queue' / 'pending').glob('*.json'))}",
            )
            self.assertTrue(list((state_root / "queue" / "processing").glob("*.json")))
            server.release.set()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if not list((state_root / "queue" / "processing").glob("*.json")):
                    break
                time.sleep(0.05)
            self.assertEqual(
                list((state_root / "queue" / "pending").glob("*.json")), []
            )
            self.assertEqual(
                list((state_root / "queue" / "processing").glob("*.json")), []
            )
            self.assertGreaterEqual(len(server.requests), 1)


if __name__ == "__main__":
    unittest.main()
