from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class ConfigurationError(ValueError):
    """Collector configuration is missing or unsafe."""


@dataclass(frozen=True)
class CollectorConfig:
    endpoint: str
    token: str


def default_codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return (
        Path(configured).expanduser().resolve()
        if configured
        else (Path.home() / ".codex").resolve()
    )


def default_state_root(codex_home: Path | str | None = None) -> Path:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    return home / "sherlock" / "telemetry"


def default_config_path(codex_home: Path | str | None = None) -> Path:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    return home / "sherlock" / "collector.json"


def _validate_endpoint(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError("SHERLOCK_INGEST_URL is required")
    parsed = urlparse(value)
    local_http = parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    if parsed.scheme != "https" and not local_http:
        raise ConfigurationError("the ingest endpoint must use HTTPS")
    if not parsed.netloc or parsed.username or parsed.password:
        raise ConfigurationError("the ingest endpoint is invalid")
    return value


def _read_owner_only(path: Path) -> dict[str, object]:
    try:
        details = path.stat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(details.st_mode):
        raise ConfigurationError("the collector config must be a regular file")
    if stat.S_IMODE(details.st_mode) & 0o077:
        raise ConfigurationError("the collector config must be owner-only (mode 0600)")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConfigurationError("the collector config is unreadable") from error
    if not isinstance(value, dict):
        raise ConfigurationError("the collector config must be a JSON object")
    unexpected = set(value) - {"endpoint", "token"}
    if unexpected:
        raise ConfigurationError("the collector config contains unsupported fields")
    return value


def load_config(
    path: Path | str | None = None,
    *,
    codex_home: Path | str | None = None,
) -> CollectorConfig:
    file_values: dict[str, object] = {}
    endpoint = os.environ.get("SHERLOCK_INGEST_URL")
    token = os.environ.get("SHERLOCK_INGEST_TOKEN")
    if endpoint is None or token is None:
        file_values = _read_owner_only(
            Path(path or default_config_path(codex_home)).expanduser().resolve()
        )
    endpoint = endpoint if endpoint is not None else file_values.get("endpoint")
    token = token if token is not None else file_values.get("token")
    if not isinstance(token, str) or not token:
        raise ConfigurationError("SHERLOCK_INGEST_TOKEN is required")
    return CollectorConfig(_validate_endpoint(endpoint), token)
