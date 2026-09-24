from __future__ import annotations

import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from sherlock_collector.contract import ContractError
from sherlock_collector.cursor_hook import capture
from sherlock_collector.spool import DurableSpool

ROOT = Path(__file__).resolve().parents[2]


class CursorHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spool = DurableSpool(self.root / 'queue')

    def payload(self, **overrides):
        return json.dumps({'conversation_id': 'conversation-1', 'generation_id': 'turn-1',
            'cursor_version': '1.0', **overrides}).encode()

    def test_exact_raw_bytes_and_observation_time_are_preserved(self):
        raw = b'{ "conversation_id": "conversation-1", "prompt": "hello" }'
        path = capture('beforeSubmitPrompt', raw, self.spool)
        item = self.spool.load(path)
        envelope = json.loads(gzip.decompress(item.stored_payload))
        self.assertEqual(base64.b64decode(envelope['payload_base64']), raw)
        self.assertEqual(item.manifest.source_provider, 'cursor')
        self.assertEqual(item.manifest.source_kind, 'hook')
        self.assertEqual(item.manifest.observed_native_session_id, 'cursor:conversation-1')
        self.assertEqual(item.manifest.first_occurred_at, envelope['timestamp'])

    def test_identical_distinct_invocations_are_not_conflated(self):
        first = capture('stop', self.payload(), self.spool)
        second = capture('stop', self.payload(), self.spool)
        self.assertNotEqual(first, second)
        item = self.spool.load(first)
        self.assertEqual(self.spool.enqueue(item.manifest, item.stored_payload), first)
        self.assertEqual(len(self.spool.list_pending()), 2)

    def test_child_identity_is_parent_scoped(self):
        item = self.spool.load(capture('subagentStop', self.payload(
            subagent_id='worker-1', parent_conversation_id='parent'), self.spool))
        self.assertEqual(item.manifest.observed_native_session_id, 'cursor:parent:subagent:worker-1')
        self.assertEqual(item.manifest.observed_parent_native_session_id, 'cursor:parent')

    def test_invalid_dispatch_cannot_create_a_batch(self):
        for event, raw in [('stop', b'[]'), ('unknown', self.payload()),
                           ('stop', self.payload(hook_event_name='sessionEnd')),
                           ('subagentStart', self.payload()), ('stop', b'{}')]:
            with self.assertRaises((ContractError, ValueError)):
                capture(event, raw, self.spool)
        self.assertFalse(self.spool.list_pending())

    def test_cursor_rollout_is_not_an_accepted_contract(self):
        item = self.spool.load(capture('stop', self.payload(), self.spool))
        from dataclasses import replace
        with self.assertRaises(ContractError):
            replace(item.manifest, source_kind='rollout').validate()

    def test_install_preserves_hooks_and_reinstall_is_idempotent(self):
        home = self.root / 'cursor with spaces'
        home.mkdir()
        original = {'version': 1, 'hooks': {'stop': [{'command': 'existing-hook'}]}}
        (home / 'hooks.json').write_text(json.dumps(original))
        command = [sys.executable, str(ROOT / 'plugins/sherlock-cursor/scripts/install.py'),
            '--cursor-home', str(home), '--name', 'Test User', '--github-id', 'test-user',
            '--email', 'test@e3group.ai', '--endpoint', 'http://localhost:54321/ingest']
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
        for _ in range(2):
            subprocess.run(command, check=True, capture_output=True, env=env)
        settings = json.loads((home / 'hooks.json').read_text())
        self.assertEqual(len(settings['hooks']['stop']), 2)
        self.assertEqual(settings['hooks']['stop'][0], original['hooks']['stop'][0])
        self.assertEqual((home / 'sherlock/collector.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue((home / 'sherlock/runtime/sherlock_collector/cursor_hook.py').exists())
        # A failed capture must still allow the user's action and never upload.
        for event, expected in [('subagentStart', {'permission': 'allow'}),
                                ('beforeSubmitPrompt', {'continue': True})]:
            generated = settings['hooks'][event][0]['command']
            result = subprocess.run(generated, shell=True, input=b'{}', capture_output=True, env=env)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), expected)


if __name__ == '__main__':
    unittest.main()
