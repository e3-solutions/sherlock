"""Real subprocess protocol tests, including buffered notifications and EOF."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'plugins/sherlock/scripts/trust_hooks.py'
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location('sherlock_trust_hooks', SCRIPT)
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)


class TrustTransportTests(unittest.TestCase):
    def server(self, root: Path, behavior: str):
        # Use the real interpreter as the executable; app-server and --stdio
        # become Python options only via this tiny executable wrapper.
        source = root / 'fake server.py'
        source.write_text(
            '#!' + sys.executable + '\n'
            'import sys, json, time\n'
            'for line in sys.stdin:\n'
            '    request=json.loads(line)\n'
            + behavior,
            encoding='utf-8',
        )
        if os.name == 'nt':
            # Exercise the supported npm shim shape with a real Node launcher;
            # Python's stdin/stdout pipes remain the protocol under test.
            node = shutil.which('node.exe')
            self.assertIsNotNone(node, 'Windows transport tests require Node.js')
            js = root / 'server.js'
            js.write_text(
                'const {spawnSync}=require("node:child_process");\n'
                + 'process.exit(spawnSync(' + json.dumps(sys.executable) + ','
                + json.dumps([str(source)]) + ',{stdio:"inherit"}).status ?? 1);\n',
                encoding='utf-8',
            )
            launcher = root / 'server.cmd'
            launcher.write_text('@echo off\r\nnode "%~dp0\\server.js" %*\r\n')
        else:
            launcher = source
            launcher.chmod(0o700)
        return trust.AppServer(launcher, codex_home=root, cwd=root)

    def test_buffered_notification_malformed_and_response_in_one_write(self):
        with tempfile.TemporaryDirectory(prefix='sherlock trust ') as temporary:
            with self.server(Path(temporary),
                '    print("not JSON\\n[]\\n" + json.dumps({"method":"notice"}) + "\\n" + json.dumps({"id":request["id"],"result":{"ok":True}}), flush=True)\n'
            ) as server:
                self.assertEqual(server.request(1, 'initialize', {}), {'ok': True})
                self.assertEqual(server.request(2, 'hooks/list', {}), {'ok': True})

    def test_eof_and_timeout_are_bounded_errors(self):
        with tempfile.TemporaryDirectory(prefix='sherlock trust ') as temporary:
            with self.server(Path(temporary), '    sys.exit(0)\n') as server:
                with self.assertRaisesRegex(trust.AppServerError, 'exited'):
                    server.request(1, 'initialize', {})
            with self.server(Path(temporary), '    time.sleep(0.3)\n') as server:
                with patch.object(trust, 'REQUEST_TIMEOUT_SECONDS', 0.05):
                    with self.assertRaisesRegex(trust.AppServerError, 'timed out'):
                        server.request(1, 'initialize', {})

    def test_only_matching_cache_hook_can_be_trusted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hook = {'pluginId':'sherlock@sherlock', 'source':'plugin',
                    'sourcePath':str(root / 'plugins/cache/sherlock/hooks/hooks.json'),
                    'key':'sherlock@sherlock:Stop', 'currentHash':'sha256:abc',
                    'eventName':'stop', 'command':'python Stop'}
            manifest = Path(hook['sourcePath'])
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'hooks':{'Stop':[{'hooks':[
                {'commandWindows':'python Stop'}]}]}}), encoding='utf-8')
            result = {'data':[{'hooks':[hook]}]}
            self.assertEqual(trust.sherlock_hooks(result, root), [hook])
            if os.name == 'nt':
                hook['command'] = 'sh -c false'
                with self.assertRaisesRegex(trust.AppServerError, 'commandWindows'):
                    trust.sherlock_hooks(result, root)
                hook['command'] = 'python Stop'
            hook['sourcePath'] = str(root / 'other/hooks.json')
            with self.assertRaisesRegex(trust.AppServerError, 'outside'):
                trust.sherlock_hooks(result, root)


if __name__ == '__main__':
    unittest.main()
