import contextlib
import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.cli import main
from sherlock_collector.contract import ContractError, ReceiptMismatch
from sherlock_collector.drain import Drain, PermanentUploadError, TransientUploadError
from sherlock_collector.spool import DurableSpool
from test_collector import batch, SuccessTransport


class BlockedStreamHealthTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.spool = DurableSpool(self.root / 'state' / 'queue')
        self.config = self.root / 'collector.json'
        self.config.write_text(json.dumps({
            'endpoint': 'https://example.test/ingest', 'name': 'Test User',
            'github_id': 'test-user', 'email': 'test@example.com',
            'installation_id': '00000000-0000-4000-8000-000000000001',
        }))
        self.config.chmod(0o600)

    def health(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(['--codex-home', str(self.root / 'codex'),
                         '--state-root', str(self.root / 'state'),
                         '--config', str(self.config), 'health'])
        return code, json.loads(output.getvalue())

    def reject(self, error, *, minutes=10):
        past = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
        manifest, stored = batch('blocked')
        with patch('sherlock_collector.spool.utc_now', return_value=past):
            self.spool.enqueue(manifest, stored)
            transport = SuccessTransport()
            transport.upload = lambda item: (_ for _ in ()).throw(error)
            Drain(self.spool, transport).run()
        return past

    def test_old_permanent_rejection_degrades_health_without_discarding(self):
        self.reject(PermanentUploadError('unsupported contract'))
        code, value = self.health()
        self.assertEqual(value['status'], 'degraded')
        self.assertEqual(code, 1)
        self.assertEqual(value['pending_batches'], 1)
        self.assertGreaterEqual(value['oldest_pending_age_seconds'], 600)
        self.assertEqual(value['blocked_streams'], 1)
        self.assertEqual(list(self.spool.dead_letter.glob('*.json')), [])
        self.assertEqual(Drain(self.spool, SuccessTransport()).run().uploaded, 1)
        self.assertEqual(self.health()[1]['status'], 'ok')

    def test_transient_or_recent_rejection_does_not_mark_stuck(self):
        for error, minutes in [(TransientUploadError('offline'), 10),
                               (ReceiptMismatch('receipt mismatch'), 10),
                               (PermanentUploadError('rejected'), 0)]:
            with self.subTest(error=error):
                self.reject(error, minutes=minutes)
                self.assertEqual(self.health()[1]['status'], 'ok')
                Drain(self.spool, SuccessTransport()).run()

    def test_retries_preserve_first_permanent_rejection_time(self):
        past = self.reject(PermanentUploadError('rejected'))
        transport = SuccessTransport()
        transport.upload = lambda item: (_ for _ in ()).throw(PermanentUploadError('still rejected'))
        Drain(self.spool, transport).run()
        item = self.spool.load(self.spool.list_pending()[0])
        self.assertEqual(item.metadata['permanent_rejection_since'], past)
        self.assertEqual(self.health()[1]['status'], 'degraded')

    def test_local_contract_block_is_visible(self):
        self.reject(ContractError('conflicting receipt'))
        self.assertEqual(self.health()[1]['status'], 'degraded')

    def test_alternating_rejections_keep_original_block_until_ack(self):
        past = self.reject(PermanentUploadError('rejected'))
        for error in (TransientUploadError('offline'), PermanentUploadError('rejected again'),
                      ReceiptMismatch('mismatch'), TransientUploadError('offline again')):
            transport = SuccessTransport()
            transport.upload = lambda item: (_ for _ in ()).throw(error)
            Drain(self.spool, transport).run()
            item = self.spool.load(self.spool.list_pending()[0])
            self.assertEqual(item.metadata['permanent_rejection_since'], past)
            self.assertEqual(self.health()[1]['status'], 'degraded')
        self.assertEqual(Drain(self.spool, SuccessTransport()).run().uploaded, 1)
        self.assertEqual(self.health()[1]['status'], 'ok')
