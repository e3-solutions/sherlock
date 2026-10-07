from __future__ import annotations

import json
import os
import sqlite3
import time
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.discovery import discover_rollouts
from sherlock_collector.hook import run_hook
from sherlock_collector.spool import DurableSpool
from sherlock_collector.drain import Drain
from sherlock_collector.inventory import collection_inventory
from sherlock_collector.rollout import RolloutCapturer
from test_collector import receipt


def native_database(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute('create table threads (id text primary key, rollout_path text, updated_at integer, archived integer, thread_source text)')
        db.executemany('insert into threads values (?,?,?,?,?)', rows)
    db.close()


def source_file(home, native_id, records=None):
    path = home / 'sessions' / f'rollout-{native_id}.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    values = [{'type': 'session_meta', 'payload': {'id': native_id}}, *(records or [])]
    path.write_text(''.join(json.dumps(value) + '\n' for value in values))
    return path


class CodexInventoryTests(unittest.TestCase):
    def test_unattributed_receipt_cannot_prove_native_session_delivery(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            native_id = str(uuid.uuid4())
            path = source_file(home, native_id)
            spool = DurableSpool(state / 'queue')
            RolloutCapturer(state, spool, allowed_root=home).capture([path])
            transport = type('Transport', (), {'upload': lambda self, item: receipt(item.manifest)})()
            Drain(spool, transport).run()
            report = collection_inventory(home, state, session_id=native_id)
            self.assertEqual(report['status'], 'partial')
            self.assertEqual(report['sources'][0]['status'], 'pending')

    def test_shared_path_does_not_hide_conflicting_native_row(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            native_id, conflict_id = str(uuid.uuid4()), str(uuid.uuid4())
            path = source_file(home, native_id)
            native_database(home / 'state.sqlite', [
                (native_id, str(path), int(time.time()), 0, 'user'),
                (conflict_id, str(path), int(time.time()) - 1, 0, 'automation'),
            ])
            report = collection_inventory(home, state)
            rows = {row['native_session_id']: row for row in report['sources']}
            self.assertEqual(set(rows), {native_id, conflict_id})
            self.assertEqual(rows[conflict_id]['reason'], 'native_identity_conflict')
            self.assertEqual(report['status'], 'partial')

    def test_empty_or_missing_home_does_not_claim_coverage(self):
        with TemporaryDirectory() as directory:
            home = Path(directory) / 'missing'
            self.assertEqual(collection_inventory(home, Path(directory) / 'state')['status'], 'partial')
            home.mkdir()
            self.assertEqual(collection_inventory(home, Path(directory) / 'state')['status'], 'partial')

    def test_exact_lookup_survives_unsupported_timestamp_schema(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            native_id = str(uuid.uuid4())
            path = source_file(home, native_id)
            with sqlite3.connect(home / 'state.sqlite') as db:
                db.execute('create table threads (id text, rollout_path text)')
                db.execute('insert into threads values (?,?)', (native_id, str(path)))
            db.close()
            result = discover_rollouts(home, hook_payload={'session_id': native_id})
            self.assertEqual(result.paths, (path.resolve(),))
            self.assertTrue(result.errors)

    def test_appended_bytes_need_their_own_receipt(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            native_id = str(uuid.uuid4())
            path = source_file(home, native_id)
            spool = DurableSpool(state / 'queue')
            capture = RolloutCapturer(state, spool, allowed_root=home)
            transport = type('Transport', (), {'upload': lambda self, item: receipt(item.manifest)})()
            capture.capture([path], native_session_ids={str(path.resolve()): native_id})
            Drain(spool, transport).run()
            old_size = path.stat().st_size
            with path.open('ab') as handle:
                handle.write(b'{"type":"event_msg","payload":{"type":"task_complete"}}\n')
            pending = collection_inventory(home, state, session_id=native_id)['sources'][0]
            self.assertEqual(pending['status'], 'pending')
            self.assertEqual(pending['receipted_prefix_bytes'], old_size)
            capture.capture([path], native_session_ids={str(path.resolve()): native_id})
            Drain(spool, transport).run()
            self.assertEqual(collection_inventory(home, state, session_id=native_id)['status'], 'complete')

    def test_all_native_source_categories_and_archived_tasks_are_collected(self):
        with TemporaryDirectory() as directory:
            home = Path(directory) / 'codex'
            rows = []
            for kind in ['automation', 'guardian_review', 'agent_created_thread', 'realtime_voice', 'future_source']:
                native_id = str(uuid.uuid4())
                path = source_file(home, native_id)
                rows.append((native_id, str(path), int(time.time()), 1, kind))
            native_database(home / 'state_5.sqlite', rows)
            result = discover_rollouts(home)
            self.assertEqual(set(result.native_session_ids.values()), {row[0] for row in rows})
            with patch('sherlock_collector.hook._spawn_drain'):
                outcome = run_hook('PostToolUse', {'session_id': rows[0][0]}, codex_home=home,
                                   state_root=Path(directory) / 'state', drain_command=['unused'])
            self.assertEqual(outcome.enqueued, 5)

    def test_exact_continuing_id_bypasses_age_row_and_database_limits(self):
        with TemporaryDirectory() as directory:
            home = Path(directory) / 'codex'
            native_id = str(uuid.uuid4())
            target = source_file(home, native_id)
            now = int(time.time())
            native_database(home / 'state_0.sqlite', [(native_id, str(target), now - 7 * 86400, 1, 'automation')])
            os.utime(home / 'state_0.sqlite', (1, 1))
            for index in range(1, 10):
                other_id = str(uuid.uuid4())
                other = source_file(home, other_id)
                native_database(home / f'state_{index}.sqlite', [(other_id, str(other), now, 0, 'user')])
            result = discover_rollouts(home, hook_payload={'session_id': native_id}, rows_per_database=1)
            self.assertEqual(result.paths[0], target.resolve())
            self.assertEqual(result.native_session_ids[str(target.resolve())], native_id)

    def test_explicit_reconciliation_finds_old_automation_without_any_hook(self):
        with TemporaryDirectory() as directory:
            home = Path(directory) / 'codex'
            native_id, other_id = str(uuid.uuid4()), str(uuid.uuid4())
            target = source_file(home, native_id)
            other = source_file(home, other_id)
            native_database(home / 'state_5.sqlite', [
                (native_id, str(target), 1, 1, 'automation'),
                (other_id, str(other), int(time.time()), 0, 'user'),
            ])
            result = discover_rollouts(home, replay_session_id=native_id, scan_recent_files=True)
            self.assertEqual(result.paths, (target.resolve(),))

    def test_source_audit_requires_byte_matching_durable_receipts(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            native_id = str(uuid.uuid4())
            path = source_file(home, native_id, [{'type': 'event_msg', 'payload': {
                'type': 'token_count', 'info': {'total_token_usage': {'total_tokens': 0}}
            }}])
            native_database(home / 'state_5.sqlite', [(native_id, str(path), 1, 1, 'automation')])
            report = collection_inventory(home, state, session_id=native_id)
            self.assertEqual(report['status'], 'partial')
            self.assertEqual(report['sources'][0]['status'], 'pending')
            self.assertEqual(report['sources'][0]['token_payload']['presence'], 'present')
            self.assertFalse(state.exists(), 'inventory must not create capture or queue state')
            original = path.read_bytes()
            spool = DurableSpool(state / 'queue')
            capture = RolloutCapturer(state, spool, allowed_root=home)
            capture.capture([path], native_session_ids={str(path.resolve()): native_id})
            transport = type('Transport', (), {'upload': lambda self, item: receipt(item.manifest)})()
            self.assertEqual(Drain(spool, transport).run().uploaded, 1)
            received = collection_inventory(home, state, session_id=native_id)
            self.assertEqual(received['status'], 'complete')
            self.assertEqual(received['sources'][0]['status'], 'received')
            self.assertEqual(path.read_bytes(), original)
            # Same path/length is insufficient after source bytes change.
            path.write_bytes(original.replace(b'"total_tokens": 0', b'"total_tokens": 9'))
            changed = collection_inventory(home, state, session_id=native_id)
            self.assertEqual(changed['sources'][0]['status'], 'pending')
            self.assertEqual(changed['sources'][0]['receipted_prefix_bytes'], 0)

    def test_missing_files_and_policy_exclusions_remain_distinct(self):
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            home.mkdir()
            missing, outside = str(uuid.uuid4()), str(uuid.uuid4())
            native_database(home / 'state_5.sqlite', [
                (missing, str(home / 'sessions' / 'rollout-missing.jsonl'), int(time.time()), 0, 'user'),
                (outside, str(Path(directory) / 'rollout-outside.jsonl'), int(time.time()), 0, 'automation'),
            ])
            report = collection_inventory(home, state)
            rows = {row['native_session_id']: row for row in report['sources']}
            self.assertEqual(rows[missing]['status'], 'unresolved')
            self.assertEqual(rows[missing]['reason'], 'source_file_missing')
            self.assertEqual(rows[outside]['status'], 'unresolved')
            self.assertEqual(rows[outside]['reason'], 'unsupported_root')
            self.assertEqual(report['status'], 'partial')
            excluded = collection_inventory(home, state, session_id=outside)
            self.assertEqual(excluded['status'], 'partial')

    def test_codex_exact_backfill_enqueues_without_hooks_and_does_not_claim_delivery(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from sherlock_collector.cli import main
        with TemporaryDirectory() as directory:
            home, state = Path(directory) / 'codex', Path(directory) / 'state'
            native_id = str(uuid.uuid4())
            path = source_file(home, native_id)
            native_database(home / 'state_5.sqlite', [(native_id, str(path), 1, 1, 'automation')])
            output = StringIO()
            with patch('sherlock_collector.hook._spawn_drain'), redirect_stdout(output):
                code = main(['--codex-home', str(home), '--state-root', str(state),
                             'backfill', '--session-id', native_id])
            value = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual(value['enqueued'], 1)
            self.assertEqual(value['delivery_status'], 'unverified')
            self.assertEqual(value['completion_basis'], 'local_capture_only')
            pending = DurableSpool(state / 'queue').list_pending()
            self.assertEqual(len(pending), 1)


if __name__ == '__main__':
    unittest.main()
