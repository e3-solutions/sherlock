from __future__ import annotations

import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class ConfigurationError(ValueError):
    """Collector configuration is missing or unsafe."""


@dataclass(frozen=True)
class CollectorIdentity:
    name: str
    github_id: str
    email: str
    installation_id: str

    def to_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "github_id": self.github_id,
            "email": self.email,
            "installation_id": self.installation_id,
        }


@dataclass(frozen=True)
class CollectorConfig:
    endpoint: str
    identity: CollectorIdentity


GITHUB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
APPROVED_EMAIL_DOMAINS = frozenset({"e3group.ai", "sixtyfour.ai"})


def default_codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return (
        Path(configured).expanduser().resolve()
        if configured
        else (Path.home() / ".codex").resolve()
    )


def default_claude_home() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    return (
        Path(configured).expanduser().resolve()
        if configured
        else (Path.home() / ".claude").resolve()
    )


def default_state_root(codex_home: Path | str | None = None) -> Path:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    return home / "sherlock" / "telemetry"


def default_config_path(codex_home: Path | str | None = None) -> Path:
    home = Path(codex_home or default_codex_home()).expanduser().resolve()
    return home / "sherlock" / "collector.json"


def validate_endpoint(value: object) -> str:
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


def validate_install_email(value: object) -> str:
    normalized_email = _bounded(value, "email", 320).lower()
    if (
        normalized_email.count("@") != 1
        or any(character.isspace() or ord(character) < 32 for character in normalized_email)
    ):
        raise ConfigurationError("email must be a valid address")
    local, domain = normalized_email.split("@")
    if not local or domain not in APPROVED_EMAIL_DOMAINS:
        raise ConfigurationError(
            "email must use the e3group.ai or sixtyfour.ai work domain"
        )
    return normalized_email


def _require_clean_or_configured_collector_home(
    collector_home: Path | str,
) -> None:
    queue_root = (
        Path(collector_home).expanduser().resolve()
        / "sherlock"
        / "telemetry"
        / "queue"
    )
    for directory_name in ("pending", "processing"):
        if any((queue_root / directory_name).glob("*.json")):
            raise ConfigurationError(
                "pending collector telemetry exists without collector.json; "
                "recover the config or use a separate clean collector home"
            )


def validate_install_email_for_home(
    value: object,
    collector_home: Path | str,
) -> str:
    normalized_email = validate_install_email(value)
    config_path = (
        Path(collector_home).expanduser().resolve() / "sherlock" / "collector.json"
    )
    existing = _read_owner_only(config_path)
    if not existing:
        _require_clean_or_configured_collector_home(collector_home)
        return normalized_email
    existing_email = existing.get("email")
    try:
        normalized_existing_email = validate_install_email(existing_email)
    except ConfigurationError as error:
        raise ConfigurationError(
            "the existing collector email is invalid; use a separate clean collector home"
        ) from error
    if normalized_existing_email != normalized_email:
        raise ConfigurationError(
            "the collector email cannot be changed; use a separate clean collector home"
        )
    return normalized_email


def _bounded(value: object, field: str, maximum_bytes: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{field} is required")
    normalized = value.strip()
    if len(normalized.encode("utf-8")) > maximum_bytes:
        raise ConfigurationError(f"{field} exceeds {maximum_bytes} UTF-8 bytes")
    return normalized


def validate_identity(
    *,
    name: object,
    github_id: object,
    email: object,
    installation_id: object,
) -> CollectorIdentity:
    normalized_name = _bounded(name, "name", 256)
    normalized_github_id = _bounded(github_id, "github_id", 39).lower()
    if not GITHUB_ID.fullmatch(normalized_github_id):
        raise ConfigurationError("github_id must be a GitHub login")
    normalized_email = _bounded(email, "email", 320).lower()
    if (
        normalized_email.count("@") != 1
        or any(character.isspace() or ord(character) < 32 for character in normalized_email)
    ):
        raise ConfigurationError("email must be a valid address")
    local, domain = normalized_email.split("@")
    if not local or not domain or domain.startswith(".") or domain.endswith("."):
        raise ConfigurationError("email must be a valid address")
    try:
        parsed_installation_id = uuid.UUID(str(installation_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ConfigurationError("installation_id must be a UUIDv4") from error
    if parsed_installation_id.version != 4 or str(parsed_installation_id) != str(
        installation_id
    ).lower():
        raise ConfigurationError("installation_id must be a canonical UUIDv4")
    return CollectorIdentity(
        name=normalized_name,
        github_id=normalized_github_id,
        email=normalized_email,
        installation_id=str(parsed_installation_id),
    )


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
    # Accept but ignore tokens left by the previous authenticated collector so
    # upgrading the runtime cannot strand already-spooled telemetry.
    unexpected = set(value) - {
        "endpoint",
        "token",
        "name",
        "github_id",
        "email",
        "installation_id",
    }
    if unexpected:
        raise ConfigurationError("the collector config contains unsupported fields")
    return value


def load_config(
    path: Path | str | None = None,
    *,
    codex_home: Path | str | None = None,
) -> CollectorConfig:
    config_path = Path(path or default_config_path(codex_home)).expanduser().resolve()
    file_values = _read_owner_only(config_path)
    if not config_path.exists():
        source_home = (
            Path(codex_home).expanduser().resolve()
            if codex_home is not None
            else config_path.parent.parent
        )
        _require_clean_or_configured_collector_home(source_home)
    endpoint = os.environ.get("SHERLOCK_INGEST_URL")
    if endpoint is None:
        endpoint = file_values.get("endpoint")
    identity = validate_identity(
        name=os.environ.get("SHERLOCK_NAME", file_values.get("name")),
        github_id=os.environ.get(
            "SHERLOCK_GITHUB_ID", file_values.get("github_id")
        ),
        email=os.environ.get("SHERLOCK_EMAIL", file_values.get("email")),
        installation_id=os.environ.get(
            "SHERLOCK_INSTALLATION_ID", file_values.get("installation_id")
        ),
    )
    if config_path.exists():
        installed_identity = validate_identity(
            name=file_values.get("name"),
            github_id=file_values.get("github_id"),
            email=file_values.get("email"),
            installation_id=file_values.get("installation_id"),
        )
        if identity.email != installed_identity.email:
            raise ConfigurationError(
                "SHERLOCK_EMAIL must match the installed collector email"
            )
        if identity.installation_id != installed_identity.installation_id:
            raise ConfigurationError(
                "SHERLOCK_INSTALLATION_ID must match the installed collector installation_id"
            )
    return CollectorConfig(validate_endpoint(endpoint), identity)
