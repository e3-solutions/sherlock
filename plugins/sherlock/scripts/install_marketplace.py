#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any


MARKETPLACE_NAME = "sherlock"
PLUGIN_NAME = "sherlock"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Register this checkout as the Sherlock Codex marketplace."
    )
    parser.add_argument("--codex-bin", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    return parser.parse_args()


def run_codex(codex_bin: Path, *arguments: str) -> str:
    completed = subprocess.run(
        [str(codex_bin), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise SystemExit(f"Codex {' '.join(arguments[:3])} failed: {detail}")
    return completed.stdout


def is_sherlock_marketplace(root: Path) -> bool:
    manifest = root / ".agents" / "plugins" / "marketplace.json"
    try:
        value: Any = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(value, dict) or value.get("name") != MARKETPLACE_NAME:
        return False
    plugins = value.get("plugins")
    return isinstance(plugins, list) and any(
        isinstance(plugin, dict) and plugin.get("name") == PLUGIN_NAME
        for plugin in plugins
    )


def main() -> int:
    args = arguments()
    # Preserve the launcher name for multicall binaries such as VP's codex symlink.
    codex_bin = args.codex_bin.expanduser().absolute()
    repo_root = args.repo_root.expanduser().resolve()
    raw = run_codex(codex_bin, "plugin", "marketplace", "list", "--json")
    try:
        listing = json.loads(raw)
        marketplaces = listing["marketplaces"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise SystemExit("Codex returned an invalid marketplace list") from error

    matches = [
        marketplace
        for marketplace in marketplaces
        if isinstance(marketplace, dict)
        and marketplace.get("name") == MARKETPLACE_NAME
    ]
    if len(matches) > 1:
        raise SystemExit("Codex reported more than one Sherlock marketplace")
    if matches:
        current_root = Path(str(matches[0].get("root", ""))).expanduser().resolve()
        if current_root == repo_root:
            print("Sherlock marketplace already points at this checkout.")
            return 0
        if not is_sherlock_marketplace(current_root):
            raise SystemExit(
                "refusing to replace an existing unverified marketplace named sherlock"
            )
        run_codex(
            codex_bin,
            "plugin",
            "marketplace",
            "remove",
            MARKETPLACE_NAME,
            "--json",
        )

    run_codex(
        codex_bin,
        "plugin",
        "marketplace",
        "add",
        str(repo_root),
        "--json",
    )
    print("Registered this checkout as the Sherlock marketplace.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
