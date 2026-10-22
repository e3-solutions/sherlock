from __future__ import annotations

import base64
import json
import os
import time
import uuid
from collections import Counter
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
from .collection_receipt import (
    build_collection_receipt,
    load_collection_receipt,
)


# A stream whose oldest pending batch was enqueued this long ago and whose last
# upload attempt failed is reported as stalled: every later range in that stream
# waits behind it, so pending counts alone hide the backlog.
STALL_AFTER_SECONDS = 60 * 60
MAX_REPORTED_ERRORS = 5
MAX_REPORTED_ERROR_CHARS = 200


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _epoch_seconds(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _durable_replace(source: Path, destination: Path) -> None:
    os.replace(source, destination)
    _fsync_directory(destination.parent)
    if source.parent != destination.parent:
        _fsync_directory(source.parent)


def _durable_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    _fsync_directory(path.parent)


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
        _fsync_directory(path.parent)
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


def upload_backoff_seconds(attempts: int) -> int:
    return min(24 * 60 * 60, 60 * 2 ** min(attempts - 1, 11))


def upload_error_details(error: Exception) -> dict:
    return {
        "reason": str(error),
        "error_type": type(error).__name__,
        "error_code": getattr(error, "error_code", None),
        "http_status": getattr(error, "http_status", None),
        "failed_at": utc_now(),
    }


class DurableSpool:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.pending = self.root / "pending"
        self.processing = self.root / "processing"
        self.dead_letter = self.root / "dead-letter"
        self.receipts = self.root / "receipts"
        for directory in (
            self.pending,
            self.processing,
            self.dead_letter,
            self.receipts,
        ):
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

    def stalled_streams(
        self,
        *,
        stall_after_seconds: float = STALL_AFTER_SECONDS,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Summarize streams whose ordered head keeps failing to upload.

        Reads only manifests and metadata, never payload bytes. A head counts as
        stalled when its last attempt failed and it has waited at least
        ``stall_after_seconds`` since it was enqueued.
        """
        current = time.time() if now is None else now
        heads: dict[
            tuple[str, str],
            tuple[tuple[int, int, int, str], Mapping[str, Any]],
        ] = {}
        batches: Counter[tuple[str, str]] = Counter()
        for path in self.list_pending():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                manifest = BatchManifest.from_dict(value["manifest"])
                metadata = value.get("metadata", {})
                if not isinstance(metadata, dict):
                    continue
            except (
                OSError,
                UnicodeDecodeError,
                ValueError,
                KeyError,
                TypeError,
                ContractError,
            ):
                # Unreadable items are dead-lettered by the drain, which health
                # already reports.
                continue
            stream = manifest.stream_identity
            batches[stream] += 1
            order = (
                manifest.generation_seq,
                manifest.start_offset,
                manifest.end_offset,
                path.name,
            )
            if stream not in heads or order < heads[stream][0]:
                heads[stream] = (order, metadata)

        stalled: list[tuple[tuple[str, str], str, float]] = []
        for stream, (_, metadata) in heads.items():
            error = metadata.get("last_upload_error")
            if not isinstance(error, str) or not error:
                continue
            enqueued_at = _epoch_seconds(metadata.get("enqueued_at"))
            if enqueued_at is not None and current - enqueued_at < stall_after_seconds:
                continue
            waiting_since = current if enqueued_at is None else enqueued_at
            stalled.append((stream, error, waiting_since))

        errors: Counter[str] = Counter(
            error[:MAX_REPORTED_ERROR_CHARS] for _, error, _ in stalled
        )
        oldest = min((enqueued for _, _, enqueued in stalled), default=None)
        return {
            "stalled_streams": len(stalled),
            "stalled_batches": sum(batches[stream] for stream, _, _ in stalled),
            "oldest_stalled_enqueued_at": (
                datetime.fromtimestamp(oldest, timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
                if oldest is not None
                else None
            ),
            "stalled_errors": [
                {"error": error, "streams": count}
                for error, count in errors.most_common(MAX_REPORTED_ERRORS)
            ],
        }

    def list_collection_receipts(self) -> list[Path]:
        return sorted(self.receipts.glob("*.json"))

    def load_collection_receipt(self, path: Path) -> dict[str, object]:
        return load_collection_receipt(path)

    def record_collection_receipt(
        self,
        item: SpoolItem,
        server_receipt: Mapping[str, Any],
        token_payload: Mapping[str, Any],
    ) -> Path:
        destination = self.receipts / f"{item.manifest.spool_key}.json"
        value = build_collection_receipt(
            item.manifest,
            server_receipt,
            token_payload,
            recorded_at=utc_now(),
        )
        if destination.exists():
            existing = load_collection_receipt(destination)
            semantic_fields = ("server_receipt", "source", "token_payload")
            if any(existing[field] != value[field] for field in semantic_fields):
                raise ContractError(
                    "existing collection receipt conflicts with committed evidence"
                )
            return destination
        _atomic_json(destination, value)
        return destination

    def claim(self, path: Path) -> Path | None:
        claimed = self.processing / path.name
        try:
            _durable_replace(path, claimed)
        except FileNotFoundError:
            return None
        return claimed

    def recover_processing(self) -> int:
        recovered = 0
        for path in sorted(self.processing.glob("*.json")):
            _durable_replace(path, self.pending / path.name)
            recovered += 1
        return recovered

    def upload_status(self) -> dict:
        path = self.root / "upload-status.json"
        if not path.exists():
            return {"status": "ready"}
        try:
            value = json.loads(path.read_text())
            if value.get("status") not in {"ready", "blocked"}:
                raise ValueError("invalid upload status")
            if value["status"] == "blocked":
                float(value["next_upload_at"])
                int(value["attempts"])
            return value
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            raise ContractError(
                f"cannot read collector upload status: {error}"
            ) from error

    def defer_uploads(self, error: Exception) -> dict:
        previous = self.upload_status()
        attempts = (
            previous.get("attempts", 0) + 1 if previous["status"] == "blocked" else 1
        )
        status = {
            **upload_error_details(error),
            "status": "blocked",
            "attempts": attempts,
            "next_upload_at": time.time() + upload_backoff_seconds(attempts),
        }
        _atomic_json(self.root / "upload-status.json", status)
        return status

    def clear_upload_failure(self) -> None:
        previous = self.upload_status()
        if previous["status"] == "blocked":
            _atomic_json(
                self.root / "upload-status.json",
                {
                    **previous,
                    "status": "ready",
                    "recovered_at": utc_now(),
                },
            )

    def requeue(self, path: Path, item: SpoolItem, error: Exception) -> None:
        metadata = dict(item.metadata)
        attempts = int(metadata.get("upload_attempts", 0)) + 1
        metadata.update(
            {
                "upload_attempts": attempts,
                "next_upload_at": time.time() + upload_backoff_seconds(attempts),
                "last_upload_error": str(error),
                "last_upload_error_code": getattr(error, "error_code", None),
                "last_upload_http_status": getattr(error, "http_status", None),
                "last_upload_failed_at": utc_now(),
            }
        )
        rewritten = SpoolItem(item.manifest, item.stored_payload, metadata)
        _atomic_json(path, rewritten.to_dict())
        _durable_replace(path, self.pending / path.name)

    def quarantine(self, path: Path, item: SpoolItem | None, error: Exception) -> None:
        if item is None:
            original_bytes = path.read_bytes()
            try:
                raw = json.loads(original_bytes)
                if not isinstance(raw, dict):
                    raw = {"unreadable_value": raw}
            except Exception:
                raw = {
                    "unreadable_base64": base64.b64encode(path.read_bytes()).decode(
                        "ascii"
                    )
                }
            raw["original_spool_base64"] = base64.b64encode(original_bytes).decode(
                "ascii"
            )
            raw["dead_letter"] = {"reason": str(error), "failed_at": utc_now()}
            _atomic_json(path, raw)
        else:
            metadata = dict(item.metadata)
            metadata["dead_letter"] = upload_error_details(error)
            _atomic_json(
                path,
                SpoolItem(item.manifest, item.stored_payload, metadata).to_dict(),
            )
        destination = self.dead_letter / path.name
        if destination.exists():
            destination = self.dead_letter / f"{path.stem}.{uuid.uuid4().hex}.json"
        _durable_replace(path, destination)

    def acknowledge(self, path: Path) -> None:
        _durable_unlink(path)
