from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "plugins" / "sherlock" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from client_installer import (
    Provider,
    arguments as installer_arguments,
    backfill,
    install_provider_runtime,
    load_config_api,
)
from install import install_runtime
from install_marketplace import register_codex_marketplace
from process_command import executable_command
from stage_marketplace import copy_marketplace


class WindowsInstallerTests(unittest.TestCase):
    def test_codex_registration_shared_helper_preserves_conflict_rules(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            marketplace = root / "marketplace"
            codex = root / "codex"
            with patch("install_marketplace.run_codex") as run:
                run.return_value = json.dumps(
                    {"marketplaces": [{"name": "sherlock", "root": str(marketplace)}]}
                )
                register_codex_marketplace(codex, marketplace)
                run.assert_called_once()

            old = root / "old"
            old_manifest = old / ".agents/plugins/marketplace.json"
            old_manifest.parent.mkdir(parents=True)
            old_manifest.write_text('{"name":"someone-else","plugins":[]}', encoding="utf-8")
            with patch("install_marketplace.run_codex") as run:
                run.return_value = json.dumps(
                    {"marketplaces": [{"name": "sherlock", "root": str(old)}]}
                )
                with self.assertRaisesRegex(SystemExit, "unverified marketplace"):
                    register_codex_marketplace(codex, marketplace)
                run.assert_called_once()

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

    def test_npm_native_executable_shim_resolves_without_a_shell(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            shim = root / "claude.cmd"
            binary = root / "node_modules/@anthropic-ai/claude-code/bin/claude.exe"
            binary.parent.mkdir(parents=True)
            binary.write_text("", encoding="utf-8")
            shim.write_text(
                '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\n',
                encoding="utf-8",
            )

            self.assertEqual(
                executable_command(shim, windows=True),
                [str(binary.resolve())],
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

    def test_invalid_backfill_hours_fail_before_any_mutation(self):
        for value in ("0", "745", "01", "1.5", "-1", "hours"):
            with self.subTest(value=value), TemporaryDirectory() as temporary:
                root = Path(temporary)
                environment = {
                    **os.environ,
                    "CODEX_BIN": sys.executable,
                    "CLAUDE_BIN": sys.executable,
                    "CODEX_HOME": str(root / "codex"),
                    "CLAUDE_CONFIG_DIR": str(root / "claude"),
                    "SHERLOCK_HOME": str(root / "marketplace"),
                }
                completed = subprocess.run(
                    [sys.executable, str(SCRIPTS / "client_installer.py"), "install",
                     "--name", "Test User", "--github", "test-user",
                     "--email", "test@e3group.ai", "--repo-root", str(ROOT),
                     "--claude-backfill-hours", value],
                    check=False, capture_output=True, text=True, env=environment,
                )
                self.assertEqual(completed.returncode, 2)
                self.assertIn("1 through 744", completed.stderr)
                self.assertEqual(list(root.iterdir()), [])

    def test_claude_backfill_default_and_custom_windows_capture_real_transcript(self):
        def run_window(root: Path, hours: int | None) -> dict[str, object]:
            effective_hours = 72 if hours is None else hours
            home = root / f"claude-{effective_hours}"
            load_config_api(ROOT)
            provider = Provider(
                "claude_code",
                Path(sys.executable),
                home,
                {
                    "name": "Test User",
                    "github_id": "test-user",
                    "email": "test@e3group.ai",
                    "installation_id": f"00000000-0000-4000-8000-{effective_hours:012d}",
                },
            )
            install_provider_runtime(ROOT, provider, "http://127.0.0.1:9/ingest")
            session_id = f"88888888-8888-4888-8888-{effective_hours:012d}"
            transcript = home / "projects/repo" / f"{session_id}.jsonl"
            transcript.parent.mkdir(parents=True)
            source = (json.dumps({"type": "user", "sessionId": session_id}) + "\n").encode()
            transcript.write_bytes(source)
            old = time.time() - 48 * 60 * 60
            os.utime(transcript, (old, old))
            command = ["installer", "--name", "Test User", "--github", "test-user",
                       "--email", "test@e3group.ai"]
            if hours is not None:
                command += ["--claude-backfill-hours", str(hours)]
            with patch("sys.argv", command):
                configured = installer_arguments().claude_backfill_hours
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                backfill(provider, claude_hours=configured)
            self.assertEqual(transcript.read_bytes(), source)
            return json.loads(output.getvalue().split(": ", 1)[1])

        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            default = run_window(root, None)
            custom = run_window(root, 24)

        self.assertEqual(default["discovered"], 1)
        self.assertGreater(default["captured_bytes"], 0)
        self.assertEqual(custom["discovered"], 0)
        self.assertEqual(custom["captured_bytes"], 0)

    def test_codex_backfill_remains_24_hours(self):
        provider = Provider("codex", Path(sys.executable), Path("codex"), {})
        result = subprocess.CompletedProcess(
            [], 0, stdout='{"status":"complete"}\n', stderr=""
        )
        with patch("client_installer.subprocess.run", return_value=result) as run:
            backfill(provider, claude_hours=744)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[arguments.index("--lookback-seconds") + 1], "86400")

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

            invalid_window = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", str(ROOT / "sherlock.ps1"), "install",
                 "-Name", "O'Brien User", "-Github", "obrien-user",
                 "-Email", "obrien@e3group.ai", "-ClaudeBackfillHours", "01"],
                check=False, capture_output=True, text=True, env=environment,
            )
            self.assertEqual(invalid_window.returncode, 2)
            self.assertIn("canonical integer", invalid_window.stderr)
            self.assertFalse((root / "Codex Home").exists())


if __name__ == "__main__":
    unittest.main()
