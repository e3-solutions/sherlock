from __future__ import annotations

import fcntl
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

from sherlock_collector.config import (
    ConfigurationError,
    load_config,
    validate_install_email,
    validate_install_email_for_home,
)
from sherlock_collector.discovery import discover_rollouts
from sherlock_collector.hook import (
    CODEX_HOOK_EVENTS,
    HOOK_EVENTS,
    POST_TOOL_DEBOUNCE_SECONDS,
    HookResult,
    run_hook,
)
from sherlock_collector.spool import secure_lock


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

    def test_subagent_payload_path_uses_agent_native_session_id(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            rollout = (
                codex_home
                / "sessions"
                / "2026"
                / "08"
                / "15"
                / "rollout-agent.jsonl"
            )
            rollout.parent.mkdir(parents=True)
            rollout.write_text('{"type":"event"}\n', encoding="utf-8")
            parent_session_id = str(uuid.uuid4())
            agent_id = str(uuid.uuid4())

            result = discover_rollouts(
                codex_home,
                hook_payload={
                    "session_id": parent_session_id,
                    "agent_id": agent_id,
                    "agent_transcript_path": str(rollout),
                },
            )

            self.assertEqual(result.paths, (rollout.resolve(),))
            self.assertEqual(
                result.native_session_ids[str(rollout.resolve())], agent_id
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
    def test_install_email_domain_accepts_only_e3_and_sixtyfour(self):
        self.assertEqual(validate_install_email("Ada@E3GROUP.AI"), "ada@e3group.ai")
        self.assertEqual(
            validate_install_email("Dev@SixtyFour.AI"), "dev@sixtyfour.ai"
        )
        for email in (
            "outsider@example.com",
            "user@sub.e3group.ai",
            "user@e3group.ai.example",
        ):
            with self.subTest(email=email):
                with self.assertRaisesRegex(ConfigurationError, "work domain"):
                    validate_install_email(email)

    def test_install_email_change_requires_a_separate_clean_collector_home(self):
        with TemporaryDirectory() as temporary:
            collector_home = Path(temporary) / "codex"
            config = collector_home / "sherlock" / "collector.json"
            config.parent.mkdir(parents=True)
            config.write_text(
                json.dumps({**IDENTITY_CONFIG, "email": "user@e3group.ai"}),
                encoding="utf-8",
            )
            config.chmod(0o600)

            self.assertEqual(
                validate_install_email_for_home("USER@E3GROUP.AI", collector_home),
                "user@e3group.ai",
            )
            with self.assertRaisesRegex(ConfigurationError, "separate clean"):
                validate_install_email_for_home("user@sixtyfour.ai", collector_home)

    def test_install_rejects_orphaned_pending_and_processing_spool_items(self):
        for state in ("pending", "processing"):
            with self.subTest(state=state), TemporaryDirectory() as temporary:
                collector_home = Path(temporary) / "codex"
                artifact = (
                    collector_home
                    / "sherlock"
                    / "telemetry"
                    / "queue"
                    / state
                    / "orphaned.json"
                )
                artifact.parent.mkdir(parents=True)
                artifact.write_text('{"immutable":"telemetry"}\n', encoding="utf-8")

                with self.assertRaisesRegex(ConfigurationError, "recover the config"):
                    validate_install_email_for_home("user@e3group.ai", collector_home)
                self.assertEqual(
                    artifact.read_text(encoding="utf-8"),
                    '{"immutable":"telemetry"}\n',
                )

    def test_installed_config_pins_drain_email_and_installation_id(self):
        with TemporaryDirectory() as temporary:
            collector_home = Path(temporary) / "codex"
            config = collector_home / "sherlock" / "collector.json"
            pending = (
                collector_home
                / "sherlock"
                / "telemetry"
                / "queue"
                / "pending"
                / "queued.json"
            )
            config.parent.mkdir(parents=True)
            pending.parent.mkdir(parents=True)
            config.write_text(
                json.dumps(
                    {
                        "endpoint": "https://example.test/functions/v1/ingest",
                        **IDENTITY_CONFIG,
                        "email": "user@e3group.ai",
                    }
                ),
                encoding="utf-8",
            )
            config.chmod(0o600)
            pending.write_text('{"immutable":"telemetry"}\n', encoding="utf-8")

            with patch.dict(
                os.environ,
                {"SHERLOCK_EMAIL": "USER@E3GROUP.AI"},
                clear=True,
            ):
                self.assertEqual(load_config(config).identity.email, "user@e3group.ai")
            with patch.dict(
                os.environ,
                {"SHERLOCK_EMAIL": "user@sixtyfour.ai"},
                clear=True,
            ):
                with self.assertRaisesRegex(ConfigurationError, "must match"):
                    load_config(config)
            with patch.dict(
                os.environ,
                {
                    "SHERLOCK_INSTALLATION_ID":
                        "00000000-0000-4000-8000-000000000002"
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ConfigurationError, "must match"):
                    load_config(config)
            self.assertEqual(
                pending.read_text(encoding="utf-8"),
                '{"immutable":"telemetry"}\n',
            )

    def test_env_only_drain_rejects_orphaned_source_home_spool(self):
        environment = {
            "SHERLOCK_INGEST_URL": "https://example.test/functions/v1/ingest",
            "SHERLOCK_NAME": "Moved User",
            "SHERLOCK_GITHUB_ID": "moved-user",
            "SHERLOCK_EMAIL": "user@sixtyfour.ai",
            "SHERLOCK_INSTALLATION_ID":
                "00000000-0000-4000-8000-000000000002",
        }
        for state in ("pending", "processing"):
            with self.subTest(state=state), TemporaryDirectory() as temporary:
                root = Path(temporary)
                source_home = root / "codex"
                custom_config = root / "custom" / "missing.json"
                artifact = (
                    source_home
                    / "sherlock"
                    / "telemetry"
                    / "queue"
                    / state
                    / "orphaned.json"
                )
                artifact.parent.mkdir(parents=True)
                artifact.write_text(
                    '{"immutable":"telemetry"}\n', encoding="utf-8"
                )

                with patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(
                        ConfigurationError, "recover the config"
                    ):
                        load_config(custom_config, codex_home=source_home)

                self.assertEqual(
                    artifact.read_text(encoding="utf-8"),
                    '{"immutable":"telemetry"}\n',
                )

    def test_env_only_config_loads_when_source_home_has_no_spool(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_home = root / "codex"
            custom_config = root / "custom" / "missing.json"
            with patch.dict(
                os.environ,
                {
                    "SHERLOCK_INGEST_URL":
                        "https://example.test/functions/v1/ingest",
                    "SHERLOCK_NAME": "Clean User",
                    "SHERLOCK_GITHUB_ID": "clean-user",
                    "SHERLOCK_EMAIL": "user@e3group.ai",
                    "SHERLOCK_INSTALLATION_ID":
                        "00000000-0000-4000-8000-000000000001",
                },
                clear=True,
            ):
                loaded = load_config(custom_config, codex_home=source_home)

            self.assertEqual(loaded.identity.email, "user@e3group.ai")
            self.assertEqual(
                loaded.identity.installation_id,
                "00000000-0000-4000-8000-000000000001",
            )

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
            self.assertEqual(loaded.identity.email, "test@example.com")
            path.chmod(0o640)
            with self.assertRaisesRegex(ConfigurationError, "owner-only"):
                load_config(path)

    def test_endpoint_environment_override_does_not_require_a_token(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "collector.json"
            path.write_text(json.dumps(IDENTITY_CONFIG), encoding="utf-8")
            path.chmod(0o600)
            with patch.dict(
                os.environ,
                {"SHERLOCK_INGEST_URL": "https://example.test/ingest"},
                clear=True,
            ):
                loaded = load_config(path)

            self.assertEqual(loaded.endpoint, "https://example.test/ingest")

    def test_installer_copies_runtime_and_writes_identity_only_config(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
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
                    "TEST@e3group.ai",
                ],
                check=True,
                capture_output=True,
                text=True,
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
            installed = json.loads(config.read_text(encoding="utf-8"))
            self.assertNotIn("token", installed)
            self.assertEqual(installed["email"], "test@e3group.ai")
            self.assertEqual(installed["github_id"], "test-user")
            self.assertEqual(
                uuid.UUID(installed["installation_id"]).version,
                4,
            )

    def test_installer_rejects_invalid_endpoint_before_writing_config(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
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
                    "test@e3group.ai",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((codex_home / "sherlock" / "collector.json").exists())

    def test_installer_reuses_the_machine_installation_id(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
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
                "test@e3group.ai",
            ]

            subprocess.run(command, check=True, capture_output=True)
            config = codex_home / "sherlock" / "collector.json"
            first = json.loads(config.read_text(encoding="utf-8"))["installation_id"]
            command[-1] = "TEST@E3GROUP.AI"
            subprocess.run(command, check=True, capture_output=True)
            second = json.loads(config.read_text(encoding="utf-8"))["installation_id"]

            self.assertEqual(first, second)

    def test_installer_rejects_email_change_without_mutating_collector_home(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            sherlock_root = codex_home / "sherlock"
            runtime_marker = sherlock_root / "runtime" / "existing.txt"
            spool_marker = (
                sherlock_root
                / "telemetry"
                / "queue"
                / "pending"
                / "pending.json"
            )
            config = sherlock_root / "collector.json"
            runtime_marker.parent.mkdir(parents=True)
            spool_marker.parent.mkdir(parents=True)
            runtime_marker.write_text("existing runtime", encoding="utf-8")
            spool_marker.write_text("pending telemetry", encoding="utf-8")
            config.write_text(
                json.dumps(
                    {
                        "endpoint": "https://example.test/functions/v1/ingest",
                        "name": "Existing User",
                        "github_id": "existing-user",
                        "email": "user@e3group.ai",
                        "installation_id": "00000000-0000-4000-8000-000000000001",
                    }
                ),
                encoding="utf-8",
            )
            config.chmod(0o600)
            before = {
                path: path.read_bytes()
                for path in (config, runtime_marker, spool_marker)
            }

            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER),
                    "--endpoint",
                    "https://example.test/functions/v1/ingest",
                    "--codex-home",
                    str(codex_home),
                    "--name",
                    "Moved User",
                    "--github-id",
                    "moved-user",
                    "--email",
                    "user@sixtyfour.ai",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("separate clean collector home", completed.stderr)
            for path, contents in before.items():
                self.assertEqual(path.read_bytes(), contents)

    def test_installer_rejects_orphaned_spool_without_mutation(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
            pending = (
                codex_home
                / "sherlock"
                / "telemetry"
                / "queue"
                / "processing"
                / "orphaned.json"
            )
            pending.parent.mkdir(parents=True)
            pending.write_text('{"immutable":"telemetry"}\n', encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(INSTALLER),
                    "--endpoint",
                    "https://example.test/functions/v1/ingest",
                    "--codex-home",
                    str(codex_home),
                    "--name",
                    "Recovered User",
                    "--github-id",
                    "recovered-user",
                    "--email",
                    "user@e3group.ai",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("recover the config", completed.stderr)
            self.assertEqual(
                pending.read_text(encoding="utf-8"),
                '{"immutable":"telemetry"}\n',
            )
            self.assertFalse((codex_home / "sherlock" / "runtime").exists())
            self.assertFalse((codex_home / "sherlock" / "collector.json").exists())

    def test_installer_rejects_unapproved_domain_before_writing_runtime_or_config(self):
        with TemporaryDirectory() as temporary:
            codex_home = Path(temporary) / "codex"
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
                    "outsider@example.com",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("work domain", completed.stderr)
            self.assertFalse((codex_home / "sherlock").exists())


class HookCompanionTests(unittest.TestCase):
    def test_manifest_events_match_supported_events(self):
        hooks = json.loads(HOOKS.read_text(encoding="utf-8"))["hooks"]

        self.assertEqual(set(hooks), CODEX_HOOK_EVENTS)
        self.assertTrue(set(hooks).issubset(HOOK_EVENTS))
        for event_name in (
            "PostToolUse",
            "PostCompact",
            "SubagentStart",
            "SubagentStop",
        ):
            command = hooks[event_name][0]["hooks"][0]
            self.assertIs(command["async"], True)
            self.assertEqual(command["timeout"], 30)

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

    def test_ordinary_post_tool_use_is_captured_then_debounced(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            state_root = root / "telemetry"
            first_ns = 1_000_000_000_000
            with (
                patch("sherlock_collector.hook.subprocess.Popen") as popen,
                patch(
                    "sherlock_collector.hook.time.time_ns",
                    side_effect=[
                        first_ns,
                        first_ns + 1,
                        first_ns
                        + POST_TOOL_DEBOUNCE_SECONDS * 1_000_000_000,
                    ],
                ),
            ):
                first = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=codex_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                second = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=codex_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                third = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=codex_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(first.enqueued, 1)
            self.assertIsNone(first.skipped)
            self.assertEqual(second.skipped, "debounced")
            self.assertEqual(third.enqueued, 0)
            self.assertIsNone(third.skipped)
            self.assertEqual(popen.call_count, 2)
            throttle = state_root / "codex-post-tool-capture.json"
            self.assertEqual(throttle.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state_root.stat().st_mode & 0o777, 0o700)

    def test_coordination_tools_bypass_ordinary_tool_debounce(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            state_root = root / "telemetry"
            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                first = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=codex_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                coordination = run_hook(
                    "PostToolUse",
                    {"tool_name": "collaboration.spawn_agent"},
                    codex_home=codex_home,
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertEqual(first.enqueued, 1)
            self.assertIsNone(coordination.skipped)
            self.assertEqual(popen.call_count, 2)

    def test_busy_ordinary_tool_capture_fails_open_without_a_drain(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / "telemetry"
            with secure_lock(state_root / "codex-post-tool-capture.lock") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                    result = run_hook(
                        "PostToolUse",
                        {"tool_name": "functions.exec"},
                        codex_home=root / "codex",
                        state_root=state_root,
                        drain_command=[sys.executable, "-c", "pass"],
                    )

            self.assertEqual(result.skipped, "busy")
            popen.assert_not_called()

    def test_capture_lock_contention_does_not_consume_debounce_window(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / "telemetry"
            with patch(
                "sherlock_collector.hook._capture_hook",
                side_effect=[
                    HookResult("PostToolUse", locked=True),
                    HookResult("PostToolUse"),
                ],
            ) as capture:
                first = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=root / "codex",
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                second = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=root / "codex",
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertTrue(first.locked)
            self.assertIsNone(second.skipped)
            self.assertEqual(capture.call_count, 2)

    def test_capture_failure_does_not_consume_debounce_window(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / "telemetry"
            with patch(
                "sherlock_collector.hook._capture_hook",
                side_effect=[RuntimeError("capture failed"), HookResult("PostToolUse")],
            ) as capture:
                with self.assertRaisesRegex(RuntimeError, "capture failed"):
                    run_hook(
                        "PostToolUse",
                        {"tool_name": "functions.exec"},
                        codex_home=root / "codex",
                        state_root=state_root,
                        drain_command=[sys.executable, "-c", "pass"],
                    )
                recovered = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=root / "codex",
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertIsNone(recovered.skipped)
            self.assertEqual(capture.call_count, 2)

    def test_corrupt_or_future_debounce_state_retries_capture(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_root = root / "telemetry"
            state_root.mkdir()
            state_path = state_root / "codex-post-tool-capture.json"
            state_path.write_bytes(b"\xff\xfe")
            with patch(
                "sherlock_collector.hook._capture_hook",
                return_value=HookResult("PostToolUse"),
            ) as capture:
                corrupt = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=root / "codex",
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )
                state_path.write_text(
                    json.dumps(
                        {
                            "state_version": 1,
                            "last_capture_ns": time.time_ns() + 60_000_000_000,
                        }
                    ),
                    encoding="utf-8",
                )
                future = run_hook(
                    "PostToolUse",
                    {"tool_name": "functions.exec"},
                    codex_home=root / "codex",
                    state_root=state_root,
                    drain_command=[sys.executable, "-c", "pass"],
                )

            self.assertIsNone(corrupt.skipped)
            self.assertIsNone(future.skipped)
            self.assertEqual(capture.call_count, 2)

    def test_new_lifecycle_hooks_always_capture(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            codex_home, _ = self._fixture(root)
            with patch("sherlock_collector.hook.subprocess.Popen") as popen:
                results = [
                    run_hook(
                        event_name,
                        {},
                        codex_home=codex_home,
                        state_root=root / "telemetry",
                        drain_command=[sys.executable, "-c", "pass"],
                    )
                    for event_name in (
                        "PostCompact",
                        "SubagentStart",
                        "SubagentStop",
                    )
                ]

            self.assertTrue(all(result.skipped is None for result in results))
            self.assertEqual(popen.call_count, 3)


if __name__ == "__main__":
    unittest.main()
