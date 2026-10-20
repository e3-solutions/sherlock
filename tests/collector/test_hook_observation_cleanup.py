import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.claude_hook import write_observation
from sherlock_collector.rollout import RolloutCapturer
from sherlock_collector.spool import DurableSpool


class HookObservationCleanupTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.spool = DurableSpool(self.root / 'queue')
        self.capturer = RolloutCapturer(
            self.root, self.spool, source_provider='claude_code',
            source_kind='hook', state_name='claude-hook',
            capture_unterminated_tail=False,
        )

    def observation(self):
        return write_observation(self.root, 'Stop', {'session_id': 'test'},
                                 b'{"session_id":"test"}', transcript_path=None)

    def test_500_observations_leave_no_files_or_cursor_history(self):
        paths = [self.observation() for _ in range(500)]
        result = self.capturer.capture(paths, max_files=500)
        self.assertEqual(result.enqueued, 500)
        self.assertEqual(list((self.root / 'claude-hook-events').glob('*.jsonl')), [])
        for path in (self.capturer.state_path, self.capturer.state_backup_path):
            self.assertEqual(json.loads(path.read_text())['streams'], {})
            self.assertLess(path.stat().st_size, 100)
        self.assertEqual(len(self.spool.list_pending()), 500)

    def test_enqueue_fsync_failure_preserves_observation_for_retry(self):
        path = self.observation()
        with patch('sherlock_collector.spool.os.fsync', side_effect=OSError('fsync failed')):
            with self.assertRaises(OSError):
                self.capturer.capture([path])
        self.assertTrue(path.exists())
        self.assertEqual(self.capturer.capture([path]).enqueued, 1)
        self.assertFalse(path.exists())

    def test_cursor_failure_after_enqueue_is_replayable(self):
        path = self.observation()
        with patch.object(self.capturer, '_save_state', side_effect=OSError('crash')):
            with self.assertRaises(OSError):
                self.capturer.capture([path])
        self.assertTrue(path.exists())
        self.capturer.capture([path])
        self.assertFalse(path.exists())
        self.assertEqual(len(self.spool.list_pending()), 1)

    def test_missing_observation_prunes_stale_state(self):
        path = self.observation()
        with patch('sherlock_collector.rollout._durable_unlink', create=True,
                   side_effect=OSError('unlink failed')):
            # The pre-fix implementation also leaves a durable cursor here.
            self.capturer.capture([path], best_effort=True)
        path.unlink()
        self.capturer.capture([])
        self.assertEqual(json.loads(self.capturer.state_path.read_text())['streams'], {})
