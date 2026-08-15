from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import zipfile
from dataclasses import asdict
from pathlib import Path

from .backfill import (
    DEFAULT_EXPORT_WORKERS,
    BackfillError,
    export_archive,
    upload_archive,
)
from .config import (
    ConfigurationError,
    default_codex_home,
    default_state_root,
    load_config,
)
from .drain import Drain
from .hook import capture_and_spawn_drain, run_hook
from .http import HttpTransport
from .rollout import RolloutCapturer
from .spool import DurableSpool


class _ProgressPrinter:
    def __init__(self, action: str):
        self.action = action
        self.last_rendered_at = 0.0
        self.previous_width = 0

    def __call__(self, current: int, total: int, path: str) -> None:
        if total < 1:
            return
        if not sys.stderr.isatty():
            interval = max(1, total // 100)
            if current == 1 or current == total or current % interval == 0:
                print(
                    f"{self.action} {current}/{total}: {path}",
                    file=sys.stderr,
                )
            return
        now = time.monotonic()
        if current < total and now - self.last_rendered_at < 0.05:
            return
        self.last_rendered_at = now
        ratio = min(1.0, current / total)
        bar_width = 24
        completed = round(bar_width * ratio)
        bar = "#" * completed + "-" * (bar_width - completed)
        prefix = (
            f"{self.action} [{bar}] {current:,}/{total:,} {ratio:6.1%} "
        )
        terminal_width = shutil.get_terminal_size(fallback=(100, 24)).columns
        available = max(0, terminal_width - len(prefix) - 1)
        label = path
        if len(label) > available:
            label = ("…" + label[-(available - 1) :]) if available > 1 else ""
        line = (prefix + label)[: terminal_width - 1]
        padding = " " * max(0, self.previous_width - len(line))
        sys.stderr.write(f"\r{line}{padding}")
        sys.stderr.flush()
        self.previous_width = len(line)
        if current >= total:
            sys.stderr.write("\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="sherlock-collector")
    result.add_argument("--codex-home", type=Path)
    result.add_argument("--state-root", type=Path)
    result.add_argument("--config", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("rollout", nargs="+", type=Path)
    hook = commands.add_parser("hook")
    hook.add_argument("event_name")
    commands.add_parser("drain")
    backfill_export = commands.add_parser(
        "backfill-export",
        help="Export every active and archived Codex rollout to a verified ZIP.",
    )
    backfill_export.add_argument("--output", required=True, type=Path)
    backfill_export.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_EXPORT_WORKERS,
        help="Parallel compression workers (1-32).",
    )
    backfill_export.add_argument(
        "--acknowledge-sensitive-data",
        action="store_true",
        help="Confirm that prompts, tool data, and responses may be included.",
    )
    backfill_export.add_argument(
        "--force", action="store_true", help="Replace an existing output archive."
    )
    backfill_upload = commands.add_parser(
        "backfill-upload",
        help="Verify and upload a Sherlock backfill ZIP through the ingest API.",
    )
    backfill_upload.add_argument("archive", type=Path)
    backfill_upload.add_argument("--workers", type=int, default=4)
    backfill_upload.add_argument("--retries", type=int, default=4)
    backfill_upload.add_argument("--state", type=Path)
    backfill_upload.add_argument(
        "--no-resume",
        action="store_true",
        help="Do not read or write the adjacent upload checkpoint.",
    )
    return result


def _payload_from_stdin() -> dict[str, object]:
    try:
        value = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    codex_home = Path(
        args.codex_home or default_codex_home()
    ).expanduser().resolve()
    state_root = Path(
        args.state_root or default_state_root(codex_home)
    ).expanduser().resolve()
    source_root = str(Path(__file__).resolve().parents[1])
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONPATH": source_root
            + (
                f"{os.pathsep}{os.environ['PYTHONPATH']}"
                if os.environ.get("PYTHONPATH")
                else ""
            ),
            "CODEX_HOME": str(codex_home),
        }
    )
    if args.command == "capture":
        spool = DurableSpool(state_root / "queue")
        capture_outcome = capture_and_spawn_drain(
            RolloutCapturer(state_root, spool),
            args.rollout,
            [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--codex-home",
                str(codex_home),
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(capture_outcome), sort_keys=True))
        return 0 if not capture_outcome.locked else 75
    if args.command == "hook":
        hook_outcome = run_hook(
            args.event_name,
            _payload_from_stdin(),
            codex_home=codex_home,
            state_root=state_root,
            drain_command=[
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--codex-home",
                str(codex_home),
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(hook_outcome), sort_keys=True))
        return 0
    if args.command == "backfill-export":
        if not args.acknowledge_sensitive_data:
            print(
                "refusing to export: pass --acknowledge-sensitive-data to confirm "
                "that Codex sessions can contain prompts, responses, tool data, and secrets",
                file=sys.stderr,
            )
            return 64
        try:
            export_outcome = export_archive(
                codex_home,
                args.output,
                state_root=state_root,
                force=args.force,
                workers=args.workers,
                progress=_ProgressPrinter("Exporting"),
            )
        except (BackfillError, OSError, zipfile.BadZipFile) as error:
            print(f"backfill export failed: {error}", file=sys.stderr)
            return 74
        print(json.dumps(asdict(export_outcome), sort_keys=True))
        return 0
    try:
        configuration = load_config(args.config, codex_home=codex_home)
    except ConfigurationError as error:
        print(f"sherlock collector is not configured: {error}", file=sys.stderr)
        return 78
    principal = configuration.identity or configuration.token
    assert principal is not None
    transport = HttpTransport(configuration.endpoint, principal)
    if args.command == "backfill-upload":
        try:
            upload_outcome = upload_archive(
                args.archive,
                transport,
                workers=args.workers,
                retries=args.retries,
                state_path=args.state,
                resume=not args.no_resume,
                progress=_ProgressPrinter("Uploading"),
            )
        except (BackfillError, OSError, zipfile.BadZipFile) as error:
            print(f"backfill upload failed: {error}", file=sys.stderr)
            return 74
        print(json.dumps(asdict(upload_outcome), sort_keys=True))
        return 0
    drain_outcome = Drain(
        DurableSpool(state_root / "queue"), transport
    ).run()
    print(json.dumps(asdict(drain_outcome), sort_keys=True))
    return 0 if not drain_outcome.locked else 75


if __name__ == "__main__":
    raise SystemExit(main())
