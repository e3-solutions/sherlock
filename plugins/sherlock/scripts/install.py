#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import json
import os
import shutil
import sys
import uuid
from pathlib import Path


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Sherlock's collector runtime and owner-only local config."
    )
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument(
        "--token-stdin",
        action="store_true",
        help="Read the opaque collector token from one line on stdin.",
    )
    return parser.parse_args()


def atomic_json(path: Path, value: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def install_runtime(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    shutil.copytree(source, staging)
    backup = destination.with_name(f".{destination.name}.previous")
    if backup.exists():
        shutil.rmtree(backup)
    if destination.exists():
        os.replace(destination, backup)
    os.replace(staging, destination)
    if backup.exists():
        shutil.rmtree(backup)


def main() -> int:
    args = arguments()
    codex_home = Path(
        args.codex_home
        or os.environ.get("CODEX_HOME")
        or (Path.home() / ".codex")
    ).expanduser().resolve()
    repo_root = Path(__file__).resolve().parents[3]
    package = repo_root / "packages" / "telemetry-collector" / "src" / "sherlock_collector"
    if not package.is_dir():
        raise SystemExit("run this installer from a Sherlock repository checkout")
    sys.path.insert(0, str(package.parent))
    from sherlock_collector.config import ConfigurationError, validate_endpoint

    try:
        endpoint = validate_endpoint(args.endpoint)
    except ConfigurationError as error:
        raise SystemExit(f"invalid collector endpoint: {error}") from error
    if args.token_stdin:
        token = input().rstrip("\n")
    else:
        token = os.environ.get("SHERLOCK_INGEST_TOKEN") or getpass.getpass(
            "Sherlock collector token: "
        )
    if not token:
        raise SystemExit("collector token is required")
    root = codex_home / "sherlock"
    install_runtime(package, root / "runtime" / "sherlock_collector")
    atomic_json(root / "collector.json", {"endpoint": endpoint, "token": token})
    print(f"Installed collector runtime under {root}")
    print("Stored the endpoint and opaque token in owner-only collector.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
