#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
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


def copy_marketplace(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination.parent, 0o700)
    staging = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    backup = destination.with_name(f".{destination.name}.previous")
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
        if backup.exists():
            shutil.rmtree(backup)
        if destination.exists():
            os.replace(destination, backup)
        os.replace(staging, destination)
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    args = arguments()
    source = args.repo_root.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    copy_marketplace(source, destination)
    print(f"Staged Sherlock's client marketplace under {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
