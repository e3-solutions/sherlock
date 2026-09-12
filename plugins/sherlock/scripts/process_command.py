#!/usr/bin/env python3
"""Build safe subprocess argv for native executables and npm Windows shims."""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path


_NPM_SCRIPT = re.compile(
    r"%(?:~dp0|dp0%)[\\/](?P<script>[^\"\r\n]+\.js)\"?\s+%\*",
    re.IGNORECASE,
)


def executable_command(
    executable: str | Path, *, windows: bool | None = None
) -> list[str]:
    """Return an argv prefix which never delegates arguments to a command shell."""
    raw = str(executable)
    located = shutil.which(raw)
    path = Path(located or raw).expanduser().absolute()
    native_windows = os.name == "nt" if windows is None else windows
    if not native_windows or path.suffix.lower() not in {".cmd", ".bat"}:
        return [str(path)]

    try:
        contents = path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise ValueError(f"cannot read Windows CLI shim: {path}: {error}") from error
    matches = list(_NPM_SCRIPT.finditer(contents))
    if not matches:
        raise ValueError(
            f"unsupported Windows CLI shim {path}; expected a standard npm Node shim"
        )
    script = (path.parent / matches[0].group("script").replace("\\", "/")).resolve()
    if not script.is_file():
        raise ValueError(f"Windows CLI shim target does not exist: {script}")
    adjacent_node = path.parent / "node.exe"
    node = str(adjacent_node) if adjacent_node.is_file() else shutil.which("node.exe")
    if not node:
        raise ValueError(f"node.exe was not found for Windows CLI shim: {path}")
    return [node, str(script)]
