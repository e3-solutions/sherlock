#!/usr/bin/env python3
"""Shared native client installer used by the PowerShell entrypoints."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from install import atomic_json, existing_installation_id, install_runtime
from install_marketplace import is_sherlock_marketplace, run_codex
from process_command import executable_command
from stage_marketplace import copy_marketplace


DEFAULT_ENDPOINT = "https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest"


@dataclass(frozen=True)
class Provider:
    name: str
    executable: Path
    home: Path
    identity: dict[str, str]


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Sherlock for native agent CLIs.")
    parser.add_argument("action", nargs="?", default="install", choices=("install",))
    parser.add_argument("--providers", choices=("auto", "codex", "claude_code"), default="auto")
    parser.add_argument("--name", required=True)
    parser.add_argument("--github", "--github-id", "--github_id", dest="github_id", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--sherlock-home", type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--claude-home", type=Path)
    parser.add_argument("--endpoint", default=os.environ.get("SHERLOCK_INGEST_URL", DEFAULT_ENDPOINT))
    return parser.parse_args()


def run_cli(executable: Path, *args: str, capture: bool = False) -> subprocess.CompletedProcess[str]:
    try:
        command = executable_command(executable)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    completed = subprocess.run(
        [*command, *args], check=False, capture_output=capture, text=True
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise SystemExit(f"{executable.name} {' '.join(args[:3])} failed: {detail}")
    return completed


def resolve_cli(name: str, environment_name: str) -> tuple[Path | None, str]:
    configured = os.environ.get(environment_name)
    candidate = configured or shutil.which(name)
    if not candidate:
        return None, "not found"
    path = Path(candidate).expanduser().absolute()
    if not path.is_file():
        return None, f"configured {environment_name} does not exist" if configured else "not found"
    try:
        run_cli(path, "--version", capture=True)
    except SystemExit as error:
        return None, str(error)
    return path, ""


def load_config_api(repo_root: Path):
    package_root = repo_root / "packages" / "telemetry-collector" / "src"
    if not (package_root / "sherlock_collector" / "cli.py").is_file():
        raise SystemExit("run this installer from a Sherlock repository checkout")
    sys.path.insert(0, str(package_root))
    from sherlock_collector.config import ConfigurationError, validate_endpoint, validate_install_email_for_home, validate_identity
    return ConfigurationError, validate_endpoint, validate_install_email_for_home, validate_identity


def preflight(
    repo_root: Path, name: str, github_id: str, email: str, endpoint: str,
    candidates: list[tuple[str, Path, Path]],
) -> tuple[str, list[Provider]]:
    ConfigurationError, validate_endpoint, validate_email, validate_identity = load_config_api(repo_root)
    try:
        normalized_endpoint = validate_endpoint(endpoint)
    except ConfigurationError as error:
        raise SystemExit(f"invalid collector endpoint: {error}") from error
    providers = []
    for provider_name, executable, home in candidates:
        config = home / "sherlock" / "collector.json"
        installation_id = existing_installation_id(config) or str(uuid.uuid4())
        try:
            validate_email(email, home)
            identity = validate_identity(
                name=name, github_id=github_id, email=email,
                installation_id=installation_id,
            ).to_dict()
        except ConfigurationError as error:
            raise SystemExit(f"invalid collector identity for {provider_name}: {error}") from error
        providers.append(Provider(provider_name, executable, home, identity))
    return normalized_endpoint, providers


def install_provider_runtime(repo_root: Path, provider: Provider, endpoint: str) -> None:
    package = repo_root / "packages" / "telemetry-collector" / "src" / "sherlock_collector"
    root = provider.home / "sherlock"
    install_runtime(package, root / "runtime" / "sherlock_collector")
    atomic_json(root / "collector.json", {"endpoint": endpoint, **provider.identity})


def backfill(provider: Provider) -> None:
    runtime = provider.home / "sherlock" / "runtime"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(filter(None, (str(runtime), environment.get("PYTHONPATH"))))
    home_flag = "--codex-home" if provider.name == "codex" else "--claude-home"
    completed = subprocess.run(
        [sys.executable, "-m", "sherlock_collector.cli", "--provider", provider.name,
         home_flag, str(provider.home), "--state-root", str(provider.home / "sherlock" / "telemetry"),
         "--config", str(provider.home / "sherlock" / "collector.json"),
         "backfill", "--lookback-seconds", "86400"],
        check=False, capture_output=True, text=True, env=environment,
    )
    label = "Codex" if provider.name == "codex" else "Claude Code"
    if completed.returncode:
        print(f"Warning: {label} backfill could not start; a later hook will retry it.", file=sys.stderr)
    else:
        print(f"{label} 24-hour backfill: {completed.stdout.strip()}")


def install_codex(provider: Provider, marketplace: Path, repo_root: Path) -> None:
    raw = run_codex(provider.executable, "plugin", "marketplace", "list", "--json")
    try:
        matches = [item for item in json.loads(raw)["marketplaces"] if isinstance(item, dict) and item.get("name") == "sherlock"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise SystemExit("Codex returned an invalid marketplace list") from error
    if len(matches) > 1:
        raise SystemExit("Codex reported more than one Sherlock marketplace")
    if matches:
        current = Path(str(matches[0].get("root", ""))).expanduser().resolve()
        if current != marketplace and not is_sherlock_marketplace(current):
            raise SystemExit("refusing to replace an existing unverified marketplace named sherlock")
        if current != marketplace:
            run_codex(provider.executable, "plugin", "marketplace", "remove", "sherlock", "--json")
    if not matches or Path(str(matches[0].get("root", ""))).expanduser().resolve() != marketplace:
        run_codex(provider.executable, "plugin", "marketplace", "add", str(marketplace), "--json")
    run_codex(provider.executable, "plugin", "add", "sherlock@sherlock", "--json")
    subprocess.run(
        [sys.executable, str(repo_root / "plugins/sherlock/scripts/trust_hooks.py"),
         "--codex-bin", str(provider.executable), "--codex-home", str(provider.home), "--cwd", str(marketplace)],
        check=True,
    )


def install_claude(provider: Provider, marketplace: Path, repo_root: Path) -> None:
    run_cli(provider.executable, "plugin", "validate", str(marketplace / "plugins/sherlock-claude-code"))
    run_cli(provider.executable, "plugin", "validate", str(marketplace))
    subprocess.run([*executable_command(provider.executable), "plugin", "marketplace", "remove", "sherlock"], check=False, capture_output=True)
    run_cli(provider.executable, "plugin", "marketplace", "add", str(marketplace))
    run_cli(provider.executable, "plugin", "install", "sherlock-claude-code@sherlock")
    subprocess.run(
        [sys.executable, str(repo_root / "plugins/sherlock-claude-code/scripts/verify_install.py")],
        check=True, env={**os.environ, "CLAUDE_CONFIG_DIR": str(provider.home)},
    )


def main() -> int:
    args = arguments()
    repo_root = args.repo_root.expanduser().resolve()
    homes = {
        "codex": (args.codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex"),
        "claude_code": (args.claude_home or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"),
    }
    requested = ("codex", "claude_code") if args.providers == "auto" else (args.providers,)
    details = {"codex": ("codex", "CODEX_BIN"), "claude_code": ("claude", "CLAUDE_BIN")}
    candidates = []
    skipped = {}
    for provider_name in requested:
        executable, reason = resolve_cli(*details[provider_name])
        if executable is None:
            skipped[provider_name] = reason
        else:
            candidates.append((provider_name, executable, Path(homes[provider_name]).expanduser().resolve()))
    if not candidates:
        raise SystemExit("No usable requested Codex or Claude Code CLI was found; nothing was installed.")

    endpoint, providers = preflight(repo_root, args.name, args.github_id, args.email, args.endpoint, candidates)
    sherlock_home = Path(args.sherlock_home or os.environ.get("SHERLOCK_HOME") or Path.home() / ".sherlock").expanduser().resolve()
    marketplace = sherlock_home / "marketplace"
    copy_marketplace(
        repo_root,
        marketplace,
        windows_python=Path(sys.executable).resolve() if os.name == "nt" else None,
    )
    for provider in providers:
        install_provider_runtime(repo_root, provider, endpoint)
        backfill(provider)
        if provider.name == "codex":
            install_codex(provider, marketplace, repo_root)
        else:
            install_claude(provider, marketplace, repo_root)
    print("Sherlock installation summary:")
    for provider_name, label in (("codex", "Codex"), ("claude_code", "Claude Code")):
        if provider_name in requested:
            print(f"  {label}: {'installed' if any(p.name == provider_name for p in providers) else 'skipped - ' + skipped[provider_name]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
