from pathlib import Path
from unittest.mock import patch

from tempfile import TemporaryDirectory
import unittest

from test_collector import batch, SuccessTransport
from sherlock_collector.spool import DurableSpool


class SpoolReadRetryTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.spool = DurableSpool(Path(temporary.name) / 'queue')

    def enqueue(self, stream='stream-a', start=0):
        manifest, stored = batch(stream, start)
        return manifest, self.spool.enqueue(manifest, stored)

    def test_inventory_read_error_retains_pending_and_stream_order(self):
        first, path = self.enqueue('stream-a')
        self.enqueue('stream-a', first.end_offset)
        original = Path.read_text
        failed = False

        def read(candidate, *args, **kwargs):
            nonlocal failed
            if candidate == path and not failed:
                failed = True
                raise OSError('temporary read failure')
            return original(candidate, *args, **kwargs)

        from sherlock_collector.drain import Drain
        transport = SuccessTransport()
        with patch.object(Path, 'read_text', read):
            result = Drain(self.spool, transport).run()
        self.assertTrue(failed)
        self.assertEqual(result.dead_lettered, 0)
        self.assertEqual(len(self.spool.list_pending()), 2)
        self.assertEqual(transport.items, [])
        self.assertEqual(Drain(self.spool, transport).run().uploaded, 2)

    def test_claimed_read_error_retains_pending(self):
        _, path = self.enqueue()
        original = Path.read_text

        def read(candidate, *args, **kwargs):
            if candidate.parent == self.spool.processing:
                raise OSError('temporary claimed read failure')
            return original(candidate, *args, **kwargs)

        from sherlock_collector.drain import Drain
        with patch.object(Path, 'read_text', read):
            result = Drain(self.spool, SuccessTransport()).run()
        self.assertEqual(result.dead_lettered, 0)
        self.assertTrue(path.exists())
        self.assertEqual(Drain(self.spool, SuccessTransport()).run().uploaded, 1)
