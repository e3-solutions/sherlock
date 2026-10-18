from __future__ import annotations

import json
import os
import plistlib
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.scheduler import (
    install_scheduler,
    scheduler_files,
    scheduler_id,
    scheduler_status,
    uninstall_scheduler,
)


class SchedulerTests(unittest.TestCase):
    def test_launchagent_is_low_priority_and_pins_provider_home(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for provider in ("codex", "claude_code"):
                home = root / f"{provider} home 'quoted'"
                files = scheduler_files(
                    home, provider, root / "user", "Darwin", "/path/to/python3"
                )
                plist = plistlib.loads(
                    next(
                        data for path, data in files.items() if path.suffix == ".plist"
                    )
                )
                self.assertEqual(plist["StartInterval"], 900)
                self.assertEqual(plist["Nice"], 10)
                self.assertTrue(plist["LowPriorityIO"])
                self.assertTrue(plist["RunAtLoad"])
                self.assertEqual(plist["ProgramArguments"][0], "/path/to/python3")
                self.assertEqual(plist["ProgramArguments"][1], "-I")
                script = files[
                    home.resolve() / "sherlock" / "bin" / "reconcile.py"
                ].decode()
                self.assertIn(repr(str(home.resolve())), script)
                self.assertIn(repr(provider), script)
                self.assertIn("'reconcile'", script)
                self.assertFalse((root / "user").exists())

    def test_systemd_units_escape_paths_and_use_relative_interval(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home = root / 'home %h $value "quoted"'
            files = scheduler_files(
                home, "codex", root / "user", "Linux", sys.executable
            )
            service = next(
                data.decode()
                for path, data in files.items()
                if path.suffix == ".service"
            )
            timer = next(
                data.decode() for path, data in files.items() if path.suffix == ".timer"
            )
            self.assertIn("Nice=10", service)
            self.assertIn('%%h $$value \\"quoted\\"', service)
            self.assertIn("OnUnitInactiveSec=15m", timer)
            self.assertIn("Persistent=true", timer)

    def test_launchagent_install_reinstall_uninstall_are_idempotent(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, user = root / "provider", root / "user"
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run:
                first = install_scheduler(
                    home, "claude_code", user_home=user, system="Darwin"
                )
                second = install_scheduler(
                    home, "claude_code", user_home=user, system="Darwin"
                )
                self.assertEqual(first, second)
                self.assertEqual(
                    len(list((user / "Library" / "LaunchAgents").glob("*.plist"))), 1
                )
                self.assertEqual(scheduler_status(home)["status"], "installed")
                self.assertEqual(
                    sum(call.args[0][1] == "bootstrap" for call in run.call_args_list),
                    2,
                )
                uninstall_scheduler(
                    home, "claude_code", user_home=user, system="Darwin"
                )
                uninstall_scheduler(
                    home, "claude_code", user_home=user, system="Darwin"
                )
                self.assertEqual(scheduler_status(home)["status"], "disabled")
                self.assertEqual(
                    list((user / "Library" / "LaunchAgents").glob("*.plist")), []
                )

    def test_systemd_install_and_uninstall(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, user = root / "provider", root / "user"
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ) as run:
                result = install_scheduler(
                    home, "codex", user_home=user, system="Linux"
                )
                self.assertEqual(result["kind"], "systemd")
                self.assertIn(
                    ["systemctl", "--user", "enable", "--now", result["id"] + ".timer"],
                    [call.args[0] for call in run.call_args_list],
                )
                uninstall_scheduler(home, "codex", user_home=user, system="Linux")
                self.assertEqual(
                    list((user / ".config" / "systemd" / "user").glob("*")), []
                )

    def test_linux_cron_fallback_preserves_unrelated_jobs_and_deduplicates(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, user = root / "provider % home", root / "user"
            cron = "5 1 * * * echo keep-me\n"

            def fake_run(command, *, input=None):
                nonlocal cron
                if command[0] == "systemctl":
                    return subprocess.CompletedProcess(command, 1, "", "no user bus")
                if command == ["crontab", "-l"]:
                    return subprocess.CompletedProcess(command, 0, cron, "")
                self.assertEqual(command, ["crontab", "-"])
                cron = input
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("sherlock_collector.scheduler._run", side_effect=fake_run):
                first = install_scheduler(home, "codex", user_home=user, system="Linux")
                install_scheduler(home, "codex", user_home=user, system="Linux")
                self.assertEqual(first["kind"], "cron")
                self.assertEqual(cron.count("*/15"), 1)
                self.assertIn("keep-me", cron)
                self.assertIn(r"\%", cron)
                self.assertIn("/usr/bin/nice -n 10", cron)
                self.assertEqual(
                    len(list((user / ".config" / "systemd" / "user").glob("*"))), 0
                )
                uninstall_scheduler(home, "codex", user_home=user, system="Linux")
                self.assertEqual(cron, "5 1 * * * echo keep-me\n")

    def test_homes_and_providers_have_distinct_entries(self):
        root = Path("/tmp/unused-scheduler-generation")
        ids = {
            scheduler_id(root / home, provider)
            for home in ("a", "b")
            for provider in ("codex", "claude_code")
        }
        self.assertEqual(len(ids), 4)

    def test_status_reports_missing_files(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ):
                result = install_scheduler(
                    home / "provider", "codex", user_home=home / "user", system="Darwin"
                )
            Path(result["files"][0]).unlink()
            self.assertEqual(
                scheduler_status(home / "provider")["status"], "missing_files"
            )

    def test_status_checks_scheduler_registration_without_modifying_it(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home = root / "provider"
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ):
                install_scheduler(
                    home, "codex", user_home=root / "user", system="Darwin"
                )
                self.assertEqual(
                    scheduler_status(home, check_loaded=True)["status"], "installed"
                )
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 1, "", "not loaded"),
            ) as run:
                self.assertEqual(
                    scheduler_status(home, check_loaded=True)["status"], "not_loaded"
                )
                self.assertEqual(run.call_args.args[0][0:2], ["launchctl", "print"])

    def test_failed_activation_does_not_report_previous_install_as_healthy(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home = root / "provider"
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ):
                install_scheduler(
                    home, "codex", user_home=root / "user", system="Darwin"
                )
            with patch(
                "sherlock_collector.scheduler._run",
                return_value=subprocess.CompletedProcess([], 1, "", "load failed"),
            ):
                with self.assertRaisesRegex(RuntimeError, "load failed"):
                    install_scheduler(
                        home, "codex", user_home=root / "user", system="Darwin"
                    )
            self.assertEqual(scheduler_status(home)["status"], "installing")

    def test_generated_runner_works_without_environment_from_shell(self):
        # Run only the generated Python runner. Never register an OS scheduler.
        with TemporaryDirectory() as directory:
            import shutil

            root = Path(directory).resolve()
            home = root / "provider home"
            package = (
                Path(__file__).resolve().parents[2]
                / "packages"
                / "telemetry-collector"
                / "src"
                / "sherlock_collector"
            )
            shutil.copytree(
                package, home / "sherlock" / "runtime" / "sherlock_collector"
            )
            files = scheduler_files(
                home, "claude_code", root / "user", "Darwin", sys.executable
            )
            runner = home / "sherlock" / "bin" / "reconcile.py"
            runner.parent.mkdir(parents=True)
            runner.write_bytes(files[runner])
            result = subprocess.run(
                [sys.executable, "-I", str(runner)],
                cwd=root,
                env={"PATH": os.defpath},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 78, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["provider"], "claude_code")
            self.assertEqual(report["status"], "partial")
            self.assertTrue(
                (
                    home / "sherlock" / "telemetry" / "claude_code-reconcile.json"
                ).is_file()
            )
