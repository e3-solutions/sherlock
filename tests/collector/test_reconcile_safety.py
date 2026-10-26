"""Review fixes for the periodic reconciler (COR-4920 rebase of #126)."""

from __future__ import annotations
import _isolation  # noqa: F401  (must precede collector imports)

import base64
import importlib.util
import json
import os
import shutil
import stat
import sys
import time
import unittest
import uuid
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import asdict
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.drain import Drain
from sherlock_collector.exclusions import (
    EXCLUDED,
    EXCLUDED_PROJECT,
    NOT_ALLOWED,
    UNREADABLE,
    UNVERIFIED,
    excluded_project_paths,
    load_policy,
    update_project_exclusions,
)
from sherlock_collector.reconcile import reconcile
from sherlock_collector.rollout import RolloutCapturer, StreamState
from sherlock_collector.spool import DurableSpool
from test_collector import SuccessTransport

REPO = Path(__file__).resolve().parents[2]


def codex_rollout(home, native_id=None, *, meta=None, tail=b"{}\n", day="2026/10/22"):
    native_id = native_id or str(uuid.uuid4())
    path = home / "sessions" / day / f"rollout-2026-10-22T00-00-00-{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"id": native_id, **(meta or {})}
    path.write_bytes(
        json.dumps({"type": "session_meta", "payload": payload}).encode() + b"\n" + tail
    )
    return path.resolve(), native_id


def claude_transcript(home, native_id=None):
    native_id = native_id or str(uuid.uuid4())
    path = home / "projects" / "repo" / f"{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps({"type": "user", "sessionId": native_id}).encode() + b"\n")
    return path.resolve(), native_id


def write_policy(directory, **values):
    path = Path(directory) / "session-exclusions.json"
    path.write_text(json.dumps({"version": 1, **values}))
    return load_policy(path)


def uploaded_ids(transport):
    return {item.manifest.observed_native_session_id for item in transport.items}


class CursorRollbackCompatibilityTests(unittest.TestCase):
    """Older runtimes build StreamState(**entry) and reject unknown keys."""

    LEGACY_FIELDS = {
        "path", "device", "inode", "prefix_length", "prefix_sha256",
        "generation_seq", "generation_key", "offset",
    }

    def test_saved_stream_entries_keep_the_legacy_shape(self):
        with TemporaryDirectory() as directory:
            capturer = RolloutCapturer(Path(directory), DurableSpool(Path(directory) / "q"))
            plain = StreamState("/a", 1, 2, 3, "h", 0, "g", 10)
            extended = StreamState(
                "/b", 1, 3, 3, "h", 0, "g", 20,
                recovery_reason="legacy_unterminated_cursor_continued",
                pending_fragment={"plan": {"start_offset": 20}, "next_fragment": 2},
            )
            capturer._save_state({"a": plain, "b": extended}, 0)
            raw = json.loads(capturer.state_path.read_text())
            for entry in raw["streams"].values():
                self.assertEqual(set(entry), self.LEGACY_FIELDS)

            # What an older runtime does with this file: it must still load.
            @__import__("dataclasses").dataclass
            class LegacyStreamState:
                path: str
                device: int
                inode: int
                prefix_length: int
                prefix_sha256: str
                generation_seq: int
                generation_key: str
                offset: int

            for entry in raw["streams"].values():
                LegacyStreamState(**entry)

            states, _ = capturer._read_state(capturer.state_path)
            self.assertEqual(states["a"], plain)
            self.assertEqual(states["b"], extended)

    def test_inline_extension_fields_from_earlier_builds_are_still_read(self):
        with TemporaryDirectory() as directory:
            capturer = RolloutCapturer(Path(directory), DurableSpool(Path(directory) / "q"))
            state = StreamState("/a", 1, 2, 3, "h", 0, "g", 10, recovery_reason="x")
            capturer.state_path.write_text(
                json.dumps({"state_version": 1, "candidate_cursor": 0,
                            "streams": {"a": asdict(state)}})
            )
            self.assertEqual(capturer._read_state(capturer.state_path)[0]["a"], state)


class ReconcileWindowAndIdentityTests(unittest.TestCase):
    def test_default_window_skips_old_history_until_explicitly_requested(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            old, old_id = codex_rollout(home, day="2025/01/01")
            recent, recent_id = codex_rollout(home)
            os.utime(old, (1, 1))
            transport = SuccessTransport()
            result = reconcile(home, state, "codex", transport)
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["max_age_days"], 31)
            self.assertEqual(uploaded_ids(transport), {recent_id})
            full = reconcile(home, state, "codex", transport, max_age_days=0)
            self.assertEqual(full["status"], "complete")
            self.assertEqual(uploaded_ids(transport), {recent_id, old_id})

    def test_sources_that_age_out_are_reported_not_counted_unfinished(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            path, _ = claude_transcript(home)
            reconcile(home, state, "claude_code", None)
            os.utime(path, (1, 1))
            result = reconcile(home, state, "claude_code", SuccessTransport())
            self.assertEqual(result["unfinished_sources"], 0)
            ledger = json.loads((state / "claude_code-reconcile.json").read_text())
            self.assertEqual(
                ledger["sources"][str(path)]["status"], "outside_reconcile_window"
            )

    def test_codex_rollout_without_session_meta_is_deferred_not_filename_labelled(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            filename_id = str(uuid.uuid4())
            path = home / "sessions" / f"rollout-2026-10-22T00-00-00-{filename_id}.jsonl"
            path.parent.mkdir(parents=True)
            path.write_bytes(b'{"type":"event_msg"}\n')
            transport = SuccessTransport()
            result = reconcile(home, state, "codex", transport)
            self.assertEqual(transport.items, [])
            self.assertEqual(result["status"], "partial")
            entry = json.loads((state / "codex-reconcile.json").read_text())["sources"][
                str(path.resolve())
            ]
            self.assertEqual(entry["reason"], "session_meta_unavailable")

    def test_subagent_rollout_is_labelled_by_its_own_session_meta(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            _, parent_id = codex_rollout(home)
            _, child_id = codex_rollout(home, meta={"parent_thread_id": parent_id})
            transport = SuccessTransport()
            reconcile(home, state, "codex", transport)
            labels = {
                item.manifest.observed_native_session_id:
                    item.manifest.observed_parent_native_session_id
                for item in transport.items
            }
            self.assertEqual(labels, {parent_id: None, child_id: parent_id})


class ExclusionPolicyTests(unittest.TestCase):
    def test_reconcile_skips_excluded_codex_families_and_keeps_cursors(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            _, excluded = codex_rollout(home)
            _, child = codex_rollout(home, meta={"parent_thread_id": excluded})
            _, grandchild = codex_rollout(
                home,
                meta={"source": {"subagent": {"thread_spawn": {"parent_thread_id": child}}}},
            )
            _, fork = codex_rollout(home, meta={"forked_from_id": excluded})
            _, kept = codex_rollout(home)
            policy = write_policy(directory, excluded_session_ids=[excluded.upper()])
            transport = SuccessTransport()
            with patch("sherlock_collector.rollout.load_policy", return_value=policy), \
                    patch("sherlock_collector.drain.load_policy", return_value=policy):
                result = reconcile(home, state, "codex", transport)
            self.assertEqual(uploaded_ids(transport), {kept})
            self.assertEqual(result["unfinished_sources"], 4)
            ledger = json.loads((state / "codex-reconcile.json").read_text())["sources"]
            reasons = {entry["native_session_id"]: entry["reason"] for entry in ledger.values()}
            for blocked in (excluded, child, grandchild, fork):
                self.assertEqual(reasons[blocked], EXCLUDED)
            # Removing the entry resumes from the untouched cursor.
            transport_after = SuccessTransport()
            reconcile(home, state, "codex", transport_after)
            self.assertEqual(
                uploaded_ids(transport_after), {excluded, child, grandchild, fork}
            )

    def test_already_queued_batches_of_excluded_sessions_are_held_not_sent(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            _, excluded = codex_rollout(home)
            _, child = codex_rollout(home, meta={"parent_thread_id": excluded})
            _, kept = codex_rollout(home)
            reconcile(home, state, "codex", None)  # queued before the policy
            spool = DurableSpool(state / "queue")
            self.assertEqual(len(spool.list_pending()), 3)
            policy = write_policy(directory, excluded_session_ids=[excluded])
            transport = SuccessTransport()
            result = Drain(spool, transport, exclusion_policy=policy, source_home=home).run()
            self.assertEqual(uploaded_ids(transport), {kept})
            self.assertEqual(result.held_by_policy, 2)
            self.assertEqual(len(spool.list_pending()), 2)
            self.assertEqual(list(spool.dead_letter.glob("*.json")), [])

    def test_claude_allowlist_and_exclusions(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "claude", Path(directory) / "state"
            _, allowed = claude_transcript(home)
            _, other = claude_transcript(home)
            _, excluded = claude_transcript(home)
            subagent = home / "projects" / "repo" / allowed / "subagents" / "agent-x.jsonl"
            subagent.parent.mkdir(parents=True)
            subagent.write_text(json.dumps({"sessionId": allowed, "agentId": "x"}) + "\n")
            policy = write_policy(
                directory,
                excluded_session_ids=[excluded],
                allowed_claude_session_ids=[allowed, excluded],
            )
            self.assertEqual(policy.blocked_reason("claude_code", excluded), EXCLUDED)
            self.assertEqual(policy.blocked_reason("claude_code", other), NOT_ALLOWED)
            self.assertEqual(policy.blocked_reason("claude_code", "x", allowed), NOT_ALLOWED)
            transport = SuccessTransport()
            with patch("sherlock_collector.rollout.load_policy", return_value=policy), \
                    patch("sherlock_collector.drain.load_policy", return_value=policy):
                reconcile(home, state, "claude_code", transport)
            self.assertEqual(uploaded_ids(transport), {allowed})

    def test_unreadable_policy_fails_closed_for_capture_and_upload(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / "codex", Path(directory) / "state"
            codex_rollout(home)
            reconcile(home, state, "codex", None)
            codex_rollout(home)
            path = Path(directory) / "session-exclusions.json"
            path.write_text("{not json")
            policy = load_policy(path)
            self.assertEqual(policy.blocked_reason("codex", str(uuid.uuid4())), UNREADABLE)
            transport = SuccessTransport()
            with patch("sherlock_collector.rollout.load_policy", return_value=policy), \
                    patch("sherlock_collector.drain.load_policy", return_value=policy):
                result = reconcile(home, state, "codex", transport)
            self.assertEqual(transport.items, [])
            self.assertEqual(result["pending_uploads"], 1)

    def test_missing_policy_file_changes_nothing(self):
        with TemporaryDirectory() as directory:
            policy = load_policy(Path(directory) / "absent.json")
            self.assertFalse(policy.active)
            self.assertIsNone(policy.blocked_reason("claude_code", None))

    def test_default_policy_location_follows_sherlock_home(self):
        with TemporaryDirectory() as directory:
            excluded = str(uuid.uuid4())
            (Path(directory) / "session-exclusions.json").write_text(
                json.dumps({"version": 1, "excluded_session_ids": [excluded]})
            )
            with patch.dict(os.environ, {"SHERLOCK_HOME": directory}):
                self.assertEqual(load_policy().excluded, frozenset({excluded}))


def claude_records(home, native_id, *records, project="repo", name=None):
    path = home / "projects" / project / (name or f"{native_id}.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(
        json.dumps({"sessionId": native_id, **record}).encode() + b"\n" for record in records
    ))
    return path.resolve()


def linked_worktree(main, worktree):
    """Lay out a git linked worktree the way `git worktree add` does."""
    gitdir = main / ".git" / "worktrees" / worktree.name
    gitdir.mkdir(parents=True)
    (gitdir / "commondir").write_text("../..\n")
    (gitdir / "gitdir").write_text(f"{worktree / '.git'}\n")
    worktree.mkdir(parents=True)
    (worktree / ".git").write_text(f"gitdir: {gitdir}\n")


class ProjectExclusionTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.project = self.root / "work" / "private"
        (self.project / "sub").mkdir(parents=True)
        (self.project / ".git").mkdir()
        self.sibling = self.root / "work" / "private-other"
        self.sibling.mkdir(parents=True)

    def tearDown(self):
        self.directory.cleanup()

    def policy(self, *paths):
        return write_policy(self.root, excluded_project_paths=[str(p) for p in paths])

    def run_reconcile(self, home, provider, policy):
        transport = SuccessTransport()
        with patch("sherlock_collector.rollout.load_policy", return_value=policy), \
                patch("sherlock_collector.drain.load_policy", return_value=policy):
            result = reconcile(home, self.root / "state", provider, transport)
        return transport, result

    def test_codex_sessions_in_excluded_projects_and_their_threads_are_not_collected(self):
        home = self.root / "codex"
        worktree = self.root / "worktrees" / "private-wt"
        linked_worktree(self.project, worktree)
        (worktree / "nested").mkdir()
        _, root_id = codex_rollout(home, meta={"cwd": str(self.project)})
        _, nested = codex_rollout(home, meta={"cwd": str(self.project / "sub")})
        _, in_worktree = codex_rollout(home, meta={"cwd": str(worktree / "nested")})
        # A subagent running elsewhere still descends from an excluded session.
        _, child = codex_rollout(
            home, meta={"cwd": str(self.sibling), "parent_thread_id": root_id}
        )
        _, sibling = codex_rollout(home, meta={"cwd": str(self.sibling)})
        policy = self.policy(self.project)
        transport, result = self.run_reconcile(home, "codex", policy)
        self.assertEqual(uploaded_ids(transport), {sibling})
        self.assertEqual(result["unfinished_sources"], 4)
        ledger = json.loads((self.root / "state" / "codex-reconcile.json").read_text())
        reasons = {e["native_session_id"]: e["reason"] for e in ledger["sources"].values()}
        for blocked in (root_id, nested, in_worktree, child):
            self.assertEqual(reasons[blocked], EXCLUDED_PROJECT)
        # Removing the project resumes from the untouched cursors.
        transport, _ = self.run_reconcile(home, "codex", load_policy(self.root / "absent"))
        self.assertEqual(uploaded_ids(transport), {root_id, nested, in_worktree, child})

    def test_removed_worktrees_stay_excluded(self):
        home = self.root / "codex"
        worktree = self.root / "worktrees" / "private-wt"
        linked_worktree(self.project, worktree)
        _, session = codex_rollout(home, meta={"cwd": str(worktree)})
        transport, _ = self.run_reconcile(home, "codex", self.policy(self.project))
        self.assertEqual(uploaded_ids(transport), set())
        shutil.rmtree(worktree)
        shutil.rmtree(self.project / ".git" / "worktrees")  # git worktree remove
        transport, _ = self.run_reconcile(home, "codex", self.policy(self.project))
        self.assertEqual(uploaded_ids(transport), set())
        # Without the recorded origin the removed worktree is unrecognizable.
        (self.root / "worktree-origins.json").unlink()
        transport, _ = self.run_reconcile(home, "codex", self.policy(self.project))
        self.assertEqual(uploaded_ids(transport), {session})

    def test_already_queued_codex_batches_in_excluded_projects_are_held(self):
        home, state = self.root / "codex", self.root / "state"
        _, excluded = codex_rollout(home, meta={"cwd": str(self.project)})
        _, kept = codex_rollout(home, meta={"cwd": str(self.sibling)})
        reconcile(home, state, "codex", None)
        spool = DurableSpool(state / "queue")
        transport = SuccessTransport()
        result = Drain(
            spool, transport, exclusion_policy=self.policy(self.project), source_home=home
        ).run()
        self.assertEqual(uploaded_ids(transport), {kept})
        self.assertEqual(result.held_by_policy, 1)
        self.assertEqual(len(spool.list_pending()), 1)

    def test_claude_sessions_and_subagents_in_excluded_projects_are_not_collected(self):
        home = self.root / "claude"
        excluded, kept, pending = (str(uuid.uuid4()) for _ in range(3))
        # Leading queue records carry prompt text but no working directory.
        queued = {"type": "queue-operation", "content": "x" * (2 * 1024 * 1024)}
        claude_records(home, excluded, queued, {"type": "user", "cwd": str(self.project / "sub")})
        claude_records(home, excluded, {"type": "user", "cwd": "/elsewhere", "agentId": "a"},
                       name=f"{excluded}/subagents/agent-a.jsonl")
        claude_records(home, kept, queued, {"type": "user", "cwd": str(self.sibling)})
        claude_records(home, pending, queued)
        policy = self.policy(self.project)
        self.assertEqual(policy.blocked_reason("claude_code", pending, source_home=home), UNVERIFIED)
        self.assertEqual(policy.blocked_reason("claude_code", "a", excluded, source_home=home),
                         EXCLUDED_PROJECT)
        transport, _ = self.run_reconcile(home, "claude_code", policy)
        self.assertEqual(uploaded_ids(transport), {kept})

    def test_already_queued_claude_batches_and_hook_observations_are_held(self):
        home, state = self.root / "claude", self.root / "state"
        excluded, kept = str(uuid.uuid4()), str(uuid.uuid4())
        claude_records(home, excluded, {"type": "user", "cwd": str(self.project)})
        claude_records(home, kept, {"type": "user", "cwd": str(self.sibling)})
        reconcile(home, state, "claude_code", None)
        spool = DurableSpool(state / "queue")
        transport = SuccessTransport()
        policy = self.policy(self.project)
        result = Drain(spool, transport, exclusion_policy=policy, source_home=home).run()
        self.assertEqual(uploaded_ids(transport), {kept})
        self.assertEqual(result.held_by_policy, 1)
        observation = self.root / "observation.jsonl"
        raw = json.dumps({"session_id": excluded, "cwd": str(self.project)}).encode()
        observation.write_text(json.dumps({
            "type": "claude_hook",
            "payload_base64": base64.b64encode(raw).decode(),
            "native_session_id": excluded,
        }) + "\n")
        self.assertEqual(
            policy.blocked_reason("claude_code", excluded, source_path=observation),
            EXCLUDED_PROJECT,
        )

    def test_invalid_project_entries_fail_closed(self):
        for value in (["relative/path"], [""], ["/"], "/not/a/list", [7]):
            with self.subTest(value=value):
                policy = write_policy(self.root, excluded_project_paths=value)
                self.assertEqual(policy.blocked_reason("codex", str(uuid.uuid4())), UNREADABLE)

    def test_cli_updates_keep_other_policy_fields_and_refuse_invalid_files(self):
        path = self.root / "session-exclusions.json"
        session = str(uuid.uuid4())
        path.write_text(json.dumps({"version": 1, "excluded_session_ids": [session], "other": 1}))
        with patch.dict(os.environ, {"SHERLOCK_HOME": str(self.root)}):
            self.assertEqual(update_project_exclusions(add=[f"{self.project}/"]), [str(self.project)])
            self.assertEqual(update_project_exclusions(add=[str(self.sibling)]),
                             sorted([str(self.project), str(self.sibling)]))
            self.assertEqual(update_project_exclusions(remove=[str(self.sibling)]),
                             [str(self.project)])
            self.assertEqual(excluded_project_paths(), [str(self.project)])
            policy = load_policy()
        self.assertEqual(policy.excluded, frozenset({session}))
        self.assertEqual(json.loads(path.read_text())["other"], 1)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(ValueError):
            update_project_exclusions(add=["/"], path=path)
        path.write_text("{not json")
        with self.assertRaises(ValueError):
            update_project_exclusions(add=[str(self.sibling)], path=path)
        self.assertEqual(path.read_text(), "{not json")


class InstallerSchedulerChoiceTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "sherlock_install_script", REPO / "plugins" / "sherlock" / "scripts" / "install.py"
        )
        self.install = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.install)

    def test_earlier_opt_out_survives_a_reinstall(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "sherlock").mkdir()
            (home / "sherlock" / "scheduler.json").write_text(
                json.dumps({"status": "disabled", "provider": "codex"})
            )
            with patch("sherlock_collector.scheduler.install_scheduler") as install:
                result = self.install.configure_scheduler(home, "codex", disable=False)
            install.assert_not_called()
            self.assertEqual(result["status"], "disabled")

    def test_registration_failure_is_reported_without_failing_the_install(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            with patch(
                "sherlock_collector.scheduler.install_scheduler",
                side_effect=RuntimeError("Bootstrap failed: 125"),
            ), redirect_stderr(StringIO()) as stderr:
                result = self.install.configure_scheduler(home, "codex", disable=False)
            self.assertEqual(result["status"], "failed")
            self.assertIn("Bootstrap failed", stderr.getvalue())
            stored = json.loads((home / "sherlock" / "scheduler.json").read_text())
            self.assertEqual(stored["status"], "failed")


if __name__ == "__main__":
    unittest.main()
