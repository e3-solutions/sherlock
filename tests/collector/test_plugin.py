from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sherlock_collector.config import ConfigurationError, load_config
from sherlock_collector.discovery import discover_rollouts
from sherlock_collector.hook import run_hook


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "telemetry-collector" / "src"
LAUNCHER = ROOT / "plugins" / "sherlock" / "scripts" / "run_hook.py"
INSTALLER = ROOT / "plugins" / "sherlock" / "scripts" / "install.py"
HOOKS = ROOT / "plugins" / "sherlock" / "hooks" / "hooks.json"
IDENTITY_CONFIG = {
    "name": "Test User",
    "github_id": "test-user",
    "email": "test@example.com",
    "installation_id": "00000000-0000-4000-8000-000000000001",
}


def create_threads_database(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            """
            create table threads (
              id text primary key,
              rollout_path text not null,
              updated_at integer not null,
              updated_at_ms integer,
              archived integer not null default 0,
              thread_source text
            )
            """
        )
        connection.executemany(
            """
            insert into threads (
              id, rollout_path, updated_at, updated_at_ms, archived, thread_source
            ) values (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["id"],
                    str(row["rollout_path"]),
                    int(
                        row.get("updated_at")
                        or (int(row["updated_at_ms"]) // 1000)
                    ),
                    row["updated_at_ms"],
                    row.get("archived", 0),
                    row.get("thread_source", "user"),
                )
                for row in rows
            ],
        )
        connection.commit()
    finally:
        connection.close()


class DiscoveryTests(unittest.TestCase):
    def test_discovers_recent_unarchived_rollouts_without_history_scan(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            sessions = codex_home / "sessions" / "2026" / "08" / "15"
            sessions.mkdir(parents=True)
            recent = sessions / "rollout-recent.jsonl"
            old = sessions / "rollout-old.jsonl"
            archived = sessions / "rollout-archived.jsonl"
            for path in (recent, old, archived):
                path.write_text('{"type":"event"}\n', encoding="utf-8")
            now_ms = int(time.time() * 1000)
            create_threads_database(
                codex_home / "state_5.sqlite",
                [
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": recent,
                        "updated_at_ms": now_ms,
                    },
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": old,
                        "updated_at_ms": now_ms - 48 * 60 * 60 * 1000,
                    },
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": archived,
                        "updated_at_ms": now_ms,
                        "archived": 1,
                    },
                ],
            )

            result = discover_rollouts(codex_home)

            self.assertEqual(result.paths, (recent.resolve(),))
            self.assertEqual(len(result.native_session_ids), 1)
            self.assertEqual(result.errors, ())

    def test_hook_payload_path_is_available_before_sqlite_registration(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            rollout = (
                codex_home
                / "sessions"
                / "2026"
                / "08"
                / "15"
                / "rollout-live.jsonl"
            )
            rollout.parent.mkdir(parents=True)
            rollout.write_text('{"type":"event"}\n', encoding="utf-8")
            session_id = str(uuid.uuid4())

            result = discover_rollouts(
                codex_home,
                hook_payload={
                    "session_id": session_id,
                    "transcript_path": str(rollout),
                },
            )

            self.assertEqual(result.paths, (rollout.resolve(),))
            self.assertEqual(
                result.native_session_ids[str(rollout.resolve())], session_id
            )

    def test_payload_path_is_prioritized_and_outside_files_are_rejected(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home = root / "codex"
            sessions = codex_home / "sessions" / "2026" / "08" / "15"
            sessions.mkdir(parents=True)
            current = sessions / "rollout-current.jsonl"
            recent = sessions / "rollout-recent.jsonl"
            outside = root / "rollout-outside.jsonl"
            for path in (current, recent, outside):
                path.write_text('{"type":"event"}\n', encoding="utf-8")
            create_threads_database(
                codex_home / "state_5.sqlite",
                [
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": recent,
                        "updated_at_ms": int(time.time() * 1000) + 10_000,
                    },
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": outside,
                        "updated_at_ms": int(time.time() * 1000) + 20_000,
                    },
                ],
            )

            result = discover_rollouts(
                codex_home,
                hook_payload={"transcript_path": str(current)},
            )

            self.assertEqual(result.paths, (current.resolve(), recent.resolve()))

    def test_legacy_row_with_null_millisecond_timestamp_is_discovered(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            rollout = (
                codex_home
                / "sessions"
                / "2026"
                / "08"
                / "15"
                / "rollout-legacy.jsonl"
            )
            rollout.parent.mkdir(parents=True)
            rollout.write_text('{"type":"event"}\n', encoding="utf-8")
            create_threads_database(
                codex_home / "state_5.sqlite",
                [
                    {
                        "id": str(uuid.uuid4()),
                        "rollout_path": rollout,
                        "updated_at": int(time.time()),
                        "updated_at_ms": None,
                    }
                ],
            )

            result = discover_rollouts(codex_home)

            self.assertEqual(result.paths, (rollout.resolve(),))


class ConfigurationTests(unittest.TestCase):
    def test_owner_only_config_loads_and_group_readable_config_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "collector.json"
            path.write_text(
                json.dumps(
                    {
                        "endpoint": "https://example.test/functions/v1/ingest",
                        "token": "opaque-test-token",
                        **IDENTITY_CONFIG,
                    }
                ),
                encoding="utf-8",
            )
            path.chmod(0o600)

            loaded = load_config(path)

            self.assertEqual(
                loaded.endpoint,
                "https://example.test/functions/v1/ingest",
            )
            self.assertEqual(loaded.token, "opaque-test-token")
            self.assertEqual(loaded.identity.email, "test@example.com")
            path.chmod(0o640)
            with self.assertRaisesRegex(ConfigurationError, "owner-only"):
                load_config(path)

    def test_partial_environment_configuration_is_rejected(self):
        cases = (
            {"SHERLOCK_INGEST_URL": "https://example.test/ingest"},
            {"SHERLOCK_INGEST_TOKEN": "opaque-test-token"},
        )
        for environment in cases:
            with self.subTest(environment=sorted(environment)):
                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(ConfigurationError, "set together"):
                        load_config()

    def test_installer_copies_runtime_and_never_prints_token(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            environment = os.environ.copy()
            environment["SHERLOCK_INGEST_TOKEN"] = "opaque-installer-token"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER),
                    "--endpoint",
                    "https://example.test/functions/v1/ingest",
                    "--codex-home",
                    str(codex_home),
                    "--name",
                    "Test User",
                    "--github-id",
                    "test-user",
                    "--email",
                    "TEST@example.com",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

            config = codex_home / "sherlock" / "collector.json"
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertTrue(
                (
                    codex_home
                    / "sherlock"
                    / "runtime"
                    / "sherlock_collector"
                    / "cli.py"
                ).is_file()
            )
            self.assertNotIn("opaque-installer-token", completed.stdout)
            self.assertNotIn("opaque-installer-token", completed.stderr)
            installed = json.loads(config.read_text(encoding="utf-8"))
            self.assertEqual(installed["email"], "test@example.com")
            self.assertEqual(installed["github_id"], "test-user")
            self.assertEqual(
                uuid.UUID(installed["installation_id"]).version,
                4,
            )

    def test_installer_rejects_invalid_endpoint_before_writing_config(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            environment = os.environ.copy()
            environment["SHERLOCK_INGEST_TOKEN"] = "opaque-installer-token"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER),
                    "--endpoint",
                    "http://example.test/ingest",
                    "--codex-home",
                    str(codex_home),
                    "--name",
                    "Test User",
                    "--github-id",
                    "test-user",
                    "--email",
                    "test@example.com",
                ],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((codex_home / "sherlock" / "collector.json").exists())
            self.assertNotIn("opaque-installer-token", completed.stdout)
            self.assertNotIn("opaque-installer-token", completed.stderr)

    def test_installer_reuses_the_machine_installation_id(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            environment = os.environ.copy()
            environment["SHERLOCK_INGEST_TOKEN"] = "opaque-installer-token"
            command = [
                sys.executable,
                str(INSTALLER),
                "--endpoint",
                "https://example.test/functions/v1/ingest",
                "--codex-home",
                str(codex_home),
                "--name",
                "Test User",
                "--github-id",
                "test-user",
                "--email",
                "test@example.com",
            ]

            subprocess.run(command, check=True, capture_output=True, env=environment)
            config = codex_home / "sherlock" / "collector.json"
            first = json.loads(config.read_text(encoding="utf-8"))["installation_id"]
            subprocess.run(command, check=True, capture_output=True, env=environment)
            second = json.loads(config.read_text(encoding="utf-8"))["installation_id"]

            self.assertEqual(first, second)


class HookCompanionTests(unittest.TestCase):
    def test_configured_hook_commands_are_fail_open(self):
        hooks = json.loads(HOOKS.read_text(encoding="utf-8"))["hooks"]
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            script = (
                codex_home
                / "plugins"
                / "cache"
                / "marketplace"
                / "sherlock"
                / "test-version"
                / "scripts"
                / "run_hook.py"
            )
            script.parent.mkdir(parents=True)
            script.write_text("raise SystemExit(9)\n", encoding="utf-8")
            environment = os.environ.copy()
            environment["CODEX_HOME"] = str(codex_home)

            for event_name, entries in hooks.items():
                with self.subTest(event_name=event_name):
                    command = entries[0]["hooks"][0]["command"]
                    completed = subprocess.run(
                        command,
                        shell=True,
                        check=False,
                        capture_output=True,
                        text=True,
                        env=environment,
                    )
                    self.assertEqual(completed.returncode, 0)


class HookIntegrationTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path]:
        codex_home = root / "codex"
        rollout = (
            codex_home
            / "sessions"
            / "2026"
            / "08"
            / "15"
            / "rollout-test.jsonl"
        )
        rollout.parent.mkdir(parents=True)
        rollout.write_text(
            '{"type":"event_msg","timestamp":"2026-08-15T00:00:00Z"}\n',
            encoding="utf-8",
        )
        create_threads_database(
            codex_home / "state_5.sqlite",
            [
                {
                    "id": str(uuid.uuid4()),
                    "rollout_path": rollout,
                    "updated_at_ms": int(time.time() * 1000),
                }
            ],
        )
        return codex_home, rollout

    def test_exact_launcher_returns_quickly_when_network_is_down(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            config_dir = codex_home / "sherlock"
            config_dir.mkdir(parents=True)
            config_dir.chmod(0o700)
            config = config_dir / "collector.json"
            config.write_text(
                json.dumps(
                    {
                        "endpoint": "http://127.0.0.1:9/ingest",
                        "token": "offline",
                        **IDENTITY_CONFIG,
                    }
                ),
                encoding="utf-8",
            )
            config.chmod(0o600)
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_HOME": str(codex_home),
                    "SHERLOCK_COLLECTOR_SOURCE": str(SOURCE),
                    "SHERLOCK_CONFIG_PATH": str(config),
                }
            )

            started = time.monotonic()
            completed = subprocess.run(
                [sys.executable, str(LAUNCHER), "SessionStart"],
                input="{}",
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            elapsed = time.monotonic() - started

            self.assertLess(elapsed, 1.0)
            outcome = json.loads(completed.stdout)
            self.assertEqual(outcome["discovered"], 1)
            self.assertEqual(outcome["enqueued"], 1)
            state_root = codex_home / "sherlock" / "telemetry"
            self.assertTrue((state_root / "rollout-state.json").is_file())
            self.assertEqual(
                len(list((state_root / "queue").glob("*/*.json"))),
                1,
            )

    def test_exact_launcher_is_fail_open_when_local_state_is_corrupt(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            state_root = codex_home / "sherlock" / "telemetry"
            state_root.mkdir(parents=True)
            (state_root / "rollout-state.json").write_text(
                "not-json\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "CODEX_HOME": str(codex_home),
                    "SHERLOCK_COLLECTOR_SOURCE": str(SOURCE),
                }
            )

            completed = subprocess.run(
                [sys.executable, str(LAUNCHER), "SessionStart"],
                input="{}",
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0)
            self.assertIn("Sherlock telemetry capture failed", completed.stderr)

    def test_later_eligible_hook_starts_recovery_drain_without_new_bytes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            drain_command = [sys.executable, "-c", "pass"]
            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                first = run_hook(
                    "SessionStart",
                    {},
                    codex_home=codex_home,
                    drain_command=drain_command,
                )
                second = run_hook(
                    "UserPromptSubmit",
                    {},
                    codex_home=codex_home,
                    drain_command=drain_command,
                )

            self.assertEqual(first.enqueued, 1)
            self.assertEqual(second.enqueued, 0)
            self.assertEqual(popen.call_count, 2)

    def test_ordinary_post_tool_use_is_skipped(self):
        with TemporaryDirectory() as temporary:
            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                result = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=Path(temporary),
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(result.skipped, "ordinary_tool")
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
