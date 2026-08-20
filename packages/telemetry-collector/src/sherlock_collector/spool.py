from __future__ import annotations

import base64
import json
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .contract import (
    BatchManifest,
    ContractError,
    SPOOL_VERSION,
    validate_stored_payload,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def secure_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.chmod(path, 0o600)
    return os.fdopen(descriptor, "a+b")


@dataclass(frozen=True)
class SpoolItem:
    manifest: BatchManifest
    stored_payload: bytes
    metadata: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "spool_version": SPOOL_VERSION,
            "manifest": self.manifest.to_dict(),
            "stored_payload_base64": base64.b64encode(self.stored_payload).decode(
                "ascii"
            ),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "SpoolItem":
        if value.get("spool_version") != SPOOL_VERSION:
            raise ContractError("unsupported spool_version")
        raw_manifest = value.get("manifest")
        if not isinstance(raw_manifest, dict):
            raise ContractError("spool manifest must be an object")
        payload = value.get("stored_payload_base64")
        if not isinstance(payload, str):
            raise ContractError("spool payload must be base64")
        try:
            stored = base64.b64decode(payload, validate=True)
        except ValueError as error:
            raise ContractError("spool payload is invalid base64") from error
        metadata = value.get("metadata", {})
        if not isinstance(metadata, dict):
            raise ContractError("spool metadata must be an object")
        manifest = BatchManifest.from_dict(raw_manifest)
        validate_stored_payload(manifest, stored)
        return cls(manifest, stored, metadata)


class DurableSpool:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.pending = self.root / "pending"
        self.processing = self.root / "processing"
        self.dead_letter = self.root / "dead-letter"
        for directory in (self.pending, self.processing, self.dead_letter):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(directory, 0o700)

    @property
    def lock_path(self) -> Path:
        return self.root / "drain.lock"

    def enqueue(
        self,
        manifest: BatchManifest,
        stored_payload: bytes,
        *,
        workload_class: str | None = None,
    ) -> Path:
        validate_stored_payload(manifest, stored_payload)
        if workload_class not in {None, "live", "backfill"}:
            raise ContractError("spool workload_class is unsupported")
        metadata = {"enqueued_at": utc_now()}
        if workload_class is not None:
            metadata["workload_class"] = workload_class
        item = SpoolItem(manifest, stored_payload, metadata)
        destination = self.pending / f"{manifest.spool_key}.json"
        if destination.exists():
            existing = self.load(destination)
            if (
                existing.manifest != manifest
                or existing.stored_payload != stored_payload
            ):
                raise ContractError(
                    "deterministic spool key collided with different bytes"
                )
            return destination
        _atomic_json(destination, item.to_dict())
        return destination

    def list_pending(self) -> list[Path]:
        return sorted(self.pending.glob("*.json"))

    def load(self, path: Path) -> SpoolItem:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContractError(
                f"cannot read spool item {path.name}: {error}"
            ) from error
        if not isinstance(value, dict):
            raise ContractError("spool item must be a JSON object")
        return SpoolItem.from_dict(value)

    def claim(self, path: Path) -> Path | None:
        claimed = self.processing / path.name
        try:
            os.replace(path, claimed)
        except FileNotFoundError:
            return None
        return claimed

    def recover_processing(self) -> int:
        recovered = 0
        for path in sorted(self.processing.glob("*.json")):
            os.replace(path, self.pending / path.name)
            recovered += 1
        return recovered

    def requeue(self, path: Path, item: SpoolItem, error: Exception) -> None:
        metadata = dict(item.metadata)
        metadata.update(
            {
                "last_upload_error": str(error),
                "last_upload_failed_at": utc_now(),
            }
        )
        rewritten = SpoolItem(item.manifest, item.stored_payload, metadata)
        _atomic_json(path, rewritten.to_dict())
        os.replace(path, self.pending / path.name)

    def quarantine(self, path: Path, item: SpoolItem | None, error: Exception) -> None:
        if item is None:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raw = {"unreadable_value": raw}
            except Exception:
                raw = {
                    "unreadable_base64": base64.b64encode(path.read_bytes()).decode(
                        "ascii"
                    )
                }
            raw["dead_letter"] = {"reason": str(error), "failed_at": utc_now()}
            _atomic_json(path, raw)
        else:
            metadata = dict(item.metadata)
            metadata["dead_letter"] = {"reason": str(error), "failed_at": utc_now()}
            _atomic_json(
                path,
                SpoolItem(item.manifest, item.stored_payload, metadata).to_dict(),
            )
        os.replace(path, self.dead_letter / path.name)

    def acknowledge(self, path: Path) -> None:
        path.unlink(missing_ok=True)
        (self.dead_letter / path.name).unlink(missing_ok=True)
