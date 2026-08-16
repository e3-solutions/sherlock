from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "install.sh"


FAKE_CODEX = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

capture = Path(os.environ["SHERLOCK_FAKE_CAPTURE"])

def record(value):
    with capture.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, separators=(",", ":")) + "\n")

if sys.argv[1:] == ["plugin", "marketplace", "list", "--json"]:
    existing = os.environ.get("SHERLOCK_FAKE_EXISTING_MARKETPLACE")
    marketplaces = [] if not existing else [{"name": "sherlock", "root": existing}]
    print(json.dumps({"marketplaces": marketplaces}))
    raise SystemExit(0)
if sys.argv[1:4] == ["plugin", "marketplace", "remove"]:
    record({"argv": sys.argv[1:]})
    print('{"ok":true}')
    raise SystemExit(0)
if sys.argv[1:4] == ["plugin", "marketplace", "add"]:
    record({"argv": sys.argv[1:]})
    print('{"ok":true}')
    raise SystemExit(0)
if sys.argv[1:3] == ["plugin", "add"]:
    record({"argv": sys.argv[1:]})
    print('{"ok":true}')
    raise SystemExit(0)
if sys.argv[1:] == ["--version"]:
    print("codex-test")
    raise SystemExit(0)
if sys.argv[1:] != ["app-server", "--stdio"]:
    raise SystemExit(2)

codex_home = Path(os.environ["CODEX_HOME"])
hook_file = codex_home / "plugins" / "cache" / "sherlock" / "sherlock" / "v1" / "hooks" / "hooks.json"
events = ("post_tool_use", "session_start", "user_prompt_submit", "stop")
list_count = 0
for line in sys.stdin:
    message = json.loads(line)
    request_id = message.get("id")
    method = message["method"]
    if method == "initialized":
        continue
    if method == "initialize":
        result = {"codexHome": str(codex_home)}
    elif method == "hooks/list":
        list_count += 1
        hooks = []
        for index, event in enumerate(events):
            hooks.append({
                "key": f"sherlock@sherlock:hooks/hooks.json:{event}:0:0",
                "pluginId": "sherlock@sherlock",
                "source": "plugin",
                "sourcePath": str(hook_file),
                "currentHash": f"sha256:{index + 1:064x}",
                "trustStatus": "trusted" if list_count > 1 else "untrusted",
            })
        hooks.append({
            "key": "other@market:hooks/hooks.json:stop:0:0",
            "pluginId": "other@market",
            "source": "plugin",
            "sourcePath": str(codex_home / "plugins" / "cache" / "other" / "hooks.json"),
            "currentHash": "sha256:" + "f" * 64,
            "trustStatus": "untrusted",
        })
        result = {"data": [{"cwd": os.getcwd(), "hooks": hooks, "warnings": [], "errors": []}]}
    elif method == "config/batchWrite":
        record({"batchWrite": message["params"]})
        result = {"ok": True}
    else:
        raise SystemExit(3)
    print(json.dumps({"id": request_id, "result": result}), flush=True)
'''


FAKE_PYTHON = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1].endswith("/upload-history"):
    capture = Path(os.environ["SHERLOCK_FAKE_CAPTURE"])
    with capture.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"upload_argv": sys.argv[1:]}) + "\n")
    print(json.dumps({"archive": sys.argv[-1], "batches_uploaded": 1}))
    raise SystemExit(0)

python = os.environ["SHERLOCK_REAL_PYTHON"]
os.execv(python, [python, *sys.argv[1:]])
'''


class TeamInstallerTests(unittest.TestCase):
    def test_one_command_installs_and_trusts_only_sherlock_hooks(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            fake_codex = root / "fake-codex"
            fake_python = root / "fake-python"
            capture = root / "calls.jsonl"
            history = root / "sherlock-codex-history.zip"
            old_checkout = root / "old-checkout"
            old_manifest = old_checkout / ".agents" / "plugins" / "marketplace.json"
            old_manifest.parent.mkdir(parents=True)
            old_manifest.write_text(
                json.dumps(
                    {
                        "name": "sherlock",
                        "plugins": [{"name": "sherlock"}],
                    }
                ),
                encoding="utf-8",
            )
            fake_codex.write_text(textwrap.dedent(FAKE_CODEX), encoding="utf-8")
            fake_codex.chmod(0o755)
            fake_python.write_text(textwrap.dedent(FAKE_PYTHON), encoding="utf-8")
            fake_python.chmod(0o755)
            rollout = codex_home / "sessions" / "rollout-before-install.jsonl"
            rollout.parent.mkdir(parents=True)
            rollout.write_text('{"type":"event"}\n', encoding="utf-8")
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_BIN": str(fake_codex),
                    "CODEX_HOME": str(codex_home),
                    "PYTHON_BIN": str(fake_python),
                    "SHERLOCK_REAL_PYTHON": sys.executable,
                    "SHERLOCK_FAKE_CAPTURE": str(capture),
                    "SHERLOCK_FAKE_EXISTING_MARKETPLACE": str(old_checkout),
                    "SHERLOCK_INGEST_URL": "https://example.test/functions/v1/ingest",
                }
            )

            completed = subprocess.run(
                [
                    "sh",
                    str(INSTALLER),
                    "--name",
                    "Test User",
                    "--github-id",
                    "test-user",
                    "--email",
                    "TEST@example.com",
                    "--acknowledge-sensitive-data",
                    "--upload-history",
                    "--history-output",
                    str(history),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            config = codex_home / "sherlock" / "collector.json"
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            configured = json.loads(config.read_text(encoding="utf-8"))
            self.assertEqual(configured["name"], "Test User")
            self.assertEqual(configured["github_id"], "test-user")
            self.assertEqual(configured["email"], "test@example.com")
            self.assertNotIn("token", configured)
            self.assertTrue(history.is_file())
            self.assertEqual(history.stat().st_mode & 0o777, 0o600)
            with zipfile.ZipFile(history) as archive:
                manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["session_count"], 1)
            self.assertIn("Trusted 4 Sherlock hooks", completed.stdout)
            calls = [json.loads(line) for line in capture.read_text().splitlines()]
            self.assertEqual(
                calls[0]["argv"][:4],
                ["plugin", "marketplace", "remove", "sherlock"],
            )
            self.assertEqual(
                calls[1]["argv"][:3],
                ["plugin", "marketplace", "add"],
            )
            self.assertEqual(
                calls[2]["argv"][:3],
                ["plugin", "add", "sherlock@sherlock"],
            )
            edits = calls[3]["batchWrite"]["edits"]
            self.assertEqual(len(edits), 4)
            self.assertTrue(
                all(
                    edit["keyPath"].startswith(
                        'hooks.state."sherlock@sherlock:hooks/hooks.json:'
                    )
                    for edit in edits
                )
            )
            self.assertNotIn("other@market", json.dumps(edits))
            self.assertEqual(calls[4]["upload_argv"][-1], str(history))
            self.assertIn("history upload completed", completed.stdout.lower())

            handoff = root / "admin-handoff.zip"
            handoff_completed = subprocess.run(
                [
                    "sh",
                    str(INSTALLER),
                    "--name",
                    "Test User",
                    "--github-id",
                    "test-user",
                    "--email",
                    "test@example.com",
                    "--acknowledge-sensitive-data",
                    "--history-output",
                    str(handoff),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(handoff_completed.returncode, 0, handoff_completed.stderr)
            self.assertTrue(handoff.is_file())
            self.assertIn(
                f"archive ready for administrator handoff: {handoff}".lower(),
                handoff_completed.stdout.lower(),
            )
            all_calls = [
                json.loads(line) for line in capture.read_text().splitlines()
            ]
            self.assertEqual(sum("upload_argv" in call for call in all_calls), 1)

    def test_history_export_requires_explicit_sensitive_data_consent(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            completed = subprocess.run(
                [
                    "sh",
                    str(INSTALLER),
                    "--name",
                    "Test User",
                    "--github-id",
                    "test-user",
                    "--email",
                    "test@example.com",
                ],
                cwd=ROOT,
                env={**os.environ, "CODEX_HOME": str(codex_home)},
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 2)
            self.assertIn(
                "requires --acknowledge-sensitive-data", completed.stderr
            )
            self.assertFalse((codex_home / "sherlock" / "collector.json").exists())

    def test_history_worker_counts_fail_before_export(self):
        cases = (
            (["--history-workers", "0"], "--history-workers"),
            (
                ["--upload-history", "--upload-workers", "17"],
                "--upload-workers",
            ),
        )
        for options, expected in cases:
            with self.subTest(options=options), TemporaryDirectory() as temporary:
                codex_home = Path(temporary) / "codex"
                completed = subprocess.run(
                    [
                        "sh",
                        str(INSTALLER),
                        "--name",
                        "Test User",
                        "--github-id",
                        "test-user",
                        "--email",
                        "test@example.com",
                        "--acknowledge-sensitive-data",
                        *options,
                    ],
                    cwd=ROOT,
                    env={**os.environ, "CODEX_HOME": str(codex_home)},
                    check=False,
                    capture_output=True,
                    text=True,
                )

                self.assertEqual(completed.returncode, 2)
                self.assertIn(expected, completed.stderr)
                self.assertFalse(codex_home.exists())


if __name__ == "__main__":
    unittest.main()
