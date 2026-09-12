from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "plugins" / "sherlock" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from client_installer import Provider, install_provider_runtime, load_config_api
from install import install_runtime
from process_command import executable_command
from stage_marketplace import copy_marketplace


class WindowsInstallerTests(unittest.TestCase):
    def test_windows_stage_pins_exact_python_and_preserves_source_manifests(self):
        with TemporaryDirectory() as temporary:
            destination = Path(temporary) / "durable marketplace"
            python = Path(r"C:\People\O'Brien\Python 3.11\python.exe")
            source_codex = (ROOT / "plugins/sherlock/hooks/hooks.json").read_bytes()
            source_claude = (ROOT / "plugins/sherlock-claude-code/hooks/hooks.json").read_bytes()

            copy_marketplace(ROOT, destination, windows_python=python)

            self.assertEqual((ROOT / "plugins/sherlock/hooks/hooks.json").read_bytes(), source_codex)
            self.assertEqual((ROOT / "plugins/sherlock-claude-code/hooks/hooks.json").read_bytes(), source_claude)
            codex = json.loads((destination / "plugins/sherlock/hooks/hooks.json").read_text())
            for event, groups in codex["hooks"].items():
                command = groups[0]["hooks"][0]["commandWindows"]
                encoded = command.rsplit(" ", 1)[1]
                decoded = base64.b64decode(encoded).decode("utf-16-le")
                self.assertIn("C:\\People\\O''Brien\\Python 3.11\\python.exe", decoded)
                self.assertIn("$env:PLUGIN_ROOT", decoded)
                self.assertIn(f"'{event}'", decoded)
                self.assertIn("sh -c", groups[0]["hooks"][0]["command"])
            claude = json.loads((destination / "plugins/sherlock-claude-code/hooks/hooks.json").read_text())
            for event, groups in claude["hooks"].items():
                handler = groups[0]["hooks"][0]
                self.assertEqual(handler["command"], str(python))
                self.assertEqual(handler["args"], ["${CLAUDE_PLUGIN_ROOT}/scripts/run_hook.py", event])

            # The staged copy is complete and does not refer back to the checkout.
            self.assertTrue((destination / "plugins/sherlock/scripts/run_hook.py").is_file())
            self.assertTrue((destination / "plugins/sherlock-claude-code/scripts/run_hook.py").is_file())

    def test_standard_npm_cmd_shim_resolves_without_a_shell(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            shim = root / "codex.cmd"
            script = root / "node_modules/@openai/codex/bin/codex.js"
            node = root / "node.exe"
            script.parent.mkdir(parents=True)
            script.write_text("", encoding="utf-8")
            node.write_text("", encoding="utf-8")
            shim.write_text('@"%~dp0\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n', encoding="utf-8")

            self.assertEqual(
                executable_command(shim, windows=True),
                [str(node), str(script.resolve())],
            )

    def test_all_identity_preflight_happens_before_marketplace_or_home_write(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex home"
            claude_home = root / "claude home"
            marketplace = root / "sherlock home"
            environment = {
                **os.environ,
                "CODEX_BIN": sys.executable,
                "CLAUDE_BIN": sys.executable,
                "CODEX_HOME": str(codex_home),
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "SHERLOCK_HOME": str(marketplace),
            }
            completed = subprocess.run(
                [sys.executable, str(SCRIPTS / "client_installer.py"), "install",
                 "--name", "Invalid User", "--github", "invalid-user",
                 "--email", "invalid@example.com", "--repo-root", str(ROOT)],
                check=False, capture_output=True, text=True, env=environment,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("work domain", completed.stderr)
            self.assertFalse(codex_home.exists())
            self.assertFalse(claude_home.exists())
            self.assertFalse(marketplace.exists())

    def test_reinstall_preserves_installation_id_and_queued_bytes(self):
        with TemporaryDirectory() as temporary:
            home = Path(temporary) / "provider home"
            load_config_api(ROOT)
            identity = {
                "name": "Windows User", "github_id": "windows-user",
                "email": "windows-ci@e3group.ai",
                "installation_id": "00000000-0000-4000-8000-000000000001",
            }
            provider = Provider("codex", Path(sys.executable), home, identity)
            install_provider_runtime(ROOT, provider, "https://example.test/ingest")
            queue = home / "sherlock/telemetry/queue/pending/immutable.json"
            queue.parent.mkdir(parents=True)
            queue.write_bytes(b'{"raw":"unchanged"}\n')

            install_provider_runtime(ROOT, provider, "https://example.test/ingest")

            configured = json.loads((home / "sherlock/collector.json").read_text())
            self.assertEqual(configured["installation_id"], identity["installation_id"])
            self.assertEqual(queue.read_bytes(), b'{"raw":"unchanged"}\n')

    def test_interrupted_runtime_swap_restores_only_valid_backup(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "runtime"
            backup = root / ".runtime.previous"
            source.mkdir()
            backup.mkdir()
            (source / "version.txt").write_text("new", encoding="utf-8")
            (backup / "version.txt").write_text("old", encoding="utf-8")

            install_runtime(source, destination)

            self.assertEqual((destination / "version.txt").read_text(), "new")
            self.assertFalse(backup.exists())

    def test_interrupted_marketplace_swap_restores_backup_before_refresh(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "marketplace"
            backup = root / ".marketplace.previous"
            backup.mkdir()
            (backup / "old-marker.txt").write_text("recoverable", encoding="utf-8")

            incomplete_source = root / "incomplete"
            incomplete_source.mkdir()
            with self.assertRaises(SystemExit):
                copy_marketplace(incomplete_source, destination)

            self.assertEqual(
                (destination / "old-marker.txt").read_text(), "recoverable"
            )
            self.assertFalse(backup.exists())

    @unittest.skipUnless(os.name == "nt", "requires native Windows PowerShell")
    def test_powershell_bootstrap_keeps_arguments_atomic_before_preflight(self):
        with TemporaryDirectory(prefix="Sherlock O'Brien ") as temporary:
            root = Path(temporary)
            environment = {
                **os.environ,
                "PYTHON_BIN": sys.executable,
                "CODEX_BIN": sys.executable,
                "CLAUDE_BIN": sys.executable,
                "CODEX_HOME": str(root / "Codex Home"),
                "CLAUDE_CONFIG_DIR": str(root / "Claude Home"),
                "SHERLOCK_HOME": str(root / "Sherlock Home"),
            }
            completed = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", str(ROOT / "sherlock.ps1"), "install",
                 "-Name", "O'Brien User", "-Github", "obrien-user",
                 "-Email", "invalid@example.com"],
                check=False, capture_output=True, text=True, env=environment,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("work domain", completed.stderr)
            self.assertFalse((root / "Codex Home").exists())
            self.assertFalse((root / "Claude Home").exists())
            self.assertFalse((root / "Sherlock Home").exists())


if __name__ == "__main__":
    unittest.main()
