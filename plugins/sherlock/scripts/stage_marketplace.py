#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import uuid
from pathlib import Path


MARKETPLACE_PATHS = (
    Path(".agents/plugins/marketplace.json"),
    Path(".claude-plugin/marketplace.json"),
    Path("plugins/sherlock"),
    Path("plugins/sherlock-claude-code"),
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage Sherlock's client plugins in a durable local marketplace."
    )
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    return parser.parse_args()


def _write_windows_hooks(staging: Path, python: Path) -> None:
    codex_manifest = staging / "plugins" / "sherlock" / "hooks" / "hooks.json"
    codex = json.loads(codex_manifest.read_text(encoding="utf-8"))
    for event_name, groups in codex["hooks"].items():
        for group in groups:
            for handler in group["hooks"]:
                quoted_python = str(python).replace("'", "''")
                quoted_event = event_name.replace("'", "''")
                powershell = (
                    f"& '{quoted_python}' (Join-Path $env:PLUGIN_ROOT "
                    f"'scripts\\run_hook.py') '{quoted_event}'; exit $LASTEXITCODE"
                )
                encoded = base64.b64encode(powershell.encode("utf-16-le")).decode("ascii")
                handler["commandWindows"] = (
                    "powershell.exe -NoProfile -NonInteractive "
                    f"-ExecutionPolicy Bypass -EncodedCommand {encoded}"
                )
    codex_manifest.write_text(json.dumps(codex, indent=2) + "\n", encoding="utf-8")

    claude_manifest = staging / "plugins" / "sherlock-claude-code" / "hooks" / "hooks.json"
    claude = json.loads(claude_manifest.read_text(encoding="utf-8"))
    for event_name, groups in claude["hooks"].items():
        for group in groups:
            for handler in group["hooks"]:
                handler["command"] = str(python)
                handler["args"] = [
                    "${CLAUDE_PLUGIN_ROOT}/scripts/run_hook.py",
                    event_name,
                ]
    claude_manifest.write_text(json.dumps(claude, indent=2) + "\n", encoding="utf-8")


def copy_marketplace(source: Path, destination: Path, *, windows_python: Path | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination.parent, 0o700)
    staging = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    backup = destination.with_name(f".{destination.name}.previous")
    if backup.exists() and not destination.exists():
        os.replace(backup, destination)
    staging.mkdir(mode=0o700)
    try:
        for relative in MARKETPLACE_PATHS:
            source_path = source / relative
            target_path = staging / relative
            if source_path.is_dir():
                shutil.copytree(
                    source_path,
                    target_path,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                )
            elif source_path.is_file():
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)
            else:
                raise SystemExit(f"missing marketplace source: {source_path}")
        if windows_python is not None:
            _write_windows_hooks(staging, windows_python)
        if backup.exists() and destination.exists():
            shutil.rmtree(backup)
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(staging, destination)
        except BaseException:
            if backup.exists() and not destination.exists():
                os.replace(backup, destination)
            raise
        if backup.exists() and destination.exists():
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    args = arguments()
    source = args.repo_root.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    copy_marketplace(
        source,
        destination,
        windows_python=Path(sys.executable).resolve() if os.name == "nt" else None,
    )
    print(f"Staged Sherlock's client marketplace under {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
