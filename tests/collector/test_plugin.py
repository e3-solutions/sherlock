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
                    int(row["updated_at_ms"]) // 1000,
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
            recent = root / "recent.jsonl"
            old = root / "old.jsonl"
            archived = root / "archived.jsonl"
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
            rollout = Path(temporary) / "live.jsonl"
            rollout.write_text('{"type":"event"}\n', encoding="utf-8")

            result = discover_rollouts(
                Path(temporary) / "codex",
                hook_payload={
                    "session_id": "native-live",
                    "transcript_path": str(rollout),
                },
            )

            self.assertEqual(result.paths, (rollout.resolve(),))
            self.assertEqual(
                result.native_session_ids[str(rollout.resolve())], "native-live"
            )


class ConfigurationTests(unittest.TestCase):
    def test_owner_only_config_loads_and_group_readable_config_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "collector.json"
            path.write_text(
                json.dumps(
                    {
                        "endpoint": "https://example.test/functions/v1/ingest",
                        "token": "opaque-test-token",
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
            path.chmod(0o640)
            with self.assertRaisesRegex(ConfigurationError, "owner-only"):
                load_config(path)

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


class HookIntegrationTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[Path, Path]:
        codex_home = root / "codex"
        rollout = root / "rollout.jsonl"
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
                    {"endpoint": "http://127.0.0.1:9/ingest", "token": "offline"}
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
