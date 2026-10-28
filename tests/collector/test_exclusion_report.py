from __future__ import annotations

import _isolation  # noqa: F401  (must precede collector imports)

import hashlib
import io
import json
import unittest
import urllib.error
import uuid
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector import exclusion_report
from sherlock_collector.config import CollectorIdentity
from sherlock_collector.contract import build_rollout_batch, build_source_batch
from sherlock_collector.drain import Drain
from sherlock_collector.exclusion_report import (
    MAX_IDS_PER_REQUEST,
    STATE_NAME,
    ExclusionReportError,
    ids_sha256,
    normalized_session_ids,
    report_exclusions,
)
from sherlock_collector.exclusions import (
    EXCLUDED_PROJECT,
    ExclusionPolicy,
    load_policy,
)
from sherlock_collector.http import HttpTransport
from sherlock_collector.spool import DurableSpool
from test_collector import SuccessTransport


IDENTITY = CollectorIdentity(
    name="Test User",
    github_id="test-user",
    email="test@example.com",
    installation_id="00000000-0000-4000-8000-000000000001",
)


class ReportingTransport(SuccessTransport):
    def __init__(self, *, fail: Exception | None = None, response=None):
        super().__init__()
        self.reports: list[list[str]] = []
        self.fail = fail
        self.response = response

    def report_exclusions(self, ids):
        self.reports.append(list(ids))
        if self.fail is not None:
            raise self.fail
        if self.response is not None:
            return self.response
        return {"accepted": len(ids), "total": len(ids)}


def policy_with(directory: Path, value) -> ExclusionPolicy:
    path = Path(directory) / "session-exclusions.json"
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return load_policy(path)


def claude_batch(stream: str):
    """A visible Claude transcript batch the policy lets through."""
    return build_source_batch(
        json.dumps({"type": "user"}).encode() + b"\n",
        source_stream_key=stream,
        generation_key="generation-test",
        generation_seq=0,
        start_offset=0,
        source_provider="claude_code",
        source_kind="transcript",
        observed_native_session_id=str(uuid.uuid4()),
    )


def state(spool: DurableSpool) -> dict | None:
    path = spool.root / STATE_NAME
    return json.loads(path.read_text()) if path.exists() else None


class NormalizationTests(unittest.TestCase):
    def test_ids_are_lowercase_canonical_uuids_deduplicated_and_sorted(self):
        a, b = sorted(str(uuid.uuid4()) for _ in range(2))
        self.assertEqual(
            normalized_session_ids(
                [b.upper(), f"  {a} ", a, "not-a-uuid", "", None, 7, a.replace("-", ""),
                 "{" + a + "}", "agent-abc123"]
            ),
            [a, b],
        )

    def test_digest_is_sha256_of_sorted_ids_joined_by_newline(self):
        ids = ["b" * 8 + "-0000-4000-8000-" + "0" * 12, "a" * 8 + "-0000-4000-8000-" + "0" * 12]
        self.assertEqual(
            ids_sha256(ids),
            hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest(),
        )


class ReportStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_report_once_then_unchanged_until_a_new_id_appears(self):
        first = str(uuid.uuid4())
        sent = []

        def send(ids):
            sent.append(ids)
            return {"accepted": len(ids), "total": len(ids)}

        self.assertEqual(report_exclusions(self.root, [first], send), "reported")
        self.assertEqual(report_exclusions(self.root, [first.upper()], send), "unchanged")
        # A shrunken set (an id removed locally) is already covered.
        self.assertEqual(report_exclusions(self.root, [], send), "none")
        second = str(uuid.uuid4())
        self.assertEqual(report_exclusions(self.root, [first, second], send), "reported")
        self.assertEqual(sent, [[first], sorted([first, second])])
        saved = json.loads((self.root / STATE_NAME).read_text())
        self.assertEqual(saved["ids"], sorted([first, second]))
        self.assertEqual(saved["sha256"], ids_sha256([first, second]))
        self.assertEqual(saved["count"], 2)
        self.assertEqual(saved["version"], 1)

    def test_more_than_the_request_limit_is_sent_in_chunks(self):
        ids = sorted(str(uuid.uuid4()) for _ in range(MAX_IDS_PER_REQUEST + 3))
        sent = []

        def send(chunk):
            sent.append(chunk)
            return {"accepted": len(chunk), "total": len(chunk)}

        self.assertEqual(report_exclusions(self.root, ids, send), "reported")
        self.assertEqual([len(chunk) for chunk in sent], [MAX_IDS_PER_REQUEST, 3])
        self.assertEqual([i for chunk in sent for i in chunk], ids)

    def test_a_failed_chunk_records_nothing_and_is_retried(self):
        ids = sorted(str(uuid.uuid4()) for _ in range(MAX_IDS_PER_REQUEST + 1))
        calls = []

        def send(chunk):
            calls.append(chunk)
            if len(calls) == 2:
                raise ExclusionReportError("down", error_code="exclusions_unavailable")
            return {"accepted": len(chunk), "total": len(chunk)}

        self.assertEqual(
            report_exclusions(self.root, ids, send), "failed:exclusions_unavailable"
        )
        self.assertFalse((self.root / STATE_NAME).exists())
        self.assertEqual(report_exclusions(self.root, ids, send), "reported")

    def test_unexpected_response_or_error_is_a_status_not_an_exception(self):
        sid = str(uuid.uuid4())
        self.assertEqual(
            report_exclusions(self.root, [sid], lambda ids: {"accepted": "1"}),
            "failed:invalid_response",
        )
        self.assertEqual(
            report_exclusions(self.root, [sid], lambda ids: {"accepted": True, "total": 1}),
            "failed:invalid_response",
        )

        def boom(ids):
            raise RuntimeError("unexpected")

        self.assertEqual(report_exclusions(self.root, [sid], boom), "failed:RuntimeError")
        self.assertFalse((self.root / STATE_NAME).exists())

    def test_damaged_state_causes_a_repeat_report_never_a_skip(self):
        sid = str(uuid.uuid4())
        (self.root / STATE_NAME).write_text(
            json.dumps({"version": 1, "ids": [sid], "sha256": "0" * 64, "count": 1})
        )
        sent = []
        report_exclusions(self.root, [sid], lambda ids: sent.append(ids) or {"accepted": 0, "total": 1})
        self.assertEqual(sent, [[sid]])


class DrainReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.spool = DurableSpool(self.root / "spool")

    def tearDown(self):
        self.tmp.cleanup()

    def test_drain_reports_excluded_ids_once_and_keeps_uploading(self):
        excluded = str(uuid.uuid4())
        policy = policy_with(
            self.root,
            {"version": 1, "excluded_session_ids": [excluded.upper(), excluded, "bogus"]},
        )
        manifest, stored = claude_batch("stream-visible")
        self.spool.enqueue(manifest, stored)
        transport = ReportingTransport()

        result = Drain(self.spool, transport, exclusion_policy=policy).run()

        self.assertEqual(result.uploaded, 1)
        self.assertEqual(result.exclusions_report, "reported")
        self.assertEqual(transport.reports, [[excluded]])
        self.assertEqual(state(self.spool)["sha256"], ids_sha256([excluded]))
        self.assertEqual(asdict(result)["exclusions_report"], "reported")

        again = Drain(self.spool, transport, exclusion_policy=policy).run()
        self.assertEqual(again.exclusions_report, "unchanged")
        self.assertEqual(len(transport.reports), 1)

    def test_project_paths_never_leave_the_machine(self):
        excluded = str(uuid.uuid4())
        private = self.root / "private-project-name"
        private.mkdir()
        policy = policy_with(
            self.root,
            {"version": 1, "excluded_session_ids": [excluded],
             "excluded_project_paths": [str(private)]},
        )
        transport = ReportingTransport()
        result = Drain(self.spool, transport, exclusion_policy=policy).run()
        self.assertEqual(result.exclusions_report, "reported")
        self.assertEqual(transport.reports, [[excluded]])
        self.assertNotIn("private-project-name", json.dumps(transport.reports))
        self.assertNotIn("private-project-name", (self.spool.root / STATE_NAME).read_text())

    def test_failed_report_never_blocks_uploads_or_records_state(self):
        excluded = str(uuid.uuid4())
        policy = policy_with(self.root, {"version": 1, "excluded_session_ids": [excluded]})
        manifest, stored = claude_batch("stream-visible")
        self.spool.enqueue(manifest, stored)
        transport = ReportingTransport(
            fail=ExclusionReportError("x", error_code="exclusions_unavailable")
        )

        result = Drain(self.spool, transport, exclusion_policy=policy).run()

        self.assertEqual(result.uploaded, 1)
        self.assertIsNone(result.collector_failure)
        self.assertEqual(result.exclusions_report, "failed:exclusions_unavailable")
        self.assertIsNone(state(self.spool))
        self.assertEqual(self.spool.list_pending(), [])

        transport.fail = None
        retried = Drain(self.spool, transport, exclusion_policy=policy).run()
        self.assertEqual(retried.exclusions_report, "reported")
        self.assertEqual(len(transport.reports), 2)

    def test_unreadable_policy_reports_nothing(self):
        policy = policy_with(self.root, "{not json")
        self.assertTrue(policy.error)
        transport = ReportingTransport()
        result = Drain(self.spool, transport, exclusion_policy=policy).run()
        self.assertEqual(result.exclusions_report, "skipped")
        self.assertEqual(transport.reports, [])

    def test_no_policy_or_no_ids_reports_nothing(self):
        transport = ReportingTransport()
        result = Drain(self.spool, transport, exclusion_policy=ExclusionPolicy()).run()
        self.assertEqual(result.exclusions_report, "none")
        self.assertEqual(transport.reports, [])

    def test_transports_without_reporting_support_are_skipped(self):
        policy = policy_with(
            self.root, {"version": 1, "excluded_session_ids": [str(uuid.uuid4())]}
        )
        result = Drain(self.spool, SuccessTransport(), exclusion_policy=policy).run()
        self.assertEqual(result.exclusions_report, "skipped")

    def test_sessions_held_for_an_excluded_project_are_reported(self):
        held = str(uuid.uuid4())
        unverified = str(uuid.uuid4())

        class ProjectPolicy(ExclusionPolicy):
            def blocked_reason(self, provider, native, parent=None, **_kwargs):
                if native == held:
                    return EXCLUDED_PROJECT
                if native == unverified:
                    return "session_ancestry_unverified"
                return None

        policy = ProjectPolicy(excluded_projects=frozenset({"/nonexistent-project"}))
        raw = json.dumps({"type": "event"}).encode() + b"\n"
        for index, native in enumerate((held, unverified, None)):
            manifest, stored = build_rollout_batch(
                raw,
                source_stream_key=f"stream-{index}",
                generation_key="generation-test",
                generation_seq=0,
                start_offset=0,
                observed_native_session_id=native,
            )
            self.spool.enqueue(manifest, stored)
        transport = ReportingTransport()

        result = Drain(self.spool, transport, exclusion_policy=policy).run()

        self.assertEqual(result.held_by_policy, 2)
        self.assertEqual(result.uploaded, 1)
        # Only definite project exclusions are reported, never unverified holds.
        self.assertEqual(transport.reports, [[held]])
        self.assertEqual(result.exclusions_report, "reported")


class HttpReportTests(unittest.TestCase):
    def test_report_posts_only_ids_with_the_collector_identity(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return json.dumps({"accepted": 1, "total": 2}).encode()

        ids = sorted(str(uuid.uuid4()) for _ in range(2))
        with patch(
            "sherlock_collector.http.urllib.request.urlopen", return_value=Response()
        ) as urlopen:
            value = HttpTransport("https://example.test/ingest", IDENTITY).report_exclusions(ids)

        self.assertEqual(value, {"accepted": 1, "total": 2})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.test/ingest")
        self.assertEqual(request.get_method(), "POST")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(
            json.loads(request.data),
            {"op": "exclusions", "collector": IDENTITY.to_dict(), "excluded_session_ids": ids},
        )

    def test_http_errors_carry_the_server_code(self):
        error = urllib.error.HTTPError(
            "https://example.test/ingest", 503, "unavailable", {},
            io.BytesIO(json.dumps({"error": {"code": "exclusions_unavailable",
                                             "message": "not deployed"}}).encode()),
        )
        with patch("sherlock_collector.http.urllib.request.urlopen", side_effect=error):
            with self.assertRaises(ExclusionReportError) as raised:
                HttpTransport("https://example.test/ingest", IDENTITY).report_exclusions(
                    [str(uuid.uuid4())]
                )
        self.assertEqual(raised.exception.error_code, "exclusions_unavailable")

        bare = urllib.error.HTTPError(
            "https://example.test/ingest", 502, "bad gateway", {}, io.BytesIO(b"<html>")
        )
        with patch("sherlock_collector.http.urllib.request.urlopen", side_effect=bare):
            with self.assertRaises(ExclusionReportError) as raised:
                HttpTransport("https://example.test/ingest", IDENTITY).report_exclusions(
                    [str(uuid.uuid4())]
                )
        self.assertEqual(raised.exception.error_code, "http_502")

    def test_network_failures_and_bad_json_are_report_errors(self):
        with patch(
            "sherlock_collector.http.urllib.request.urlopen",
            side_effect=urllib.error.URLError("offline"),
        ):
            with self.assertRaises(ExclusionReportError) as raised:
                HttpTransport("https://example.test/ingest", IDENTITY).report_exclusions(
                    [str(uuid.uuid4())]
                )
        self.assertEqual(raised.exception.error_code, "transport")

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return b"[1]"

        with patch("sherlock_collector.http.urllib.request.urlopen", return_value=Response()):
            with self.assertRaises(ExclusionReportError) as raised:
                HttpTransport("https://example.test/ingest", IDENTITY).report_exclusions(
                    [str(uuid.uuid4())]
                )
        self.assertEqual(raised.exception.error_code, "invalid_response")


if __name__ == "__main__":
    unittest.main()
