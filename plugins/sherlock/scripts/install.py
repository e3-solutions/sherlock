#!/usr/bin/env python3
from __future__ import annotations

import argparse
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
    parser.add_argument("--codex-home", "--collector-home", dest="collector_home", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--github-id", "--github_id", dest="github_id", required=True)
    parser.add_argument("--email", required=True)
    return parser.parse_args()


def existing_installation_id(path: Path) -> str | None:
    try:
        if path.stat().st_mode & 0o077:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    candidate = value.get("installation_id")
    try:
        parsed = uuid.UUID(str(candidate))
    except (ValueError, TypeError, AttributeError):
        return None
    return str(parsed) if parsed.version == 4 and str(parsed) == candidate else None


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
    collector_home = Path(
        args.collector_home
        or os.environ.get("CODEX_HOME")
        or (Path.home() / ".codex")
    ).expanduser().resolve()
    repo_root = Path(__file__).resolve().parents[3]
    package = repo_root / "packages" / "telemetry-collector" / "src" / "sherlock_collector"
    if not package.is_dir():
        raise SystemExit("run this installer from a Sherlock repository checkout")
    sys.path.insert(0, str(package.parent))
    from sherlock_collector.config import (
        ConfigurationError,
        validate_endpoint,
        validate_install_email_for_home,
        validate_identity,
    )

    try:
        endpoint = validate_endpoint(args.endpoint)
    except ConfigurationError as error:
        raise SystemExit(f"invalid collector endpoint: {error}") from error
    root = collector_home / "sherlock"
    config_path = root / "collector.json"
    installation_id = existing_installation_id(config_path) or str(uuid.uuid4())
    try:
        validate_install_email_for_home(args.email, collector_home)
        identity = validate_identity(
            name=args.name,
            github_id=args.github_id,
            email=args.email,
            installation_id=installation_id,
        )
    except ConfigurationError as error:
        raise SystemExit(f"invalid collector identity: {error}") from error
    install_runtime(package, root / "runtime" / "sherlock_collector")
    atomic_json(
        config_path,
        {"endpoint": endpoint, **identity.to_dict()},
    )
    print(f"Installed collector runtime under {root}")
    print("Stored the endpoint and identity in owner-only collector.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
