from __future__ import annotations

import contextlib
import gzip
import io
import json
import subprocess
import unittest
import urllib.error
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.cli import main
from sherlock_collector.config import CollectorConfig, CollectorIdentity
from sherlock_collector.contract import BatchManifest, ContractError, build_source_batch
from sherlock_collector.drain import Drain, TransientUploadError
from sherlock_collector.http import HttpTransport
from sherlock_collector.pr_context import (
    enqueue_context, validate_session, create_pull_request,
)
from sherlock_collector.spool import DurableSpool
from test_collector import receipt

SESSION = "00000000-0000-4000-8000-000000000004"
OTHER = "00000000-0000-4000-8000-000000000005"
EVENT = "00000000-0000-4000-8000-000000000006"
CONFIG = CollectorConfig("http://127.0.0.1:54321/functions/v1/telemetry-ingest",
    CollectorIdentity("Test", "test", "test@e3group.ai", "00000000-0000-4000-8000-000000000002"))


class PRContextTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def enqueue(self, **kwargs):
        defaults = dict(state_root=self.root / "state", configuration=CONFIG,
            provider="codex", session_id=SESSION, operation="link", event_id=EVENT,
            repository="Owner/Repo", pr_number=91)
        defaults.update(kwargs)
        return enqueue_context(**defaults)

    def test_both_providers_exact_identity_and_original_bytes(self):
        for provider in ("codex", "claude_code"):
            with self.subTest(provider=provider):
                result = self.enqueue(provider=provider, event_id=str(uuid.uuid4()))
                raw = Path(result["sidecar"]).read_bytes()
                event = json.loads(raw)
                self.assertEqual(event["native_session_id"], SESSION)
                self.assertEqual(event["provider"], provider)
                self.assertEqual(event["repository"], "owner/repo")
                self.assertNotIn("parent_native_session_id", event)
        spool = DurableSpool(self.root / "state" / "queue")
        self.assertEqual(len(spool.list_pending()), 2)
        keys = set()
        for path in spool.list_pending():
            item = spool.load(path)
            event = json.loads(gzip.decompress(item.stored_payload))
            keys.add(item.manifest.source_stream_key)
            self.assertEqual(item.manifest.source_kind, "collector")
            self.assertEqual(item.manifest.source_version, event["type"])
            self.assertEqual(item.manifest.observed_native_session_id, SESSION)
            self.assertEqual(gzip.decompress(item.stored_payload),
                (self.root / "state" / "pr-context" / "events" / f'{event["event_id"]}.jsonl').read_bytes())
        self.assertEqual(len(keys), 2)

    def test_duplicate_replay_and_conflict_preserve_event(self):
        result = self.enqueue()
        original = Path(result["sidecar"]).read_bytes()
        self.enqueue()
        self.assertEqual(Path(result["sidecar"]).read_bytes(), original)
        self.assertEqual(len(DurableSpool(self.root / "state" / "queue").list_pending()), 1)
        for changes in ({"pr_number": 92}, {"provider": "claude_code"}, {"session_id": OTHER},
                        {"occurred_at": "2026-09-10T00:00:00Z"}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.enqueue(**changes)
        self.assertEqual(Path(result["sidecar"]).read_bytes(), original)

    def test_same_event_concurrent_replay_queues_once(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: self.enqueue(), range(16)))
        self.assertTrue(all(row["event_id"] == EVENT for row in results))
        self.assertEqual(len(DurableSpool(self.root / "state" / "queue").list_pending()), 1)

    def test_independent_sessions_and_multiple_prs(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(lambda number: self.enqueue(event_id=str(uuid.uuid4()),
                session_id=SESSION if number % 2 else OTHER, pr_number=number), range(1, 9)))
        self.assertEqual(len(DurableSpool(self.root / "state" / "queue").list_pending()), 8)

    def test_retract_can_arrive_first_and_does_not_erase_link(self):
        retract = self.enqueue(operation="retract", event_id=str(uuid.uuid4()), link_event_id=EVENT)
        self.assertEqual(json.loads(Path(retract["sidecar"]).read_bytes())["link_event_id"], EVENT)
        link = self.enqueue()
        self.assertTrue(Path(link["sidecar"]).exists())
        self.assertEqual(len(DurableSpool(self.root / "state" / "queue").list_pending()), 2)

    def test_invalid_inputs_fail_closed(self):
        for changes in ({"repository": "https://localhost/repo"}, {"repository": "owner/.."},
                        {"pr_number": 0}, {"pr_number": True}, {"pr_number": 2147483648},
                        {"session_id": "../session"}, {"provider": "other"},
                        {"occurred_at": "2026-09-01T00:00:00+00:60"}, {"event_id": "x"},
                        {"operation": "retract", "link_event_id": EVENT}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.enqueue(**changes)
        self.assertEqual(len(list((self.root / "state" / "pr-context" / "events").glob("*.jsonl"))), 0)

    def test_offline_retry_and_ack_preserve_raw(self):
        result = self.enqueue()
        raw = Path(result["sidecar"]).read_bytes()
        spool = DurableSpool(self.root / "state" / "queue")
        class Offline:
            def upload(self, item):
                raise TransientUploadError("offline")
        self.assertEqual(Drain(spool, Offline()).run().requeued, 1)
        class Online:
            def upload(self, item):
                return receipt(item.manifest)
        self.assertEqual(Drain(spool, Online()).run().uploaded, 1)
        self.assertEqual(Path(result["sidecar"]).read_bytes(), raw)
        self.enqueue()  # resend same event/bytes; server performs idempotent receipt replay
        self.assertEqual(len(spool.list_pending()), 1)

    def test_collector_destination_change_rejected(self):
        self.enqueue()
        with self.assertRaises(ContractError):
            self.enqueue(configuration=CollectorConfig("https://elsewhere.example", CONFIG.identity))

    def test_all_http_drains_retain_context_on_collector_or_destination_drift(self):
        result = self.enqueue()
        raw = Path(result["sidecar"]).read_bytes()
        spool = DurableSpool(self.root / "state" / "queue")
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("offline")):
            outcome = Drain(spool, HttpTransport(CONFIG.endpoint, CONFIG.identity)).run()
            self.assertEqual(outcome.requeued, 1)
        identities = [
            CollectorIdentity("Other", "other", "other@sixtyfour.ai", CONFIG.identity.installation_id),
            CollectorIdentity("Test", "test", CONFIG.identity.email, str(uuid.uuid4())),
        ]
        configurations = [CollectorConfig(CONFIG.endpoint, identity) for identity in identities]
        configurations.append(CollectorConfig("http://127.0.0.1:1/other", CONFIG.identity))
        with patch("urllib.request.urlopen") as request:
            for configuration in configurations:
                outcome = Drain(spool, HttpTransport(configuration.endpoint, configuration.identity)).run()
                self.assertEqual(outcome.requeued, 1)
                self.assertEqual(outcome.uploaded, 0)
            # Ordinary CLI/background drain must use the same transport guard.
            with patch("sherlock_collector.cli.load_config", return_value=configurations[0]), contextlib.redirect_stdout(io.StringIO()) as output:
                main(["--provider", "codex", "--state-root", str(self.root / "state"), "drain"])
            self.assertEqual(json.loads(output.getvalue())["requeued"], 1)
            request.assert_not_called()
        item = spool.load(spool.list_pending()[0])
        with patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(receipt(item.manifest)).encode())) as request:
            outcome = Drain(spool, HttpTransport(CONFIG.endpoint, CONFIG.identity)).run()
            self.assertEqual(outcome.uploaded, 1)
            self.assertEqual(request.call_count, 1)
        self.assertEqual(Path(result["sidecar"]).read_bytes(), raw)

    def test_create_checks_config_binding_before_external_side_effect(self):
        self.enqueue()
        changed = CollectorConfig("http://127.0.0.1:1/other", CONFIG.identity)
        args = ["--provider", "codex", "--codex-home", str(self.root), "--state-root", str(self.root / "state"),
                "pr-context", "create", "--session-id", SESSION, "--repository", "owner/repo", "--head", "feature",
                "--title", "Example", "--body", "Example"]
        with patch("sherlock_collector.cli.load_config", return_value=changed), \
             patch("sherlock_collector.pr_context.subprocess.run") as run, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(args), 2)
            run.assert_not_called()

    def test_concurrent_creation_replay_invokes_gh_once(self):
        args = ["--provider", "codex", "--codex-home", str(self.root), "--state-root", str(self.root / "state"),
                "pr-context", "create", "--session-id", SESSION, "--repository", "owner/repo", "--head", "feature",
                "--title", "Example", "--body", "Example", "--event-id", EVENT]
        with patch("sherlock_collector.cli.load_config", return_value=CONFIG), \
             patch("sherlock_collector.pr_context.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "https://github.com/owner/repo/pull/91", "")) as run, \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: main(args), range(2)))
            self.assertEqual(sorted(results), [0, 2])
            self.assertEqual(run.call_count, 1)

    def test_collector_manifest_narrowly_versioned(self):
        self.enqueue()
        spool = DurableSpool(self.root / "state" / "queue")
        item = spool.load(spool.list_pending()[0])
        for changes in ({"source_version": "unknown"}, {"observed_native_session_id": None},
                        {"observed_parent_native_session_id": OTHER}):
            value = json.loads(json.dumps(item.manifest.to_dict()))
            value.update(changes)
            with self.assertRaises(ContractError):
                BatchManifest.from_dict(value)
        with self.assertRaises(ContractError):
            build_source_batch(gzip.decompress(item.stored_payload) * 2,
                source_stream_key="test", generation_key="test", generation_seq=0, start_offset=0,
                source_provider="codex", source_kind="collector", source_version="sherlock.pr-context.v1",
                observed_native_session_id=SESSION)

    def test_codex_native_validation_no_mutation_and_no_latest(self):
        directory = self.root / "sessions"
        directory.mkdir()
        path = directory / f"rollout-{SESSION}.jsonl"
        raw = json.dumps({"type": "session_meta", "payload": {"id": SESSION}}).encode() + b"\n"
        path.write_bytes(raw)
        self.assertEqual(validate_session("codex", SESSION, self.root), "native-file-checked")
        self.assertEqual(validate_session("codex", OTHER, self.root), "collector-declared")
        with self.assertRaises(ContractError):
            validate_session("codex", OTHER, self.root, path)
        with self.assertRaises(ContractError):
            validate_session("claude_code", SESSION, self.root, path)
        renamed = self.root / f"{SESSION}.jsonl"
        renamed.write_bytes(raw)
        with self.assertRaises(ContractError):
            validate_session("claude_code", SESSION, self.root, renamed)
        self.assertEqual(path.read_bytes(), raw)

    def test_claude_native_validation_and_subagent_no_inheritance(self):
        root = self.root / "projects" / "project"
        root.mkdir(parents=True)
        path = root / f"{SESSION}.jsonl"
        path.write_text(json.dumps({"type": "user", "sessionId": SESSION}) + "\n")
        self.assertEqual(validate_session("claude_code", SESSION, self.root), "native-file-checked")
        with self.assertRaises(ContractError):
            validate_session("claude_code", OTHER, self.root, path)
        path.write_text(json.dumps({"sessionId": OTHER}) + "\n")
        with self.assertRaises(ContractError):
            validate_session("claude_code", SESSION, self.root)
        subagent = root / SESSION / "subagents" / "agent-agent123.jsonl"
        subagent.parent.mkdir(parents=True)
        subagent.write_text(json.dumps({"sessionId": SESSION, "agentId": "agent123"}) + "\n")
        self.assertEqual(validate_session("claude_code", "agent123", self.root), "native-file-checked")

    def test_create_uses_explicit_arguments_and_only_successful_url(self):
        with patch("sherlock_collector.pr_context.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "https://github.com/Owner/Repo/pull/91\n", "")
            self.assertEqual(create_pull_request(repository="Owner/Repo", head="fork:feature",
                title="Fix", body="Body", draft=True), ("https://github.com/Owner/Repo/pull/91", 91))
            argv = run.call_args.args[0]
            self.assertIn("fork:feature", argv)
            self.assertIn("--draft", argv)
            for output in ("http://github.com/Owner/Repo/pull/91", "https://private.local/pull/91",
                           "https://github.com/Owner/Other/pull/91", "https://github.com/Owner/Repo/pull/91?x=y"):
                run.return_value = subprocess.CompletedProcess([], 0, output, "")
                with self.assertRaises(ContractError):
                    create_pull_request(repository="Owner/Repo", head="feature", title="Fix", body="")
            run.return_value = subprocess.CompletedProcess([], 1, "https://github.com/Owner/Repo/pull/91", "failed")
            with self.assertRaises(ContractError):
                create_pull_request(repository="Owner/Repo", head="feature", title="Fix", body="")

    def test_cli_usable_manual_fallback_requires_explicit_provider(self):
        args = ["--codex-home", str(self.root), "--state-root", str(self.root / "state"),
                "pr-context", "link", "--session-id", SESSION, "--repository", "owner/repo", "--pr-number", "91"]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(args), 2)
        with patch("sherlock_collector.cli.load_config", return_value=CONFIG), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["--provider", "codex", *args]), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["identity_check"], "collector-declared")
        self.assertEqual(result["status"], "queued")

    def test_cli_create_failure_does_not_queue(self):
        args = ["--provider", "codex", "--codex-home", str(self.root), "--state-root", str(self.root / "state"),
                "pr-context", "create", "--session-id", SESSION, "--repository", "owner/repo", "--head", "fork:feature",
                "--title", "Example", "--body", "Example"]
        with patch("sherlock_collector.cli.load_config", return_value=CONFIG), \
             patch("sherlock_collector.pr_context.subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "failed")), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(args), 2)
        self.assertEqual(DurableSpool(self.root / "state" / "queue").list_pending(), [])
        with patch("sherlock_collector.cli.load_config", return_value=CONFIG), \
             patch("sherlock_collector.pr_context.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "https://github.com/owner/repo/pull/91", "")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(args), 0)
        self.assertEqual(json.loads(output.getvalue())["created_pull_request_url"], "https://github.com/owner/repo/pull/91")
        self.assertEqual(len(DurableSpool(self.root / "state" / "queue").list_pending()), 1)


if __name__ == "__main__":
    unittest.main()
