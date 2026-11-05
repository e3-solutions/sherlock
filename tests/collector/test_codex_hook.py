"""Codex hook-only sessions (side-conversation forks) captured as codex/hook (COR-5208)."""

from __future__ import annotations
import _isolation  # noqa: F401  (must precede collector imports)

import base64
import gzip
import hashlib
import json
import os
import sys
import time
import unittest
import uuid
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector import codex_hook
from sherlock_collector.drain import Drain
from sherlock_collector.exclusions import (
    EXCLUDED,
    EXCLUDED_PROJECT,
    UNVERIFIED,
    _record_cwd,
    head_branch,
    load_policy,
    observed_cwds,
    origin_remote_url,
)
from sherlock_collector.hook import CODEX_HOOK_EVENTS, run_hook
from sherlock_collector.spool import DurableSpool
from test_collector import SuccessTransport
from test_plugin import create_threads_database

REPO = Path(__file__).resolve().parents[2]
ENVELOPE_KEYS = {
    "type", "schema_version", "collector_observed_at", "timestamp",
    "dispatch_event_name", "payload_sha256", "payload_base64",
    "native_session_id", "parent_native_session_id", "session_source", "git",
}


def make_repo(path: Path, remote: str | None, branch: str = "main") -> Path:
    (path / ".git").mkdir(parents=True)
    (path / ".git" / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
    config = "[core]\n\tbare = false\n"
    if remote is not None:
        config += f'[remote "origin"]\n\turl = {remote}\n'
    (path / ".git" / "config").write_text(config)
    return path


def codex_rollout(home: Path, native_id: str, meta: dict | None = None) -> Path:
    path = home / "sessions" / "2026" / "11" / "05" / f"rollout-2026-11-05T00-00-00-{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": native_id, **(meta or {})}}) + "\n"
    )
    return path


class CodexHookCase(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.home = self.root / "codex"
        self.home.mkdir()
        self.state = self.home / "sherlock" / "telemetry"
        self.work = self.root / "work"
        self.work.mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def policy(self, **values):
        path = self.root / "policy" / "session-exclusions.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({"version": 1, **values}))
        return load_policy(path)

    def payload(self, event, session_id, **values):
        return {
            "session_id": session_id,
            "transcript_path": None,
            "cwd": str(self.work),
            "hook_event_name": event,
            "model": "gpt-5-codex",
            **values,
        }

    def hook(self, event, payload, *, policy=None, raw=None):
        raw = json.dumps(payload, separators=(",", ":")).encode() if raw is None else raw
        with ExitStack() as stack:
            stack.enter_context(patch("sherlock_collector.hook.subprocess.Popen"))
            if policy is not None:
                stack.enter_context(
                    patch("sherlock_collector.rollout.load_policy", return_value=policy)
                )
            return run_hook(
                event, payload, raw_payload=raw, provider="codex",
                codex_home=self.home, state_root=self.state,
                drain_command=[sys.executable, "-c", "pass"],
            )

    def fork(self, session_id=None, *, policy=None, parent=None, prompt=True, stop=True, cwd=None,
             odd_bytes=False):
        """Run a fork's SessionStart, UserPromptSubmit and Stop; return raw payloads."""
        session_id = session_id or str(uuid.uuid4())
        extra = {"cwd": str(cwd)} if cwd is not None else {}
        start = self.payload("SessionStart", session_id, source="fork", **extra)
        if parent is not None:
            start["forked_from_id"] = parent
        events = [("SessionStart", start)]
        if prompt:
            events.append(("UserPromptSubmit", self.payload(
                "UserPromptSubmit", session_id, prompt="side question", turn_id="t1", **extra,
            )))
        if stop:
            events.append(("Stop", self.payload(
                "Stop", session_id, last_assistant_message="side answer", turn_id="t1", **extra,
            )))
        raws = []
        for event, payload in events:
            if odd_bytes:
                # Unusual spacing, reversed key order and \u escapes: the
                # observation must keep these exact bytes, not a re-encoding.
                payload = {**payload, "note": "caf\u00e9 \U0001F600 \"q\""}
                raw = (
                    b" \t" + json.dumps(
                        dict(reversed(list(payload.items()))),
                        separators=(" ,  ", " :"), ensure_ascii=True,
                    ).encode() + b" \n"
                )
                payload = json.loads(raw)
            else:
                raw = json.dumps(payload, separators=(",", ":")).encode()
            self.hook(event, payload, policy=policy, raw=raw)
            raws.append(raw)
        return session_id, raws

    def pending(self):
        items = []
        for path in sorted((self.state / "queue" / "pending").glob("*.json")):
            item = json.loads(path.read_text())
            stored = gzip.decompress(base64.b64decode(item["stored_payload_base64"]))
            items.append((item["manifest"], stored))
        return items

    def observations(self):
        return sorted((self.state / "codex-hook-events").glob("*.jsonl"))


class CaptureTests(CodexHookCase):
    def test_fork_events_spool_exact_bytes_as_codex_hook(self):
        make_repo(self.work, "https://user:secret-token@github.com/acme/app.git", branch="feature/x")
        parent = str(uuid.uuid4())
        session_id, raws = self.fork(parent=parent, odd_bytes=True)
        self.assertIn(b"\\u00e9", raws[0])
        self.assertIn(b"\\ud83d\\ude00", raws[0])

        items = self.pending()
        self.assertEqual(len(items), 3)
        envelopes = []
        for manifest, stored in items:
            self.assertEqual(manifest["source_provider"], "codex")
            self.assertEqual(manifest["source_kind"], "hook")
            self.assertEqual(manifest["observed_native_session_id"], session_id)
            self.assertEqual(stored.count(b"\n"), 1)
            envelope = json.loads(stored)
            self.assertEqual(set(envelope), ENVELOPE_KEYS)
            self.assertEqual(
                manifest["observed_parent_native_session_id"],
                envelope["parent_native_session_id"],
            )
            envelopes.append(envelope)
        by_event = {envelope["dispatch_event_name"]: envelope for envelope in envelopes}
        self.assertEqual(set(by_event), {"SessionStart", "UserPromptSubmit", "Stop"})
        for event, raw in zip(("SessionStart", "UserPromptSubmit", "Stop"), raws):
            envelope = by_event[event]
            self.assertEqual(envelope["type"], "codex_hook")
            self.assertEqual(envelope["schema_version"], "sherlock.codex-hook.v1")
            self.assertEqual(base64.b64decode(envelope["payload_base64"], validate=True), raw)
            self.assertEqual(envelope["payload_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(envelope["native_session_id"], session_id)
            self.assertEqual(envelope["session_source"], "fork")
            self.assertRegex(envelope["collector_observed_at"], r"^\d{4}-\d\d-\d\dT.*Z$")
            self.assertEqual(envelope["timestamp"], envelope["collector_observed_at"])
            # Credentials in the remote never leave the machine.
            self.assertEqual(
                envelope["git"],
                {"repository_url": "https://github.com/acme/app.git", "branch": "feature/x"},
            )
        # Only the payload that names the parent carries it.
        self.assertEqual(by_event["SessionStart"]["parent_native_session_id"], parent)
        self.assertIsNone(by_event["UserPromptSubmit"]["parent_native_session_id"])
        self.assertIsNone(by_event["Stop"]["parent_native_session_id"])
        marker = codex_hook.session_marker(self.state, session_id)
        self.assertEqual(marker["source"], "fork")
        self.assertEqual(marker["parent_native_session_id"], parent)

    def test_parent_thread_id_is_used_and_git_may_be_unknown(self):
        session_id, parent = str(uuid.uuid4()), str(uuid.uuid4())
        payload = self.payload("SessionStart", session_id, source="fork", parent_thread_id=parent)
        outcome = self.hook("SessionStart", payload)
        self.assertEqual(outcome.enqueued, 1)
        ((manifest, stored),) = self.pending()
        envelope = json.loads(stored)
        self.assertEqual(envelope["parent_native_session_id"], parent)
        self.assertEqual(manifest["observed_parent_native_session_id"], parent)
        self.assertEqual(envelope["git"], {"repository_url": None, "branch": None})

    def test_null_path_with_a_discovered_rollout_produces_no_observation(self):
        session_id = str(uuid.uuid4())
        codex_rollout(self.home, session_id, {"cwd": str(self.work)})
        self.hook("SessionStart", self.payload("SessionStart", session_id, source="fork"))
        self.hook("UserPromptSubmit", self.payload("UserPromptSubmit", session_id, prompt="x"))
        self.assertEqual(self.observations(), [])
        self.assertTrue(all(m["source_kind"] == "rollout" for m, _ in self.pending()))

    def test_null_path_with_a_state_database_row_produces_no_observation(self):
        session_id = str(uuid.uuid4())
        rollout = codex_rollout(self.home, session_id, {"cwd": str(self.work)})
        create_threads_database(self.home / "state_5.sqlite", [{
            "id": session_id, "rollout_path": rollout,
            "updated_at_ms": int(time.time() * 1000),
        }])
        rollout.unlink()  # The row alone (its rollout gone) still means "not hook-only".
        self.hook("UserPromptSubmit", self.payload("UserPromptSubmit", session_id, prompt="x"))
        self.hook("SessionStart", self.payload("SessionStart", session_id, source="fork"))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])

    def without_path(self, event, session_id, **values):
        payload = self.payload(event, session_id, **values)
        del payload["transcript_path"]
        return payload

    def test_missing_transcript_path_key_on_a_fork_session_start_is_captured(self):
        session_id = str(uuid.uuid4())
        events = [
            ("SessionStart", self.without_path("SessionStart", session_id, source="fork")),
            ("UserPromptSubmit", self.without_path("UserPromptSubmit", session_id, prompt="q")),
            ("Stop", self.without_path("Stop", session_id, last_assistant_message="a")),
        ]
        raws = []
        for event, payload in events:
            raw = json.dumps(payload, separators=(",", ":")).encode()
            self.assertEqual(self.hook(event, payload, raw=raw).enqueued, 1)
            raws.append(raw)
        envelopes = [json.loads(stored) for _, stored in self.pending()]
        self.assertEqual(
            sorted(base64.b64decode(e["payload_base64"]) for e in envelopes), sorted(raws)
        )
        self.assertTrue(all(e["session_source"] == "fork" for e in envelopes))
        self.assertTrue(all(e["native_session_id"] == session_id for e in envelopes))

    def test_missing_transcript_path_key_with_a_fork_marker_is_captured(self):
        session_id = str(uuid.uuid4())
        # The SessionStart named a null path; later events omit the key.
        self.hook("SessionStart", self.payload("SessionStart", session_id, source="fork"))
        self.hook("UserPromptSubmit", self.without_path("UserPromptSubmit", session_id, prompt="q"))
        self.hook("Stop", self.without_path("Stop", session_id, last_assistant_message="a"))
        events = sorted(json.loads(stored)["dispatch_event_name"] for _, stored in self.pending())
        self.assertEqual(events, ["SessionStart", "Stop", "UserPromptSubmit"])

    def test_missing_transcript_path_key_without_a_fork_marker_produces_none(self):
        unmarked = str(uuid.uuid4())
        self.hook("UserPromptSubmit", self.without_path("UserPromptSubmit", unmarked, prompt="q"))
        self.hook("Stop", self.without_path("Stop", unmarked, last_assistant_message="a"))
        startup = str(uuid.uuid4())
        for event in ("SessionStart", "UserPromptSubmit", "Stop"):
            self.hook(event, self.without_path(event, startup, source="startup"))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])
        self.assertFalse((self.state / "codex-hook-sessions").exists())

    def test_missing_transcript_path_key_with_a_discovered_rollout_produces_none(self):
        session_id = str(uuid.uuid4())
        codex_rollout(self.home, session_id, {"cwd": str(self.work)})
        self.hook("SessionStart", self.without_path("SessionStart", session_id, source="fork"))
        self.hook("UserPromptSubmit", self.without_path("UserPromptSubmit", session_id, prompt="q"))
        self.assertEqual(self.observations(), [])
        self.assertTrue(all(m["source_kind"] == "rollout" for m, _ in self.pending()))

    def test_missing_transcript_path_key_with_a_bad_session_id_produces_none(self):
        for session_id in ("not-a-uuid", str(uuid.uuid4()).upper()):
            self.hook("SessionStart", self.without_path("SessionStart", session_id, source="fork"))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])

    def test_normal_session_naming_a_transcript_not_yet_written_produces_none(self):
        session_id = str(uuid.uuid4())
        missing = self.home / "sessions" / "2026" / "11" / "05" / f"rollout-x-{session_id}.jsonl"
        for event in ("SessionStart", "UserPromptSubmit", "Stop"):
            self.hook(event, self.payload(event, session_id, source="fork", transcript_path=str(missing)))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])

    def test_non_fork_null_path_session_produces_none(self):
        startup = str(uuid.uuid4())
        self.hook("SessionStart", self.payload("SessionStart", startup, source="startup"))
        self.hook("UserPromptSubmit", self.payload("UserPromptSubmit", startup, prompt="x"))
        self.hook("Stop", self.payload("Stop", startup, last_assistant_message="y"))
        # No SessionStart at all (for example codex exec --ephemeral): no marker.
        unmarked = str(uuid.uuid4())
        self.hook("UserPromptSubmit", self.payload("UserPromptSubmit", unmarked, prompt="x"))
        self.hook("Stop", self.payload("Stop", unmarked, last_assistant_message="y"))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])
        # Only forks leave a marker.
        self.assertIsNone(codex_hook.session_source(self.state, startup))
        self.assertFalse((self.state / "codex-hook-sessions").exists())

    def test_other_events_ids_and_empty_payloads_produce_none(self):
        session_id = str(uuid.uuid4())
        self.hook("SessionStart", self.payload("SessionStart", session_id, source="fork"), raw=b"")
        self.hook("PostToolUse", self.payload("PostToolUse", session_id, tool_name="spawn_agent"))
        self.hook("SessionStart", self.payload("SessionStart", "not-a-uuid", source="fork"))
        self.hook("SessionStart", self.payload("SessionStart", session_id.upper(), source="fork"))
        self.assertEqual(self.observations(), [])
        self.assertEqual(self.pending(), [])

    def test_left_over_observations_are_captured_by_the_next_fork_event(self):
        first, _ = self.fork(prompt=False, stop=False)
        # Simulate an observation whose capture never ran (lock held, crash).
        orphan_id = str(uuid.uuid4())
        orphan_payload = self.payload("SessionStart", orphan_id, source="fork")
        codex_hook.write_observation(
            self.state, "SessionStart", orphan_payload,
            json.dumps(orphan_payload).encode(), session_source="fork",
        )
        self.fork(prompt=False, stop=False)
        ids = [manifest["observed_native_session_id"] for manifest, _ in self.pending()]
        self.assertEqual(len(ids), 3)
        self.assertIn(orphan_id, ids)
        self.assertEqual(ids.count(first), 1)

    def test_hook_only_events_are_registered_codex_hooks(self):
        self.assertLessEqual(codex_hook.HOOK_ONLY_EVENTS, CODEX_HOOK_EVENTS)
        hooks = json.loads((REPO / "plugins" / "sherlock" / "hooks" / "hooks.json").read_text())
        registered = set(hooks.get("hooks", hooks))
        self.assertLessEqual(codex_hook.HOOK_ONLY_EVENTS, registered)

    def test_old_session_markers_are_pruned(self):
        old = str(uuid.uuid4())
        codex_hook.remember_session(self.state, {"session_id": old, "source": "fork"})
        path = self.state / "codex-hook-sessions" / f"{old}.json"
        stale = time.time() - codex_hook.MARKER_RETENTION_SECONDS - 60
        os.utime(path, (stale, stale))
        fresh = str(uuid.uuid4())
        codex_hook.remember_session(self.state, {"session_id": fresh, "source": "fork"})
        self.assertFalse(path.exists())
        self.assertEqual(codex_hook.session_source(self.state, fresh), "fork")


class BoundedSweepTests(CodexHookCase):
    def test_captured_observations_move_aside_unchanged(self):
        self.fork()
        self.assertEqual(self.observations(), [])
        captured = sorted((self.state / "codex-hook-events" / "captured").glob("*.jsonl"))
        self.assertEqual(len(captured), 3)
        self.assertEqual(
            sorted(path.read_bytes() for path in captured),
            sorted(stored for _, stored in self.pending()),
        )

    def test_hook_work_stays_bounded_with_many_captured_observations(self):
        archive = self.state / "codex-hook-events" / "captured"
        archive.mkdir(parents=True)
        for index in range(3000):
            (archive / f"{uuid.uuid4()}.jsonl").write_text("{}\n")
        with patch.object(
            codex_hook, "observation_identity", wraps=codex_hook.observation_identity
        ) as identity:
            outcome = self.hook(
                "SessionStart", self.payload("SessionStart", str(uuid.uuid4()), source="fork")
            )
        self.assertEqual(outcome.enqueued, 1)
        self.assertEqual(identity.call_count, 1)

    def test_held_observations_stay_and_each_hook_retries_a_bounded_window(self):
        from sherlock_collector.hook import CODEX_HOOK_SWEEP_LIMIT

        private = self.root / "private"
        private.mkdir()
        policy = self.policy(excluded_project_paths=[str(private)])
        for _ in range(CODEX_HOOK_SWEEP_LIMIT + 40):
            payload = self.payload("SessionStart", str(uuid.uuid4()), source="fork", cwd=str(private))
            codex_hook.write_observation(
                self.state, "SessionStart", payload, json.dumps(payload).encode(),
                session_source="fork",
            )
        with patch.object(
            codex_hook, "observation_identity", wraps=codex_hook.observation_identity
        ) as identity:
            self.fork(policy=policy, prompt=False, stop=False)
        self.assertEqual(identity.call_count, CODEX_HOOK_SWEEP_LIMIT + 1)
        # Held ones stay listed (never uploaded); the new fork moved aside.
        self.assertEqual(len(self.observations()), CODEX_HOOK_SWEEP_LIMIT + 40)
        self.assertEqual(len(self.pending()), 1)

    def test_held_observation_is_captured_once_the_policy_allows_it(self):
        private = self.root / "private"
        private.mkdir()
        held, _ = self.fork(policy=self.policy(excluded_project_paths=[str(private)]),
                            cwd=private, prompt=False, stop=False)
        self.assertEqual(len(self.observations()), 1)
        self.assertEqual(self.pending(), [])
        self.fork(prompt=False, stop=False)
        ids = [manifest["observed_native_session_id"] for manifest, _ in self.pending()]
        self.assertIn(held, ids)
        self.assertEqual(self.observations(), [])


class ExclusionTests(CodexHookCase):
    def assertNothingQueued(self):
        self.assertEqual(self.pending(), [])

    def test_excluded_project_path_blocks_fork_events(self):
        policy = self.policy(excluded_project_paths=[str(self.work)])
        self.fork(policy=policy, cwd=self.work / "sub")
        self.assertNothingQueued()

    def test_excluded_folder_name_pattern_blocks_fork_events(self):
        scratch = self.root / "tmp" / "aeyron-123"
        scratch.mkdir(parents=True)
        policy = self.policy(excluded_project_paths=[f"{self.root / 'tmp'}/aeyron-*"])
        self.fork(policy=policy, cwd=scratch)
        self.assertNothingQueued()
        # A folder outside the pattern is still collected.
        self.fork(policy=policy, cwd=self.work)
        self.assertEqual(len(self.pending()), 3)

    def test_excluded_repository_remote_blocks_fork_events_in_other_clones(self):
        private = make_repo(self.root / "private", "git@github.com:acme/Private.git")
        clone = make_repo(self.root / "clone", "https://github.com/acme/private")
        policy = self.policy(excluded_project_paths=[str(private)])
        self.assertIsNone(policy._cwds_reason({str(clone)}))  # not by path
        self.fork(policy=policy, cwd=clone)
        self.assertNothingQueued()

    def test_excluded_parent_blocks_the_fork_and_its_later_events(self):
        parent = str(uuid.uuid4())
        policy = self.policy(excluded_session_ids=[parent])
        self.fork(policy=policy, parent=parent)
        self.assertNothingQueued()

    def test_excluded_session_id_blocks_the_fork_itself(self):
        session_id = str(uuid.uuid4())
        policy = self.policy(excluded_session_ids=[session_id])
        self.fork(session_id, policy=policy)
        self.assertNothingQueued()

    def test_fork_without_a_known_parent_is_held_while_ids_are_excluded(self):
        policy = self.policy(excluded_session_ids=[str(uuid.uuid4())])
        self.fork(policy=policy)
        self.assertNothingQueued()
        (observation, *_) = self.observations()
        session_id, _ = codex_hook.observation_identity(observation)
        self.assertEqual(
            policy.blocked_reason("codex", session_id, source_path=observation,
                                  source_kind="hook", source_home=self.home),
            UNVERIFIED,
        )

    def test_fork_of_a_verified_parent_is_collected_while_ids_are_excluded(self):
        parent = str(uuid.uuid4())
        codex_rollout(self.home, parent, {"cwd": str(self.work)})
        policy = self.policy(excluded_session_ids=[str(uuid.uuid4())])
        self.fork(policy=policy, parent=parent)
        hook_items = [m for m, _ in self.pending() if m["source_kind"] == "hook"]
        # The prompt and Stop name no parent; the SessionStart marker supplies it.
        self.assertEqual(len(hook_items), 3)

    def test_fork_of_a_descendant_of_an_excluded_session_is_blocked(self):
        excluded, parent = str(uuid.uuid4()), str(uuid.uuid4())
        codex_rollout(self.home, parent, {"cwd": str(self.work), "parent_thread_id": excluded})
        policy = self.policy(excluded_session_ids=[excluded])
        self.fork(policy=policy, parent=parent)
        self.assertEqual([m for m, _ in self.pending() if m["source_kind"] == "hook"], [])

    def test_fork_of_a_fork_continues_through_the_parent_marker(self):
        root = str(uuid.uuid4())
        codex_rollout(self.home, root, {"cwd": str(self.work)})
        parent, _ = self.fork(parent=root, prompt=False, stop=False)
        policy = self.policy(excluded_session_ids=[str(uuid.uuid4())])
        child, _ = self.fork(policy=policy, parent=parent)
        ids = [m["observed_native_session_id"] for m, _ in self.pending() if m["source_kind"] == "hook"]
        self.assertEqual(ids.count(child), 3)

    def test_fork_of_a_fork_of_an_excluded_session_is_blocked(self):
        excluded, root = str(uuid.uuid4()), str(uuid.uuid4())
        codex_rollout(self.home, root, {"cwd": str(self.work), "parent_thread_id": excluded})
        parent, _ = self.fork(parent=root, prompt=False, stop=False)
        child, _ = self.fork(policy=self.policy(excluded_session_ids=[excluded]), parent=parent)
        ids = [m["observed_native_session_id"] for m, _ in self.pending()]
        self.assertNotIn(child, ids)

    def test_fork_of_a_fork_in_an_excluded_project_is_blocked(self):
        private = self.root / "private"
        private.mkdir()
        parent, _ = self.fork(cwd=private, prompt=False, stop=False)
        child, _ = self.fork(policy=self.policy(excluded_project_paths=[str(private)]),
                             parent=parent, cwd=self.work)
        ids = [m["observed_native_session_id"] for m, _ in self.pending()]
        self.assertNotIn(child, ids)

    def test_fork_of_a_fork_with_an_unverifiable_chain_is_held(self):
        policy = self.policy(excluded_session_ids=[str(uuid.uuid4())])
        rootless, _ = self.fork(prompt=False, stop=False)  # its marker names no parent
        child, _ = self.fork(policy=policy, parent=rootless)
        unmarked_child, _ = self.fork(policy=policy, parent=str(uuid.uuid4()))
        ids = [m["observed_native_session_id"] for m, _ in self.pending()]
        self.assertNotIn(child, ids)
        self.assertNotIn(unmarked_child, ids)

    def test_fork_with_an_unresolvable_parent_is_held(self):
        policy = self.policy(excluded_project_paths=[str(self.root / "elsewhere")])
        self.fork(policy=policy, parent=str(uuid.uuid4()))
        self.assertNothingQueued()

    def test_fork_without_cwd_is_held_while_projects_are_excluded(self):
        policy = self.policy(excluded_project_paths=[str(self.root / "elsewhere")])
        session_id = str(uuid.uuid4())
        payload = self.payload("SessionStart", session_id, source="fork")
        del payload["cwd"]
        self.hook("SessionStart", payload, policy=policy)
        self.assertNothingQueued()
        (observation,) = self.observations()
        self.assertEqual(
            policy.blocked_reason("codex", session_id, source_path=observation, source_kind="hook"),
            UNVERIFIED,
        )

    def test_unrelated_projects_do_not_block_forks(self):
        policy = self.policy(excluded_project_paths=[str(self.root / "elsewhere")])
        self.fork(policy=policy)
        self.assertEqual(len(self.pending()), 3)

    def test_rollout_branch_is_unchanged_for_codex_rollouts(self):
        parent = str(uuid.uuid4())
        policy = self.policy(excluded_session_ids=[parent])
        fork = codex_rollout(self.home, str(uuid.uuid4()), {"forked_from_id": parent})
        self.assertEqual(policy.blocked_reason("codex", None, source_path=fork), EXCLUDED)


class DrainHoldTests(CodexHookCase):
    def drain(self, policy):
        transport = SuccessTransport()
        result = Drain(
            DurableSpool(self.state / "queue"), transport,
            exclusion_policy=policy, source_home=self.home,
        ).run()
        return transport, result

    def test_queued_fork_batches_are_held_by_project_pattern_and_remote(self):
        private = make_repo(self.root / "private", "git@github.com:acme/private.git")
        clone = make_repo(self.root / "clone", "https://github.com/acme/private.git")
        scratch = self.root / "tmp" / "aeyron-1"
        scratch.mkdir(parents=True)
        inside = private / "sub"
        inside.mkdir()
        kept, _ = self.fork(cwd=self.work, prompt=False, stop=False)
        self.fork(cwd=inside, prompt=False, stop=False)
        self.fork(cwd=clone, prompt=False, stop=False)
        self.fork(cwd=scratch, prompt=False, stop=False)
        self.assertEqual(len(self.pending()), 4)
        policy = self.policy(excluded_project_paths=[str(private), f"{self.root / 'tmp'}/aeyron-*"])
        transport, result = self.drain(policy)
        self.assertEqual({i.manifest.observed_native_session_id for i in transport.items}, {kept})
        self.assertEqual(result.held_by_policy, 3)

    def test_queued_forks_without_a_known_parent_are_held_when_ids_are_excluded(self):
        parent = str(uuid.uuid4())
        codex_rollout(self.home, parent, {"cwd": str(self.work)})
        orphan, _ = self.fork()
        child, _ = self.fork(parent=parent)
        excluded_parent = str(uuid.uuid4())
        codex_rollout(self.home, excluded_parent, {"cwd": str(self.work)})
        blocked, _ = self.fork(parent=excluded_parent)
        hook_items = [m for m, _ in self.pending() if m["source_kind"] == "hook"]
        self.assertEqual(len(hook_items), 9)
        policy = self.policy(excluded_session_ids=[excluded_parent])
        transport, result = self.drain(policy)
        uploaded = [
            item.manifest.observed_native_session_id
            for item in transport.items if item.manifest.source_kind == "hook"
        ]
        # The child's prompt and Stop name no parent; the marker supplies it.
        self.assertEqual(sorted(uploaded), sorted([child] * 3))
        self.assertNotIn(orphan, uploaded)
        self.assertNotIn(blocked, uploaded)
        # Six hook batches plus the excluded parent's own rollout batch.
        self.assertEqual(result.held_by_policy, 7)

    def test_queued_batches_of_an_excluded_fork_are_held(self):
        excluded, _ = self.fork()
        kept, _ = self.fork()
        transport, result = self.drain(self.policy(excluded_session_ids=[excluded]))
        uploaded = {item.manifest.observed_native_session_id for item in transport.items}
        self.assertNotIn(excluded, uploaded)
        self.assertEqual(result.held_by_policy, 3 + 3)  # kept names no parent either

    def test_queued_prompt_is_held_when_its_fork_marker_is_missing(self):
        parent = str(uuid.uuid4())
        codex_rollout(self.home, parent, {"cwd": str(self.work)})
        child, _ = self.fork(parent=parent)
        (self.state / "codex-hook-sessions" / f"{child}.json").unlink()
        transport, result = self.drain(self.policy(excluded_session_ids=[str(uuid.uuid4())]))
        uploaded = [
            item.manifest.observed_native_session_id
            for item in transport.items if item.manifest.source_kind == "hook"
        ]
        # The SessionStart names its parent; the prompt and Stop relied on the marker.
        self.assertEqual(uploaded, [child])
        self.assertEqual(result.held_by_policy, 2)

    def test_queued_fork_batches_upload_without_a_policy(self):
        self.fork()
        transport, result = self.drain(None)
        self.assertEqual(len(transport.items), 3)
        self.assertEqual(result.held_by_policy, 0)


class LocalGitAndCwdTests(CodexHookCase):
    def test_record_cwd_and_observed_cwds_decode_codex_hook(self):
        raw = json.dumps({"session_id": str(uuid.uuid4()), "cwd": str(self.work)}).encode()
        record = {"type": "codex_hook", "payload_base64": base64.b64encode(raw).decode()}
        self.assertEqual(_record_cwd(record), str(self.work))
        self.assertEqual(observed_cwds(json.dumps(record).encode() + b"\n"), {str(self.work)})
        self.assertIsNone(_record_cwd({**record, "type": "other"}))

    def test_remote_and_branch_are_read_from_a_linked_worktree(self):
        main = make_repo(self.root / "main", "ssh://git:pw@github.com/acme/app.git")
        gitdir = main / ".git" / "worktrees" / "wt"
        gitdir.mkdir(parents=True)
        (gitdir / "commondir").write_text("../..\n")
        (gitdir / "HEAD").write_text("ref: refs/heads/topic\n")
        worktree = self.root / "wt"
        (worktree / "deep").mkdir(parents=True)
        (worktree / ".git").write_text(f"gitdir: {gitdir}\n")
        self.assertEqual(origin_remote_url(str(worktree / "deep")), "ssh://github.com/acme/app.git")
        (main / ".git" / "config").write_text(
            '[remote "origin"]\n\turl = https://github.com/acme/app.git?access_token=t#frag\n'
        )
        self.assertEqual(origin_remote_url(str(worktree)), "https://github.com/acme/app.git")
        self.assertEqual(head_branch(str(worktree / "deep")), "topic")
        (gitdir / "HEAD").write_text("0123456789abcdef0123456789abcdef01234567\n")
        self.assertIsNone(head_branch(str(worktree)))
        self.assertIsNone(origin_remote_url(str(self.work)))
        self.assertIsNone(origin_remote_url("relative/path"))

    def test_excluded_repository_is_matched_from_queued_git(self):
        private = make_repo(self.root / "private", "https://github.com/acme/private.git")
        policy = self.policy(excluded_project_paths=[str(private)])
        session_id = str(uuid.uuid4())
        self.assertEqual(
            policy.blocked_reason(
                "codex", session_id, source_kind="hook",
                observed_cwds=[str(self.root / "gone")],
                observed_repositories=["git@github.com:ACME/private"],
            ),
            EXCLUDED_PROJECT,
        )
        self.assertIsNone(
            policy.blocked_reason(
                "codex", session_id, source_kind="hook",
                observed_cwds=[str(self.root / "gone")],
                observed_repositories=["https://github.com/acme/public"],
            )
        )


if __name__ == "__main__":
    unittest.main()
