from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .config import (
    ConfigurationError,
    default_claude_home,
    default_codex_home,
    default_state_root,
    load_config,
)
from .drain import Drain
from .discovery import (
    CLAUDE_DEFAULT_LOOKBACK_SECONDS,
    CLAUDE_BACKFILL_MAX_BYTES,
    CLAUDE_BACKFILL_MAX_FILES,
    CODEX_BACKFILL_MAX_BYTES,
    CODEX_BACKFILL_MAX_FILES,
    DEFAULT_LOOKBACK_SECONDS,
    discover_claude_transcripts,
    discover_rollouts,
)
from .hook import capture_and_spawn_drain, run_hook
from .http import HttpTransport
from .rollout import RolloutCapturer
from .spool import DurableSpool


MAX_CLAUDE_REPLAY_RANGE_SECONDS = 31 * 24 * 60 * 60
RFC3339_PATTERN = re.compile(
    r"^(?P<second>\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d{1,9})?(?P<zone>[Zz]|[+-]\d{2}:\d{2})$"
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="sherlock-collector")
    result.add_argument("--codex-home", type=Path)
    result.add_argument("--claude-home", type=Path)
    result.add_argument("--provider", choices=("codex", "claude_code"), default="codex")
    result.add_argument("--state-root", type=Path)
    result.add_argument("--config", type=Path)
    commands = result.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("rollout", nargs="+", type=Path)
    backfill = commands.add_parser("backfill")
    backfill.add_argument(
        "--lookback-seconds",
        type=int,
    )
    backfill.add_argument("--session-id")
    backfill.add_argument("--start")
    backfill.add_argument("--end")
    hook = commands.add_parser("hook")
    hook.add_argument("event_name")
    commands.add_parser("drain")
    commands.add_parser("health")
    return result


def _payload_from_stdin() -> tuple[dict[str, object], bytes]:
    source = getattr(sys.stdin, "buffer", sys.stdin)
    try:
        raw = source.read()
    except (OSError, UnicodeError):
        return {}, b""
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}, raw
    return (value if isinstance(value, dict) else {}), raw


def _canonical_uuid(value: str) -> str | None:
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return None
    canonical = str(parsed)
    return canonical if value.lower() == canonical else None


def _rfc3339_ns(value: str) -> int | None:
    match = RFC3339_PATTERN.fullmatch(value)
    if match is None:
        return None
    zone = match.group("zone")
    normalized_zone = "+00:00" if zone in "Zz" else zone
    try:
        parsed = datetime.fromisoformat(match.group("second") + normalized_zone)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = normalized - epoch
    whole_seconds_ns = (
        delta.days * 24 * 60 * 60 + delta.seconds
    ) * 1_000_000_000
    fraction = match.group("fraction")
    fractional_ns = int(fraction[1:].ljust(9, "0")) if fraction else 0
    return whole_seconds_ns + fractional_ns


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    source_home = (
        Path(
            (args.claude_home or default_claude_home())
            if args.provider == "claude_code"
            else (args.codex_home or default_codex_home())
        )
        .expanduser()
        .resolve()
    )
    state_root = (
        Path(args.state_root or default_state_root(source_home)).expanduser().resolve()
    )
    is_claude = args.provider == "claude_code"
    selection_mode = "lookback"
    lookback_seconds: int | None = None
    replay_session_id: str | None = None
    modified_after_ns: int | None = None
    modified_before_ns: int | None = None
    if args.command == "backfill":
        has_range = args.start is not None or args.end is not None
        has_replay_selector = args.session_id is not None or has_range
        if not is_claude and has_replay_selector:
            print(
                "session and date-range replay require provider claude_code",
                file=sys.stderr,
            )
            return 2
        if args.session_id is not None and (
            has_range or args.lookback_seconds is not None
        ):
            print("backfill selectors are mutually exclusive", file=sys.stderr)
            return 2
        if has_range and args.lookback_seconds is not None:
            print("backfill selectors are mutually exclusive", file=sys.stderr)
            return 2
        if has_range and (args.start is None or args.end is None):
            print("date-range replay requires both --start and --end", file=sys.stderr)
            return 2
        if args.session_id is not None:
            replay_session_id = _canonical_uuid(args.session_id)
            if replay_session_id is None:
                print("--session-id must be a canonical UUID", file=sys.stderr)
                return 2
            selection_mode = "session_id"
        elif has_range:
            modified_after_ns = _rfc3339_ns(args.start)
            modified_before_ns = _rfc3339_ns(args.end)
            if modified_after_ns is None or modified_before_ns is None:
                print(
                    "--start and --end must be timezone-aware RFC3339 timestamps",
                    file=sys.stderr,
                )
                return 2
            duration_ns = modified_before_ns - modified_after_ns
            if duration_ns <= 0:
                print(
                    "date-range replay must have an increasing range", file=sys.stderr
                )
                return 2
            if duration_ns > MAX_CLAUDE_REPLAY_RANGE_SECONDS * 1_000_000_000:
                print("date-range replay cannot exceed 31 days", file=sys.stderr)
                return 2
            selection_mode = "mtime_range"
        else:
            lookback_seconds = args.lookback_seconds
            if lookback_seconds is None:
                lookback_seconds = (
                    CLAUDE_DEFAULT_LOOKBACK_SECONDS
                    if is_claude
                    else DEFAULT_LOOKBACK_SECONDS
                )
            if lookback_seconds < 1:
                print("backfill requires a positive lookback", file=sys.stderr)
                return 2
    spool = DurableSpool(state_root / "queue")
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
            (
                "CLAUDE_CONFIG_DIR" if args.provider == "claude_code" else "CODEX_HOME"
            ): str(source_home),
        }
    )
    if args.command == "backfill":
        discovery = (
            discover_claude_transcripts(
                source_home,
                lookback_seconds=lookback_seconds,
                replay_session_id=replay_session_id,
                modified_after_ns=modified_after_ns,
                modified_before_ns=modified_before_ns,
            )
            if is_claude
            else discover_rollouts(
                source_home,
                lookback_seconds=lookback_seconds or DEFAULT_LOOKBACK_SECONDS,
                scan_recent_files=True,
            )
        )
        outcome = capture_and_spawn_drain(
            RolloutCapturer(
                state_root,
                spool,
                source_provider=args.provider,
                source_kind="transcript" if is_claude else "rollout",
                state_name="claude-transcript" if is_claude else "rollout",
                capture_unterminated_tail=not is_claude,
                allowed_root=(
                    source_home / "projects"
                    if is_claude
                    and not (source_home / "projects").is_symlink()
                    and (source_home / "projects").is_dir()
                    else source_home
                    if not is_claude
                    else None
                ),
            ),
            discovery.paths,
            [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                "--claude-home" if is_claude else "--codex-home",
                str(source_home),
                "--provider",
                args.provider,
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            native_session_ids=discovery.native_session_ids,
            parent_native_session_ids=discovery.parent_native_session_ids,
            source_snapshots=discovery.source_snapshots,
            drain_environment=environment,
            best_effort=True,
            max_files=(
                CLAUDE_BACKFILL_MAX_FILES if is_claude else CODEX_BACKFILL_MAX_FILES
            ),
            max_sync_bytes=(
                CLAUDE_BACKFILL_MAX_BYTES if is_claude else CODEX_BACKFILL_MAX_BYTES
            ),
            backlog_workload_class="backfill",
        )
        partial = bool(
            discovery.errors
            or discovery.invalid_count
            or discovery.omitted_count
            or outcome.errors
            or outcome.locked
            or outcome.deferred_files
        )
        print(
            json.dumps(
                {
                    "status": "partial" if partial else "complete",
                    "selection": selection_mode,
                    "lookback_seconds": lookback_seconds,
                    "session_id": replay_session_id,
                    "start": args.start,
                    "end": args.end,
                    "discovered": len(discovery.paths),
                    "selected_bytes": discovery.selected_bytes,
                    "invalid": discovery.invalid_count,
                    "omitted": discovery.omitted_count,
                    "excluded_by_cutoff": discovery.excluded_by_cutoff,
                    "discovery_errors": len(discovery.errors),
                    **asdict(outcome),
                },
                sort_keys=True,
            )
        )
        return 75 if outcome.locked else 0
    if args.command == "capture":
        outcome = capture_and_spawn_drain(
            RolloutCapturer(
                state_root,
                spool,
                source_provider=args.provider,
                source_kind=(
                    "transcript" if args.provider == "claude_code" else "rollout"
                ),
                state_name=(
                    "claude-transcript" if args.provider == "claude_code" else "rollout"
                ),
                capture_unterminated_tail=args.provider != "claude_code",
            ),
            args.rollout,
            [
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                *(
                    ["--claude-home", str(source_home)]
                    if args.provider == "claude_code"
                    else ["--codex-home", str(source_home)]
                ),
                "--provider",
                args.provider,
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(outcome), sort_keys=True))
        return 0 if not outcome.locked else 75
    if args.command == "hook":
        payload, raw_payload = _payload_from_stdin()
        outcome = run_hook(
            args.event_name,
            payload,
            raw_payload=raw_payload,
            codex_home=source_home if args.provider == "codex" else None,
            claude_home=source_home if args.provider == "claude_code" else None,
            state_root=state_root,
            provider=args.provider,
            drain_command=[
                sys.executable,
                "-m",
                "sherlock_collector.cli",
                *(
                    ["--claude-home", str(source_home)]
                    if args.provider == "claude_code"
                    else ["--codex-home", str(source_home)]
                ),
                "--provider",
                args.provider,
                "--state-root",
                str(state_root),
                *(["--config", str(args.config)] if args.config else []),
                "drain",
            ],
            drain_environment=environment,
        )
        print(json.dumps(asdict(outcome), sort_keys=True))
        return 0
    try:
        configuration = load_config(args.config, codex_home=source_home)
    except ConfigurationError as error:
        print(f"sherlock collector is not configured: {error}", file=sys.stderr)
        return 78
    if args.command == "health":
        pending_batches = len(spool.list_pending())
        processing_batches = len(list(spool.processing.glob("*.json")))
        dead_letter_batches = len(list(spool.dead_letter.glob("*.json")))
        status = (
            "degraded"
            if dead_letter_batches
            else "recovering"
            if processing_batches
            else "ok"
        )
        print(
            json.dumps(
                {
                    "status": status,
                    "provider": args.provider,
                    "source_home": str(source_home),
                    "state_root": str(state_root),
                    "pending_batches": pending_batches,
                    "processing_batches": processing_batches,
                    "dead_letter_batches": dead_letter_batches,
                },
                sort_keys=True,
            )
        )
        return 1 if dead_letter_batches else 0
    outcome = Drain(
        spool,
        HttpTransport(
            configuration.endpoint,
            configuration.identity,
        ),
    ).run()
    print(json.dumps(asdict(outcome), sort_keys=True))
    return 0 if not outcome.locked else 75


if __name__ == "__main__":
    raise SystemExit(main())
