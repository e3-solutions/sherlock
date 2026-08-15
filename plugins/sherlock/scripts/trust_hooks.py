#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import selectors
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, TextIO


PLUGIN_ID = "sherlock@sherlock"
REQUEST_TIMEOUT_SECONDS = 20.0


class AppServerError(RuntimeError):
    pass


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trust only the installed Sherlock hooks using Codex's app-server API."
    )
    parser.add_argument("--codex-bin", required=True, type=Path)
    parser.add_argument("--codex-home", required=True, type=Path)
    parser.add_argument("--cwd", required=True, type=Path)
    return parser.parse_args()


class AppServer:
    def __init__(
        self,
        codex_bin: Path,
        *,
        codex_home: Path,
        cwd: Path,
    ) -> None:
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(codex_home)
        self._stderr = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        self._process = subprocess.Popen(
            [str(codex_bin), "app-server", "--stdio"],
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
            text=True,
            bufsize=1,
        )
        if self._process.stdin is None or self._process.stdout is None:
            raise AppServerError("failed to open Codex app-server pipes")
        self._stdin: TextIO = self._process.stdin
        self._stdout: TextIO = self._process.stdout
        self._selector = selectors.DefaultSelector()
        self._selector.register(self._stdout, selectors.EVENT_READ)

    def request(self, request_id: int, method: str, params: dict[str, Any]) -> Any:
        self._send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AppServerError(
                    f"timed out waiting for Codex {method}: {self._stderr_text()}"
                )
            if not self._selector.select(remaining):
                continue
            line = self._stdout.readline()
            if not line:
                raise AppServerError(
                    f"Codex app-server exited during {method}: {self._stderr_text()}"
                )
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise AppServerError(f"Codex {method} failed: {message['error']}")
            return message.get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def close(self) -> None:
        self._selector.close()
        self._stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=5)
        self._stderr.close()

    def _send(self, message: dict[str, Any]) -> None:
        self._stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self._stdin.flush()

    def _stderr_text(self) -> str:
        self._stderr.flush()
        self._stderr.seek(0)
        return self._stderr.read().strip()[-2000:]

    def __enter__(self) -> AppServer:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def sherlock_hooks(result: Any, codex_home: Path) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise AppServerError("Codex returned an invalid hooks/list response")
    expected_cache = (codex_home / "plugins" / "cache").resolve()
    matches: list[dict[str, Any]] = []
    for entry in result["data"]:
        for hook in entry.get("hooks", []):
            if hook.get("pluginId") != PLUGIN_ID:
                continue
            source_path = Path(str(hook.get("sourcePath", ""))).resolve()
            if hook.get("source") != "plugin" or not source_path.is_relative_to(
                expected_cache
            ):
                raise AppServerError(
                    "refusing to trust a Sherlock hook outside the Codex plugin cache"
                )
            if not str(hook.get("key", "")).startswith(f"{PLUGIN_ID}:"):
                raise AppServerError("refusing to trust a Sherlock hook with an invalid key")
            current_hash = hook.get("currentHash")
            if not isinstance(current_hash, str) or not current_hash.startswith("sha256:"):
                raise AppServerError("refusing to trust a hook without a Codex SHA-256 hash")
            matches.append(hook)
    if not matches:
        raise AppServerError("Codex did not discover any installed Sherlock hooks")
    return matches


def trust_key_path(key: str) -> str:
    return f"hooks.state.{json.dumps(key, ensure_ascii=False)}.trusted_hash"


def main() -> int:
    args = arguments()
    codex_bin = args.codex_bin.expanduser().resolve()
    codex_home = args.codex_home.expanduser().resolve()
    cwd = args.cwd.expanduser().resolve()
    if not codex_bin.is_file() or not os.access(codex_bin, os.X_OK):
        raise SystemExit(f"Codex executable is not usable: {codex_bin}")

    with AppServer(codex_bin, codex_home=codex_home, cwd=cwd) as server:
        server.request(
            1,
            "initialize",
            {
                "clientInfo": {"name": "sherlock-installer", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
        )
        server.notify("initialized")
        hooks = sherlock_hooks(
            server.request(2, "hooks/list", {"cwds": [str(cwd)]}),
            codex_home,
        )
        edits = [
            {
                "keyPath": trust_key_path(hook["key"]),
                "value": hook["currentHash"],
                "mergeStrategy": "upsert",
            }
            for hook in hooks
        ]
        server.request(
            3,
            "config/batchWrite",
            {"edits": edits, "reloadUserConfig": True},
        )
        verified = sherlock_hooks(
            server.request(4, "hooks/list", {"cwds": [str(cwd)]}),
            codex_home,
        )

    expected = {hook["key"]: hook["currentHash"] for hook in hooks}
    actual = {
        hook["key"]: hook["currentHash"]
        for hook in verified
        if hook.get("trustStatus") == "trusted"
    }
    if actual != expected:
        raise SystemExit("Codex did not persist trust for every Sherlock hook")
    print(f"Trusted {len(expected)} Sherlock hooks through Codex.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
