"""Real subprocess conformance; no employee homes, service calls, or enrollment."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'jollyroger.json').read_text())


def snapshot(path):
    return {str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in path.rglob('*') if p.is_file()}


class JollyRogerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / 'bundle'
        for name in MANIFEST['include']:
            source, target = ROOT / name, self.bundle / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            else:
                shutil.copy2(source, target)
        self.before = snapshot(self.bundle)
        self.homes = {p: self.root / p for p in ('codex', 'claude')}
        self.states = {p + '-telemetry': str(h / 'sherlock' / 'telemetry') for p, h in self.homes.items()}
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root / 'home'),
                    'CODEX_HOME': str(self.homes['codex']), 'CLAUDE_CONFIG_DIR': str(self.homes['claude']),
                    'JOLLY_ROGER_STATE_PATHS': json.dumps(self.states),
                    'JOLLY_ROGER_MANAGED': '1', 'JOLLY_ROGER_COMPONENT_ID': 'sherlock'}
        self.protected = []
        for home in self.homes.values():
            home.mkdir()
            config = home / 'settings.json'
            config.write_text('{"trust":"retained-fixture"}')
            self.protected.append(config)
            runtime = home / 'sherlock' / 'runtime' / 'sherlock_collector'
            runtime.mkdir(parents=True)
            (runtime / '__init__.py').write_text('raise RuntimeError("WRONG_RUNTIME")')
            (runtime / 'cli.py').write_text('raise RuntimeError("WRONG_RUNTIME")')
        poison = self.root / 'poison'
        shutil.copytree(self.homes['codex'] / 'sherlock' / 'runtime', poison)
        (poison / 'sitecustomize.py').write_text('raise RuntimeError("WRONG_RUNTIME")')
        self.env.update(PYTHONPATH=str(poison), PYTHONHOME=str(poison), SHERLOCK_COLLECTOR_SOURCE=str(poison))

    def invoke(self, provider, event, payload=None, raw=None, extra_env=None):
        envelope = {'schema_version': 1, 'provider': provider, 'event': event,
                    'payload': {} if payload is None else payload}
        env = dict(self.env, JOLLY_ROGER_PROVIDER=provider)
        env.update(extra_env or {})
        result = subprocess.run([sys.executable, '-I', '-B', str(self.bundle / 'integrations/jolly-roger/hook.py')],
                                input=json.dumps(envelope) if raw is None else raw, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                cwd=self.root, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('WRONG_RUNTIME', result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(set(response), {'status'})
        return response

    def test_every_declared_pair_missing_fields_and_malformed_payload(self):
        transcripts = {}
        for provider, home in self.homes.items():
            path = home / ('projects/repo/session.jsonl' if provider == 'claude' else 'sessions/rollout-session.jsonl')
            path.parent.mkdir(parents=True)
            path.write_text('{"type":"user","sessionId":"all-events"}\n')
            transcripts[provider] = str(path)
        for hook in MANIFEST['hooks']:
            for provider in hook['providers']:
                with self.subTest(provider=provider, event=hook['event']):
                    payload = {'session_id': 'all-events', 'agent_id': 'worker', 'tool_name': 'Read',
                               'transcript_path': transcripts[provider], 'agent_transcript_path': transcripts[provider]}
                    self.assertEqual(self.invoke(provider, hook['event'], payload), {'status': 'ok'})
                    self.assertEqual(self.invoke(provider, hook['event']), {'status': 'ok'})
                    self.assertEqual(self.invoke(provider, hook['event'], payload=[]), {'status': 'skipped'})
                    self.assertEqual(self.invoke(provider, hook['event'], raw='{bad'), {'status': 'skipped'})
        time.sleep(2)  # Existing terminal children finish before fixture teardown.
        self.assertEqual(snapshot(self.bundle), self.before)
        for path in self.protected:
            self.assertEqual(path.read_text(), '{"trust":"retained-fixture"}')

    def test_real_capture_preserves_queue_and_duplicate_transcript_bytes(self):
        for provider, home in self.homes.items():
            with self.subTest(provider=provider):
                transcript = home / ('projects/repo/session.jsonl' if provider == 'claude' else 'sessions/rollout-session.jsonl')
                transcript.parent.mkdir(parents=True)
                transcript.write_text('{"type":"user","sessionId":"session-123","message":{"content":"fixture"}}\n')
                payload = {'session_id': 'session-123', 'transcript_path': str(transcript)}
                state = Path(self.states[provider + '-telemetry'])
                sentinel = state / 'existing-checkpoint-fixture'
                state.mkdir(parents=True)
                sentinel.write_bytes(b'old state retained')
                self.assertEqual(self.invoke(provider, 'Stop', payload), {'status': 'ok'})
                pending = state / 'queue' / 'pending'
                deadline = time.monotonic() + 6
                while not any(json.loads(p.read_text())['manifest']['source_kind'] in ('rollout', 'transcript')
                              for p in pending.glob('*.json')) and time.monotonic() < deadline:
                    time.sleep(.05)
                original = {p.name: p.read_bytes() for p in pending.glob('*.json')
                            if json.loads(p.read_text())['manifest']['source_kind'] in ('rollout', 'transcript')}
                self.assertTrue(original, 'real collector did not durably enqueue fixture')
                self.assertEqual(self.invoke(provider, 'Stop', payload), {'status': 'ok'})
                # Claude terminal capture is detached and settles for up to 1.5s.
                time.sleep(2)
                self.assertEqual({p.name: p.read_bytes() for p in pending.glob('*.json')
                                  if json.loads(p.read_text())['manifest']['source_kind'] in ('rollout', 'transcript')}, original)
                self.assertEqual(sentinel.read_bytes(), b'old state retained')
                self.assertFalse((home / 'sherlock' / 'collector.json').exists())
        self.assertEqual(snapshot(self.bundle), self.before)

    def test_invalid_mapping_or_provider_skips_before_state_write(self):
        self.assertEqual(self.invoke('codex', 'Stop', extra_env={'JOLLY_ROGER_STATE_PATHS': '{}'}), {'status': 'skipped'})
        self.assertEqual(self.invoke('codex', 'SessionEnd'), {'status': 'skipped'})
        self.assertEqual(self.invoke('unknown', 'Stop'), {'status': 'skipped'})
        for state in self.states.values():
            self.assertFalse(Path(state).exists())


if __name__ == '__main__':
    unittest.main()
