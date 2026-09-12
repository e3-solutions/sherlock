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
_NPM_NATIVE_BINARY = re.compile(
    r"%(?:~dp0|dp0%)[\\/](?P<binary>[^\"\r\n]+\.exe)\"?\s+%\*",
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
    scripts = list(_NPM_SCRIPT.finditer(contents))
    if scripts:
        script = _relative_shim_target(path, scripts[0].group("script"))
        if not script.is_file():
            raise ValueError(f"Windows CLI shim target does not exist: {script}")
        adjacent_node = path.parent / "node.exe"
        node = str(adjacent_node) if adjacent_node.is_file() else shutil.which("node.exe")
        if not node:
            raise ValueError(f"node.exe was not found for Windows CLI shim: {path}")
        return [node, str(script)]

    binaries = list(_NPM_NATIVE_BINARY.finditer(contents))
    if binaries:
        binary = _relative_shim_target(path, binaries[0].group("binary"))
        if not binary.is_file():
            raise ValueError(f"Windows CLI shim target does not exist: {binary}")
        return [str(binary)]

    raise ValueError(
        f"unsupported Windows CLI shim {path}; expected a standard npm CLI shim"
    )


def _relative_shim_target(shim: Path, relative: str) -> Path:
    target = (shim.parent / relative.replace("\\", "/")).resolve()
    try:
        target.relative_to(shim.parent.resolve())
    except ValueError as error:
        raise ValueError(f"Windows CLI shim target escapes its install root: {target}") from error
    return target
