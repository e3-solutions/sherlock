"""Per-provider user scheduler lifecycle; generated files contain no credentials."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import io
import logging
import logging.handlers
import hashlib
import json
import os
import platform
import plistlib
import shlex
import subprocess
import sys
import traceback
from pathlib import Path

from .config import default_claude_home, default_codex_home
from .spool import _atomic_json, secure_lock

INTERVAL_SECONDS = 15 * 60
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUPS = 3


class _ByteRotatingFileHandler(logging.handlers.RotatingFileHandler):
    def _open(self):
        descriptor = os.open(
            self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        os.fchmod(descriptor, 0o600)
        return os.fdopen(
            descriptor, self.mode, encoding=self.encoding, errors=self.errors
        )

    def shouldRollover(self, record: logging.LogRecord) -> bool:
        if self.stream is None:
            self.stream = self._open()
        self.stream.seek(0, os.SEEK_END)
        size = len((self.format(record) + "\n").encode("utf-8"))
        return self.stream.tell() + size >= self.maxBytes


class _ScheduledLog(io.TextIOBase):
    """Chunk even a single large print so rotation always bounds disk usage."""

    def __init__(self, path: Path):
        self.handler = _ByteRotatingFileHandler(
            path, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
        )
        self.handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))

    def write(self, value: str) -> int:
        for start in range(0, len(value), 4096):
            chunk = value[start : start + 4096].rstrip("\n")
            if chunk:
                self.handler.emit(
                    logging.LogRecord(
                        "sherlock.reconcile", logging.INFO, "", 0, chunk, (), None
                    )
                )
        return len(value)

    def flush(self) -> None:
        self.handler.flush()

    def close(self) -> None:
        if not self.closed:
            super().close()
            self.handler.close()


def run_scheduled(args: list[str], *, state_root: Path, provider: str) -> int:
    """Dedicated scheduler entrypoint: no stdin, bounded private logs, one writer."""
    from .cli import main as collector_main

    # Serialize log rotation too. The reconcile and drain locks independently
    # serialize manual invocations and hooks against the scheduled capture/drain.
    with secure_lock(state_root / f"{provider}-scheduled.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 75
        with (
            open(os.devnull) as stdin,
            _ScheduledLog(state_root / f"{provider}-reconcile.log") as log,
        ):
            os.dup2(stdin.fileno(), 0)
            previous_stdin, sys.stdin = sys.stdin, stdin
            try:
                with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                    try:
                        return collector_main(args)
                    except Exception:
                        traceback.print_exc()
                        return 1
            finally:
                sys.stdin = previous_stdin


def scheduler_id(home: Path, provider: str) -> str:
    digest = hashlib.sha256(str(home.resolve()).encode()).hexdigest()[:12]
    return f"ai.sherlock.{provider}.{digest}"


def _write(path: Path, content: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        os.chmod(temporary, mode)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def scheduler_files(
    home: Path,
    provider: str,
    user_home: Path,
    system: str,
    python: str,
    sherlock_home: str | None = None,
) -> dict[Path, bytes]:
    """Pure generation: safe to test without contacting launchd or systemd."""
    home = home.resolve()
    label = scheduler_id(home, provider)
    runtime = home / "sherlock" / "runtime"
    runner = home / "sherlock" / "bin" / "reconcile.py"
    args = [
        "--provider",
        provider,
        "--claude-home" if provider == "claude_code" else "--codex-home",
        str(home),
        "--state-root",
        str(home / "sherlock" / "telemetry"),
        "--config",
        str(home / "sherlock" / "collector.json"),
        "reconcile",
    ]
    # Isolated mode avoids loading packages or Python settings from a scheduler's
    # working directory. The persistent runtime path is explicit.
    script = (
        "import sys\n"
        # A custom owner-policy home must reach unattended runs too.
        + (
            f"import os\nos.environ.setdefault('SHERLOCK_HOME', {sherlock_home!r})\n"
            if sherlock_home
            else ""
        )
        + f"sys.path.insert(0, {str(runtime)!r})\n"
        + "from pathlib import Path\n"
        + "from sherlock_collector.scheduler import run_scheduled\n"
        + f"raise SystemExit(run_scheduled({args!r}, "
        + f"state_root=Path({str(home / 'sherlock' / 'telemetry')!r}), provider={provider!r}))\n"
    )
    files = {runner: script.encode()}
    command = [python, "-I", str(runner)]
    if system == "Darwin":
        files[user_home / "Library" / "LaunchAgents" / f"{label}.plist"] = (
            plistlib.dumps(
                {
                    "Label": label,
                    "ProgramArguments": command,
                    "StartInterval": INTERVAL_SECONDS,
                    "RunAtLoad": True,
                    "Nice": 10,
                    "LowPriorityIO": True,
                    "ProcessType": "Background",
                    "WorkingDirectory": str(home),
                }
            )
        )
    elif system == "Linux":

        def quote(value: str) -> str:
            # systemd expands percent specifiers and dollar variables in ExecStart.
            if any(char in value for char in "\n\r\x00"):
                raise ValueError("scheduler paths must not contain control characters")
            return (
                '"'
                + value.replace("\\", "\\\\")
                .replace('"', '\\"')
                .replace("%", "%%")
                .replace("$", "$$")
                + '"'
            )

        unit_root = user_home / ".config" / "systemd" / "user"
        files[unit_root / f"{label}.service"] = (
            "[Unit]\nDescription=Sherlock telemetry reconciliation\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nStandardInput=null\n"
            + "ExecStart="
            + " ".join(quote(arg) for arg in command)
            + "\n"
        ).encode()
        files[unit_root / f"{label}.timer"] = (
            "[Unit]\nDescription=Reconcile Sherlock telemetry every 15 minutes\n[Timer]\n"
            "OnStartupSec=2m\nOnUnitInactiveSec=15m\nPersistent=true\n"
            "[Install]\nWantedBy=timers.target\n"
        ).encode()
    else:
        raise ValueError(f"unsupported scheduler platform: {system}")
    return files


def _run(
    command: list[str], *, input: str | None = None
) -> subprocess.CompletedProcess:
    return subprocess.run(
        command, input=input, text=True, capture_output=True, check=False, timeout=30
    )


def _cron(home: Path, provider: str, python: str, *, remove: bool = False) -> None:
    marker = f"# {scheduler_id(home, provider)}"
    current = _run(["crontab", "-l"])
    if current.returncode and "no crontab" not in current.stderr.lower():
        raise RuntimeError(current.stderr.strip() or "cannot read crontab")
    lines = [line for line in current.stdout.splitlines() if not line.endswith(marker)]
    if not remove:
        command = shlex.join(
            [
                "/usr/bin/nice",
                "-n",
                "10",
                python,
                "-I",
                str(home / "sherlock" / "bin" / "reconcile.py"),
            ]
        )
        # crontab parses percent before passing the command to the shell.
        command = command.replace("%", r"\%")
        if "\n" in command or "\r" in command:
            raise ValueError("scheduler paths must not contain newlines")
        lines.append(f"*/15 * * * * {command} </dev/null {marker}")
    result = _run(["crontab", "-"], input="\n".join(lines) + "\n")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "cannot update crontab")


def scheduler_status(home: Path, *, check_loaded: bool = False) -> dict:
    path = home / "sherlock" / "scheduler.json"
    try:
        value = json.loads(path.read_text())
        if value.get("status") == "installed":
            missing = [
                item for item in value.get("files", []) if not Path(item).is_file()
            ]
            if missing:
                return {**value, "status": "missing_files", "missing": missing}
        if check_loaded and value.get("status") == "installed":
            try:
                kind = value.get("kind")
                if kind == "launchd":
                    result = _run(
                        ["launchctl", "print", f"gui/{os.getuid()}/{value['id']}"]
                    )
                elif kind == "systemd":
                    result = _run(
                        ["systemctl", "--user", "is-active", value["id"] + ".timer"]
                    )
                elif kind == "cron":
                    result = _run(["crontab", "-l"])
                    if result.returncode == 0 and not any(
                        line.endswith("# " + value["id"])
                        for line in result.stdout.splitlines()
                    ):
                        return {**value, "status": "not_loaded"}
                else:
                    return {**value, "status": "unknown_scheduler"}
                if result.returncode:
                    return {
                        **value,
                        "status": "not_loaded",
                        "detail": result.stderr.strip(),
                    }
            except (OSError, subprocess.TimeoutExpired) as error:
                return {**value, "status": "unverified", "detail": str(error)}
        return value
    except (OSError, ValueError, AttributeError):
        return {"status": "not_installed"}


def uninstall_scheduler(
    home: Path,
    provider: str,
    *,
    user_home: Path | None = None,
    system: str | None = None,
) -> dict:
    home = home.resolve()
    user_home, system = user_home or Path.home(), system or platform.system()
    previous = scheduler_status(home)
    label = scheduler_id(home, provider)
    files = scheduler_files(home, provider, user_home, system, sys.executable)
    # Only touch this provider home's deterministically named entries.
    if system == "Darwin":
        path = user_home / "Library" / "LaunchAgents" / f"{label}.plist"
        if path.exists() or previous.get("kind") == "launchd":
            result = _run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"])
            if result.returncode:
                loaded = _run(["launchctl", "print", f"gui/{os.getuid()}/{label}"])
                if loaded.returncode == 0:
                    raise RuntimeError(
                        result.stderr.strip() or "cannot unload LaunchAgent"
                    )
    elif system == "Linux":
        timer = user_home / ".config" / "systemd" / "user" / f"{label}.timer"
        if timer.exists() or previous.get("kind") == "systemd":
            result = _run(["systemctl", "--user", "disable", "--now", f"{label}.timer"])
            if result.returncode and previous.get("kind") == "systemd":
                raise RuntimeError(
                    result.stderr.strip() or "cannot disable systemd timer"
                )
        if previous.get("kind") == "cron":
            _cron(home, provider, sys.executable, remove=True)
    for path in files:
        path.unlink(missing_ok=True)
    if system == "Linux" and previous.get("kind") == "systemd":
        _run(["systemctl", "--user", "daemon-reload"])
    result = {"status": "disabled", "provider": provider}
    _atomic_json(home / "sherlock" / "scheduler.json", result)
    return result


def install_scheduler(
    home: Path,
    provider: str,
    *,
    user_home: Path | None = None,
    system: str | None = None,
    python: str | None = None,
) -> dict:
    home = home.resolve()
    user_home, system = user_home or Path.home(), system or platform.system()
    python = python or sys.executable
    previous = scheduler_status(home)
    files = scheduler_files(
        home, provider, user_home, system, python, os.environ.get("SHERLOCK_HOME")
    )
    for path, data in files.items():
        _write(path, data)
    label = scheduler_id(home, provider)
    _atomic_json(
        home / "sherlock" / "scheduler.json",
        {**previous, "status": "installing", "provider": provider},
    )
    kind = "launchd" if system == "Darwin" else "systemd"
    if system == "Darwin":
        path = user_home / "Library" / "LaunchAgents" / f"{label}.plist"
        _run(["launchctl", "bootout", f"gui/{os.getuid()}", str(path)])
        result = _run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)])
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "cannot load LaunchAgent")
    else:
        try:
            reload = _run(["systemctl", "--user", "daemon-reload"])
            result = (
                _run(["systemctl", "--user", "enable", "--now", f"{label}.timer"])
                if reload.returncode == 0
                else reload
            )
        except OSError:
            result = None
        if result is None or result.returncode:
            # Undo a partially enabled timer before switching mechanisms.
            if result is not None or previous.get("kind") == "systemd":
                disabled = _run(
                    ["systemctl", "--user", "disable", "--now", f"{label}.timer"]
                )
                if disabled.returncode and previous.get("kind") == "systemd":
                    raise RuntimeError(
                        "cannot disable previous systemd timer for cron fallback"
                    )
            _cron(home, provider, python)
            kind = "cron"
            for path in list(files):
                if path.suffix in {".service", ".timer"}:
                    path.unlink(missing_ok=True)
                    del files[path]
        elif previous.get("kind") == "cron":
            _cron(home, provider, python, remove=True)
    value = {
        "status": "installed",
        "kind": kind,
        "provider": provider,
        "interval_seconds": INTERVAL_SECONDS,
        "id": label,
        "files": [str(path) for path in files],
    }
    _atomic_json(home / "sherlock" / "scheduler.json", value)
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall", "status"))
    parser.add_argument("--provider", choices=("codex", "claude_code"), default="codex")
    parser.add_argument("--home", type=Path)
    args = parser.parse_args(argv)
    home = (
        (
            args.home
            or (
                default_claude_home()
                if args.provider == "claude_code"
                else default_codex_home()
            )
        )
        .expanduser()
        .resolve()
    )
    try:
        result = (
            scheduler_status(home, check_loaded=True)
            if args.action == "status"
            else install_scheduler(home, args.provider)
            if args.action == "install"
            else uninstall_scheduler(home, args.provider)
        )
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Sherlock scheduler {args.action} failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
