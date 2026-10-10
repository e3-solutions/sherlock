#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from trust_hooks import AppServer, AppServerError


REQUIRED_PLUGINS = (
    (
        "sherlock@sherlock",
        "rerun the Sherlock install command with your team identity",
    ),
    (
        "codex-session-logging@coreedge-local",
        "rerun the Core Edge Codex plugin setup or updater",
    ),
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify required local Codex telemetry plugins without changing them."
    )
    parser.add_argument("--codex-bin", required=True, type=Path)
    parser.add_argument("--codex-home", required=True, type=Path)
    parser.add_argument("--cwd", required=True, type=Path)
    return parser.parse_args()


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, sort_keys=True))


def manifest_is_valid(root: Path, plugin_id: str) -> bool:
    manifest = root / ".codex-plugin" / "plugin.json"
    try:
        value = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    expected_name = plugin_id.split("@", 1)[0]
    return isinstance(value, dict) and value.get("name") == expected_name


def runtime_status(
    plugin_id: str,
    hooks: list[dict[str, Any]],
    codex_home: Path,
) -> str:
    matches = [hook for hook in hooks if hook.get("pluginId") == plugin_id]
    if not matches:
        return "runtime_missing"
    expected_cache = (codex_home / "plugins" / "cache").resolve()
    roots: set[Path] = set()
    for hook in matches:
        source_path = Path(str(hook.get("sourcePath", ""))).resolve()
        if (
            hook.get("source") != "plugin"
            or hook.get("enabled") is not True
            or not str(hook.get("key", "")).startswith(f"{plugin_id}:")
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(hook.get("currentHash", "")))
            or not source_path.is_relative_to(expected_cache)
            or not source_path.is_file()
        ):
            return "runtime_invalid"
        if hook.get("trustStatus") != "trusted":
            return "untrusted"
        root = source_path.parent.parent
        roots.add(root)
        command = str(hook.get("command", ""))
        default_codex_home = (Path.home() / ".codex").resolve()
        if (
            codex_home != default_codex_home
            and "CODEX_HOME" not in command
            and str(codex_home) not in command
        ):
            return "runtime_path_mismatch"
        referenced_scripts = re.findall(r"scripts/([A-Za-z0-9_.-]+\.py)", command)
        if not referenced_scripts or any(
            not (root / "scripts" / script).is_file()
            for script in referenced_scripts
        ):
            return "runtime_invalid"
    if len(roots) != 1 or not manifest_is_valid(next(iter(roots)), plugin_id):
        return "runtime_invalid"
    return "ready"


def discovered_hooks(result: Any, expected_cwd: Path) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise AppServerError("Codex returned an invalid hooks/list response")
    entries = [entry for entry in result["data"] if isinstance(entry, dict)]
    matches = []
    for entry in entries:
        raw_cwd = entry.get("cwd")
        if (
            isinstance(raw_cwd, str)
            and raw_cwd
            and Path(raw_cwd).resolve() == expected_cwd
        ):
            matches.append(entry)
    if len(matches) != 1:
        raise AppServerError("Codex did not return exactly one hooks/list entry for cwd")
    entry = matches[0]
    if entry.get("warnings") != [] or entry.get("errors") != []:
        raise AppServerError("Codex reported hook discovery warnings or errors")
    if not isinstance(entry.get("hooks"), list) or any(
        not isinstance(hook, dict) for hook in entry["hooks"]
    ):
        raise AppServerError("Codex returned an invalid hooks/list entry")
    return entry["hooks"]


def main() -> int:
    args = arguments()
    # Preserve the launcher name for multicall binaries such as VP's codex symlink.
    codex_bin = args.codex_bin.expanduser().absolute()
    codex_home = args.codex_home.expanduser().resolve()
    cwd = args.cwd.expanduser().resolve()
    completed = subprocess.run(
        [str(codex_bin), "plugin", "list", "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        emit(
            {
                "status": "error",
                "problem": "plugin_listing_failed",
                "detail": completed.stderr.strip() or completed.stdout.strip(),
                "action": "confirm the Codex CLI is healthy, then rerun ./sherlock verify",
            }
        )
        return 1

    try:
        listing = json.loads(completed.stdout)
        installed = listing["installed"]
        if not isinstance(installed, list):
            raise TypeError("installed is not a list")
    except (json.JSONDecodeError, KeyError, TypeError):
        emit(
            {
                "status": "error",
                "problem": "invalid_plugin_listing",
                "action": "update or repair the Codex CLI, then rerun ./sherlock verify",
            }
        )
        return 1

    try:
        with AppServer(codex_bin, codex_home=codex_home, cwd=cwd) as server:
            server.request(
                1,
                "initialize",
                {
                    "clientInfo": {"name": "sherlock-verifier", "version": "1"},
                    "capabilities": {"experimentalApi": True},
                },
            )
            server.notify("initialized")
            hooks = discovered_hooks(
                server.request(2, "hooks/list", {"cwds": [str(cwd)]}),
                cwd,
            )
    except (OSError, AppServerError) as error:
        emit(
            {
                "status": "error",
                "problem": "hooks_listing_failed",
                "detail": str(error),
                "action": "confirm Codex can load local hooks, then rerun ./sherlock verify",
            }
        )
        return 1

    required_plugins = []
    actions = []
    for plugin_id, remediation in REQUIRED_PLUGINS:
        matches = [
            item
            for item in installed
            if isinstance(item, dict) and item.get("pluginId") == plugin_id
        ]
        if not matches:
            status = "missing"
        elif len(matches) > 1:
            status = "ambiguous"
        elif matches[0].get("installed") is not True:
            status = "not_installed"
        elif matches[0].get("enabled") is not True:
            status = "disabled"
        else:
            status = runtime_status(plugin_id, hooks, codex_home)
        required_plugins.append({"plugin_id": plugin_id, "status": status})
        if status != "ready":
            actions.append(f"{plugin_id}: {remediation}")

    healthy = not actions
    emit(
        {
            "status": "ok" if healthy else "degraded",
            "required_plugins": required_plugins,
            "actions": actions,
            "scope": "local plugin metadata, trusted runtime hooks, and referenced cache files only; remote telemetry delivery is not checked",
        }
    )
    return 0 if healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
