"""Owner session markers for shared folders (markers.py)."""

from __future__ import annotations

import _isolation  # noqa: F401  (must precede collector imports)

import json
import os
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.drain import Drain
from sherlock_collector.exclusions import UNREADABLE, load_policy
from sherlock_collector.markers import EXCLUDED_MARKER, MARKER_UNVERIFIED, STATE_NAME
from sherlock_collector.spool import DurableSpool
from test_exclusion_report import ReportingTransport, claude_batch


def line(record: dict) -> str:
    return json.dumps(record) + "\n"


def user(text: str, cwd: str) -> dict:
    return {"type": "user", "cwd": cwd, "message": {"role": "user", "content": text}}


def tool(path: str) -> dict:
    return {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": path}}]},
    }


class MarkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        base = Path(self.tmp.name)
        self.sherlock = base / "sherlock"
        self.sherlock.mkdir()
        self.claude = base / "claude"
        self.project = self.claude / "projects" / "-work"
        self.project.mkdir(parents=True)
        self.app = base / "app" / "account" / "org"
        self.app.mkdir(parents=True)
        self.work = str(base / "work")
        os.makedirs(self.work)
        self.private = str(base / "private-repo")
        os.makedirs(self.private)
        self.env = patch.dict(os.environ, {"SHERLOCK_CLAUDE_APP_SESSIONS": str(base / "app")})
        self.env.start()
        self.policy_value = {
            "version": 1,
            "excluded_project_paths": [self.private],
            "marker_scoped_project_paths": [self.work],
            "excluded_session_markers": ["Aeyron", "facebook"],
        }

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def policy(self, **changes):
        value = {**self.policy_value, **changes}
        path = self.sherlock / "session-exclusions.json"
        path.write_text(json.dumps(value))
        return load_policy(path)

    def session(self, *records: dict, cwd: str | None = None) -> str:
        sid = str(uuid.uuid4())
        cwd = cwd or self.work
        body = [user("hello", cwd)] if not records else list(records)
        (self.project / f"{sid}.jsonl").write_text("".join(line(r) for r in body))
        return sid

    def app_record(self, sid: str, title: str | None = "Company work", **extra) -> str:
        local = f"local_{uuid.uuid4()}"
        record = {"sessionId": local, "cliSessionId": sid, "cwd": self.work, **extra}
        if title is not None:
            record["title"] = title
        (self.app / f"{local}.json").write_text(json.dumps(record))
        return local

    def subagent(self, root: str, *records: dict) -> tuple[str, Path]:
        agent = uuid.uuid4().hex[:17]
        directory = self.project / root / "subagents"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"agent-{agent}.jsonl"
        path.write_text("".join(line(r) for r in records))
        return agent, path

    def reason(self, policy, sid: str, parent: str | None = None, path: Path | None = None):
        source = path or (self.project / f"{sid}.jsonl")
        return policy.blocked_reason(
            "claude_code", sid, parent, source_home=self.claude, source_path=source
        )

    # -- app records -----------------------------------------------------
    def test_marker_in_app_title_excludes_and_is_remembered_and_reported(self):
        sid = self.session()
        self.app_record(sid, "Aeyron Facebook reply check (hourly)")
        policy = self.policy()
        self.assertEqual(self.reason(policy, sid), EXCLUDED_MARKER)
        self.assertEqual(policy.marker_excluded_ids(), {sid})
        # Sticky: still excluded after the title changes.
        for record in self.app.glob("*.json"):
            record.unlink()
        self.app_record(sid, "Renamed")
        self.assertEqual(self.reason(self.policy(), sid), EXCLUDED_MARKER)

    def test_company_session_with_a_title_is_captured(self):
        sid = self.session()
        self.app_record(sid, "Sesh: reliable storage")
        self.assertIsNone(self.reason(self.policy(), sid))

    def test_spawned_or_forked_from_a_marked_session_is_excluded(self):
        parent = self.session()
        local = self.app_record(parent, "Aeyron project context")
        child = self.session()
        self.app_record(child, "Garmin", spawnedFrom={"sessionId": local, "title": "x"})
        fork = self.session()
        self.app_record(fork, "Side chat", forkedFromSessionId=local)
        policy = self.policy()
        self.assertEqual(self.reason(policy, child), EXCLUDED_MARKER)
        self.assertEqual(self.reason(policy, fork), EXCLUDED_MARKER)

    def test_scheduled_task_name_is_a_marker(self):
        sid = self.session()
        self.app_record(sid, "Remind me: read the letter", scheduledTaskId="aeyron-remind-letter")
        self.assertEqual(self.reason(self.policy(), sid), EXCLUDED_MARKER)

    def test_missing_app_record_title_or_ancestor_is_held(self):
        no_record = self.session()
        untitled = self.session()
        self.app_record(untitled, None)
        orphan = self.session()
        self.app_record(orphan, "Side chat", forkedFromSessionId="local_missing")
        policy = self.policy()
        self.assertEqual(self.reason(policy, no_record), MARKER_UNVERIFIED)
        self.assertEqual(self.reason(policy, untitled), MARKER_UNVERIFIED)
        self.assertEqual(self.reason(policy, orphan), MARKER_UNVERIFIED)

    # -- transcripts -----------------------------------------------------
    def test_first_prompt_marker_excludes_but_a_later_mention_does_not(self):
        first = self.session(user("Draft the Aeyron grant letter", self.work))
        later = self.session(user("Fix the Sesh sync", self.work), user("is aeyron hidden?", self.work))
        wrapped = self.session(
            user("<command-name>/clear</command-name>", self.work),
            user("Plan the facebook outreach", self.work),
        )
        for sid in (first, later, wrapped):
            self.app_record(sid)
        policy = self.policy()
        self.assertEqual(self.reason(policy, first), EXCLUDED_MARKER)
        self.assertIsNone(self.reason(policy, later))
        self.assertEqual(self.reason(policy, wrapped), EXCLUDED_MARKER)

    def test_tool_paths_count_only_inside_an_excluded_project(self):
        inside = self.session(user("go", self.work), tool(os.path.join(self.private, "aeyron", "a.md")))
        outside = self.session(user("go", self.work), tool(os.path.join(self.work, "notes", "aeyron-not-e3.md")))
        for sid in (inside, outside):
            self.app_record(sid)
        policy = self.policy()
        self.assertEqual(self.reason(policy, inside), EXCLUDED_MARKER)
        self.assertIsNone(self.reason(policy, outside))

    def test_title_record_in_the_transcript_is_a_marker(self):
        sid = self.session(user("go", self.work), {"type": "custom-title", "customTitle": "Aeyron voice"})
        self.app_record(sid)
        self.assertEqual(self.reason(self.policy(), sid), EXCLUDED_MARKER)

    def test_marker_appended_later_is_found_on_the_next_run(self):
        sid = self.session(user("go", self.work))
        self.app_record(sid)
        self.assertIsNone(self.reason(self.policy(), sid))
        with open(self.project / f"{sid}.jsonl", "a") as handle:
            handle.write(line({"type": "custom-title", "customTitle": "Aeyron pharma"}))
        self.assertEqual(self.reason(self.policy(), sid), EXCLUDED_MARKER)

    def test_unterminated_last_line_is_held_until_complete(self):
        sid = self.session(user("go", self.work))
        self.app_record(sid)
        with open(self.project / f"{sid}.jsonl", "a") as handle:
            handle.write('{"type": "custom-title", "customTitle": "Aey')
        self.assertEqual(self.reason(self.policy(), sid), MARKER_UNVERIFIED)

    def test_subagent_marker_excludes_only_that_subagent(self):
        root = self.session(user("Sesh work", self.work))
        self.app_record(root, "Sesh work")
        marked, marked_path = self.subagent(root, user("Read the Aeyron notes", self.work))
        clean, clean_path = self.subagent(root, user("Run the tests", self.work))
        policy = self.policy()
        self.assertEqual(self.reason(policy, marked, root, marked_path), EXCLUDED_MARKER)
        self.assertIsNone(self.reason(policy, clean, root, clean_path))
        self.assertIsNone(self.reason(self.policy(), root))
        self.assertEqual(self.policy().marker_excluded_ids(), set())
        self.assertEqual(self.reason(self.policy(), marked, root, marked_path), EXCLUDED_MARKER)

    def test_subagents_of_a_marked_root_are_excluded(self):
        root = self.session()
        self.app_record(root, "Aeyron website")
        agent, path = self.subagent(root, user("Run the tests", self.work))
        self.assertEqual(self.reason(self.policy(), agent, root, path), EXCLUDED_MARKER)

    def test_marker_in_a_wrapped_slash_command_before_the_first_prompt(self):
        sid = self.session(
            user("<command-name>/aeyron-plan</command-name>", self.work),
            user("go on", self.work),
        )
        self.app_record(sid)
        self.assertEqual(self.reason(self.policy(), sid), EXCLUDED_MARKER)

    def test_changed_markers_read_everything_again(self):
        sid = self.session(user("Plan the garmin sync", self.work))
        self.app_record(sid)
        self.assertIsNone(self.reason(self.policy(), sid))
        markers = self.policy_value["excluded_session_markers"] + ["garmin"]
        self.assertEqual(
            self.reason(self.policy(excluded_session_markers=markers), sid), EXCLUDED_MARKER
        )

    def test_subagent_without_its_own_transcript_is_held(self):
        root = self.session()
        self.app_record(root, "Sesh work")
        policy = self.policy(excluded_project_paths=[])  # the marker rule alone
        reason = policy.blocked_reason("claude_code", "a" * 17, root, source_home=self.claude)
        self.assertEqual(reason, MARKER_UNVERIFIED)

    def test_excluded_subagent_stays_excluded_after_its_transcript_is_gone(self):
        root = self.session(user("Sesh work", self.work))
        self.app_record(root, "Sesh work")
        agent, path = self.subagent(root, user("Read the Aeyron notes", self.work))
        self.assertEqual(self.reason(self.policy(), agent, root, path), EXCLUDED_MARKER)
        path.unlink()
        policy = self.policy(excluded_project_paths=[])  # the marker rule alone
        reason = policy.blocked_reason("claude_code", agent, root, source_home=self.claude)
        self.assertEqual(reason, EXCLUDED_MARKER)

    def test_hook_observations_are_classified_by_the_session_transcript(self):
        root = self.session(user("Sesh work", self.work))
        self.app_record(root, "Sesh work")
        agent, _ = self.subagent(root, user("Read the Aeyron notes", self.work))
        observation = Path(self.tmp.name) / "observation.json"
        observation.write_text(json.dumps({"payload": "e30="}) + "\n")
        reason = self.policy(excluded_project_paths=[]).blocked_reason(
            "claude_code", agent, root, source_home=self.claude,
            source_path=observation, source_kind="hook",
        )
        self.assertEqual(reason, EXCLUDED_MARKER)

    def test_non_ascii_markers_are_rejected(self):
        policy = self.policy(excluded_session_markers=["Ärzte"])
        self.assertEqual(self.reason(policy, self.session()), UNREADABLE)

    # -- scope and configuration ----------------------------------------
    def test_sessions_outside_the_scoped_folder_are_not_classified(self):
        sub = os.path.join(self.work, "repo")
        os.makedirs(sub)
        sid = self.session(user("Aeyron in a company repo", sub))
        self.assertIsNone(self.reason(self.policy(), sid))

    def test_allowed_sessions_skip_markers(self):
        sid = self.session(user("Check the Aeyron exclusions", self.work))
        self.app_record(sid)
        policy = self.policy(marker_allowed_session_ids=[sid])
        self.assertIsNone(self.reason(policy, sid))

    def test_codex_sessions_in_the_scoped_folder_are_held(self):
        policy = self.policy()
        self.assertEqual(
            policy.blocked_reason("codex", str(uuid.uuid4()), observed_cwds=[self.work]),
            MARKER_UNVERIFIED,
        )

    def test_invalid_configuration_fails_closed(self):
        for change in (
            {"excluded_session_markers": []},
            {"excluded_session_markers": ["ab"]},
            {"marker_scoped_project_paths": ["relative"]},
            {"marker_allowed_session_ids": ["not-a-uuid"]},
        ):
            self.assertEqual(self.reason(self.policy(**change), self.session()), UNREADABLE)

    def test_unreadable_state_holds(self):
        sid = self.session()
        self.app_record(sid)
        (self.sherlock / STATE_NAME).write_text("{")
        self.assertEqual(self.reason(self.policy(), sid), MARKER_UNVERIFIED)

    def test_without_markers_nothing_changes(self):
        sid = self.session(user("Aeyron", self.work))
        value = {"version": 1, "excluded_session_ids": []}
        path = self.sherlock / "session-exclusions.json"
        path.write_text(json.dumps(value))
        self.assertIsNone(self.reason(load_policy(path), sid))

    def test_drain_reports_marker_excluded_roots(self):
        sid = self.session()
        self.app_record(sid, "Aeyron outreach")
        policy = self.policy()
        self.assertEqual(self.reason(policy, sid), EXCLUDED_MARKER)
        spool = DurableSpool(Path(self.tmp.name) / "spool")
        manifest, stored = claude_batch("stream-visible")
        spool.enqueue(manifest, stored)
        transport = ReportingTransport()
        drain_policy = self.policy()
        with patch.object(type(drain_policy), "blocked_reason", return_value=None):
            result = Drain(spool, transport, exclusion_policy=drain_policy).run()
        self.assertEqual(result.exclusions_report, "reported")
        self.assertEqual(transport.reports, [[sid]])


if __name__ == "__main__":
    unittest.main()
