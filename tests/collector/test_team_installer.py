from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "install.sh"
CLAUDE_INSTALLER = ROOT / "install-claude.sh"
UNIFIED_INSTALLER = ROOT / "sherlock"


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
events = (
    "post_compact",
    "post_tool_use",
    "session_start",
    "stop",
    "subagent_start",
    "subagent_stop",
    "user_prompt_submit",
)
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


FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

capture = Path(os.environ["SHERLOCK_FAKE_CAPTURE"])
claude_home = Path(os.environ["CLAUDE_CONFIG_DIR"])
marketplace = claude_home / "fake-marketplace-installed"

def record(value):
    with capture.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, separators=(",", ":")) + "\n")

if sys.argv[1:] == ["--version"]:
    print("2.0.59 (Claude Code)")
    raise SystemExit(0)
if sys.argv[1:3] == ["plugin", "validate"]:
    assert Path(sys.argv[3]).exists()
    record({"argv": sys.argv[1:]})
    print("Validation passed")
    raise SystemExit(0)
if sys.argv[1:4] == ["plugin", "marketplace", "remove"]:
    record({"argv": sys.argv[1:]})
    marketplace.unlink(missing_ok=True)
    raise SystemExit(0)
if sys.argv[1:4] == ["plugin", "marketplace", "add"]:
    if marketplace.exists():
        raise SystemExit(1)
    record({"argv": sys.argv[1:]})
    marketplace.parent.mkdir(parents=True, exist_ok=True)
    marketplace.touch()
    raise SystemExit(0)
if sys.argv[1:3] == ["plugin", "install"]:
    record({"argv": sys.argv[1:]})
    settings = claude_home / "settings.json"
    settings.write_text(json.dumps({
        "enabledPlugins": {"sherlock-claude-code@sherlock": True}
    }), encoding="utf-8")
    raise SystemExit(0)
raise SystemExit(2)
'''


class TeamInstallerTests(unittest.TestCase):
    def test_unified_command_installs_codex_and_claude_with_same_identity(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            claude_home = root / "claude"
            sherlock_home = root / "sherlock-home"
            fake_codex = root / "fake-codex"
            fake_claude = root / "fake-claude"
            capture = root / "calls.jsonl"
            fake_codex.write_text(textwrap.dedent(FAKE_CODEX), encoding="utf-8")
            fake_codex.chmod(0o755)
            fake_claude.write_text(textwrap.dedent(FAKE_CLAUDE), encoding="utf-8")
            fake_claude.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_BIN": str(fake_codex),
                    "CODEX_HOME": str(codex_home),
                    "CLAUDE_BIN": str(fake_claude),
                    "CLAUDE_CONFIG_DIR": str(claude_home),
                    "SHERLOCK_HOME": str(sherlock_home),
                    "PYTHON_BIN": sys.executable,
                    "SHERLOCK_FAKE_CAPTURE": str(capture),
                    "SHERLOCK_INGEST_URL": "https://example.test/functions/v1/ingest",
                }
            )

            completed = subprocess.run(
                [
                    "sh",
                    str(UNIFIED_INSTALLER),
                    "install",
                    "--name",
                    "Unified User",
                    "--github",
                    "unified-user",
                    "--email",
                    "UNIFIED@example.com",
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn(
                "Sherlock is installed for Codex and Claude Code",
                completed.stdout,
            )
            for config in (
                codex_home / "sherlock" / "collector.json",
                claude_home / "sherlock" / "collector.json",
            ):
                configured = json.loads(config.read_text(encoding="utf-8"))
                self.assertEqual(configured["name"], "Unified User")
                self.assertEqual(configured["github_id"], "unified-user")
                self.assertEqual(configured["email"], "unified@example.com")

            calls = [json.loads(line) for line in capture.read_text().splitlines()]
            marketplace_root = sherlock_home / "marketplace"
            self.assertEqual(
                {path.name for path in marketplace_root.iterdir()},
                {".agents", ".claude-plugin", "plugins"},
            )
            self.assertTrue(
                (marketplace_root / "plugins" / "sherlock" / "hooks").is_dir()
            )
            self.assertTrue(
                (
                    marketplace_root
                    / "plugins"
                    / "sherlock-claude-code"
                    / "hooks"
                ).is_dir()
            )
            marketplace_adds = [
                call["argv"]
                for call in calls
                if call.get("argv", [])[:3] == ["plugin", "marketplace", "add"]
            ]
            self.assertEqual(len(marketplace_adds), 2)
            self.assertTrue(
                all(
                    Path(arguments[3]).resolve() == marketplace_root.resolve()
                    for arguments in marketplace_adds
                )
            )
            self.assertTrue(
                any(call.get("argv", [])[:2] == ["plugin", "add"] for call in calls)
            )
            self.assertTrue(
                any(
                    call.get("argv", [])[:2] == ["plugin", "install"]
                    for call in calls
                )
            )

    def test_unified_command_preflights_both_agents_before_installing(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            fake_codex = root / "fake-codex"
            fake_codex.write_text(textwrap.dedent(FAKE_CODEX), encoding="utf-8")
            fake_codex.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_BIN": str(fake_codex),
                    "CODEX_HOME": str(codex_home),
                    "CLAUDE_BIN": str(root / "missing-claude"),
                    "PYTHON_BIN": sys.executable,
                    "SHERLOCK_FAKE_CAPTURE": str(root / "calls.jsonl"),
                }
            )

            completed = subprocess.run(
                [
                    "sh",
                    str(UNIFIED_INSTALLER),
                    "install",
                    "--name",
                    "Unified User",
                    "--github-id",
                    "unified-user",
                    "--email",
                    "unified@example.com",
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 1)
            self.assertIn("CLAUDE_BIN is not executable", completed.stderr)
            self.assertFalse((codex_home / "sherlock").exists())

    def test_unified_command_rejects_unusable_agent_before_installing(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            fake_codex = root / "fake-codex"
            fake_claude = root / "not-claude"
            fake_codex.write_text(textwrap.dedent(FAKE_CODEX), encoding="utf-8")
            fake_codex.chmod(0o755)
            fake_claude.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            fake_claude.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_BIN": str(fake_codex),
                    "CODEX_HOME": str(codex_home),
                    "CLAUDE_BIN": str(fake_claude),
                    "PYTHON_BIN": sys.executable,
                    "SHERLOCK_FAKE_CAPTURE": str(root / "calls.jsonl"),
                }
            )

            completed = subprocess.run(
                [
                    "sh",
                    str(UNIFIED_INSTALLER),
                    "install",
                    "--name",
                    "Unified User",
                    "--github",
                    "unified-user",
                    "--email",
                    "unified@example.com",
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 1)
            self.assertIn("Claude Code CLI is not usable", completed.stderr)
            self.assertFalse((codex_home / "sherlock").exists())

    def test_one_command_installs_and_trusts_only_sherlock_hooks(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            fake_codex = root / "fake-codex"
            capture = root / "calls.jsonl"
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
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_BIN": str(fake_codex),
                    "CODEX_HOME": str(codex_home),
                    "PYTHON_BIN": sys.executable,
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
            self.assertIn("Trusted 7 Sherlock hooks", completed.stdout)
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
            self.assertEqual(len(edits), 7)
            self.assertTrue(
                all(
                    edit["keyPath"].startswith(
                        'hooks.state."sherlock@sherlock:hooks/hooks.json:'
                    )
                    for edit in edits
                )
            )
            self.assertNotIn("other@market", json.dumps(edits))

    def test_one_command_installs_claude_plugin_and_runtime(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            claude_home = root / "claude"
            fake_claude = root / "fake-claude"
            capture = root / "claude-calls.jsonl"
            fake_claude.write_text(textwrap.dedent(FAKE_CLAUDE), encoding="utf-8")
            fake_claude.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "CLAUDE_BIN": str(fake_claude),
                    "CLAUDE_CONFIG_DIR": str(claude_home),
                    "PYTHON_BIN": sys.executable,
                    "SHERLOCK_FAKE_CAPTURE": str(capture),
                    "SHERLOCK_INGEST_URL": "https://example.test/functions/v1/ingest",
                }
            )

            command = [
                "sh",
                str(CLAUDE_INSTALLER),
                "--name",
                "Test User",
                "--github-id",
                "test-user",
                "--email",
                "TEST@example.com",
            ]
            completed = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
            repeated = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            self.assertIn("Claude Code 24-hour backfill", completed.stdout)
            self.assertIn('"status": "complete"', completed.stdout)
            config = claude_home / "sherlock" / "collector.json"
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            configured = json.loads(config.read_text(encoding="utf-8"))
            self.assertEqual(configured["email"], "test@example.com")
            self.assertTrue(
                (
                    claude_home
                    / "sherlock"
                    / "runtime"
                    / "sherlock_collector"
                    / "cli.py"
                ).is_file()
            )
            self.assertTrue(
                (
                    claude_home
                    / "sherlock"
                    / "telemetry"
                    / "claude-transcript-state.json"
                ).is_file()
            )
            calls = [json.loads(line)["argv"] for line in capture.read_text().splitlines()]
            self.assertEqual(calls[0][:2], ["plugin", "validate"])
            self.assertEqual(calls[1][:2], ["plugin", "validate"])
            self.assertEqual(calls[2][:3], ["plugin", "marketplace", "remove"])
            self.assertEqual(
                calls[3][:3],
                ["plugin", "marketplace", "add"],
            )
            self.assertEqual(
                calls[4],
                ["plugin", "install", "sherlock-claude-code@sherlock"],
            )
            self.assertEqual(
                sum(call[:3] == ["plugin", "marketplace", "remove"] for call in calls),
                2,
            )
            self.assertEqual(
                sum(call[:2] == ["plugin", "install"] for call in calls),
                2,
            )


if __name__ == "__main__":
    unittest.main()
