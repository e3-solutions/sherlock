from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from .contract import (
    RECEIPT_FIELDS,
    SHA256_RE,
    BatchManifest,
    ContractError,
    sha256_hex,
    validate_committed_receipt,
    validate_stored_payload,
)


COLLECTION_RECEIPT_VERSION = "sherlock.collection-receipt.v1"
TOKEN_PRESENCE = frozenset({"present", "absent", "unknown"})
TOKEN_SCAN_FIELDS = frozenset({
    "presence",
    "scanned_complete_records",
    "uninspectable_records",
    "record_count",
    "token_count_records",
    "token_payload_records",
    "scope",
})
TOKEN_SCOPE_FIELDS = frozenset({"start_offset", "end_offset", "source_sha256"})
COLLECTION_RECEIPT_FIELDS = frozenset({
    "collection_receipt_version",
    "recorded_at",
    "server_receipt",
    "source",
    "token_payload",
})


def _integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ContractError(f"{field} must be a non-negative integer")
    return value


def _scope(value: Mapping[str, object]) -> dict[str, object]:
    if set(value) != TOKEN_SCOPE_FIELDS:
        raise ContractError("token scan scope fields are unsupported")
    start = _integer(value.get("start_offset"), "scope.start_offset")
    end = _integer(value.get("end_offset"), "scope.end_offset")
    source_hash = value.get("source_sha256")
    if end <= start:
        raise ContractError("token scan scope must be non-empty")
    if not isinstance(source_hash, str) or not SHA256_RE.fullmatch(source_hash):
        raise ContractError("scope.source_sha256 must be a lowercase SHA-256")
    return {
        "start_offset": start,
        "end_offset": end,
        "source_sha256": source_hash,
    }


def _nonempty_object(value: object) -> bool:
    return isinstance(value, Mapping) and bool(value)


def record_token_payload(
    value: object,
    source_provider: str,
) -> bool | None:
    """Classify one parsed native record without interpreting token values."""
    if source_provider not in {"codex", "claude_code"}:
        return None
    if not isinstance(value, Mapping):
        return False
    if source_provider == "codex":
        payload = value.get("payload")
        if not isinstance(payload, Mapping) or payload.get("type") != "token_count":
            return False
        info = payload.get("info")
        usage_objects: list[object] = [payload.get("usage")]
        if isinstance(info, Mapping):
            usage_objects.extend((
                info.get("total_token_usage"),
                info.get("last_token_usage"),
            ))
        return any(_nonempty_object(item) for item in usage_objects)
    if value.get("type") != "assistant":
        return False
    message = value.get("message")
    usage = message.get("usage") if isinstance(message, Mapping) else None
    return _nonempty_object(usage)


def _record_token_evidence(
    record: object,
    *,
    source_provider: str,
    source_kind: str,
) -> tuple[bool, bool]:
    token_payload = record_token_payload(record, source_provider)
    if source_provider == "codex" and source_kind == "rollout":
        if not isinstance(record, Mapping):
            return False, token_payload is True
        payload = record.get("payload")
        marker = isinstance(payload, Mapping) and payload.get("type") == "token_count"
        return marker, token_payload is True
    return False, token_payload is True and source_kind == "transcript"


def scan_token_records(
    records: Iterable[object],
    *,
    source_provider: str,
    source_kind: str,
    scope: Mapping[str, object],
    uninspectable_records: int = 0,
) -> dict[str, object]:
    """Summarize token-payload presence without reading or storing token totals."""
    normalized_scope = _scope(scope)
    uninspectable = _integer(uninspectable_records, "uninspectable_records")
    scanned = token_markers = token_payloads = 0
    for record in records:
        scanned += 1
        marker, payload = _record_token_evidence(
            record,
            source_provider=source_provider,
            source_kind=source_kind,
        )
        token_markers += int(marker)
        token_payloads += int(payload)
    presence = (
        "present"
        if token_payloads
        else "unknown"
        if uninspectable
        else "absent"
    )
    return {
        "presence": presence,
        "scanned_complete_records": scanned,
        "uninspectable_records": uninspectable,
        "record_count": scanned + uninspectable,
        "token_count_records": token_markers,
        "token_payload_records": token_payloads,
        "scope": normalized_scope,
    }


def scan_token_payload(
    manifest: BatchManifest,
    stored_payload: bytes,
) -> dict[str, object]:
    """Inspect the immutable captured range represented by a validated manifest."""
    source = validate_stored_payload(manifest, stored_payload)
    decoded: list[object] = []
    uninspectable = 0
    for locator in manifest.records:
        if locator.parse_status in {"fragment", "malformed"}:
            uninspectable += 1
            continue
        start = locator.source_start_offset - manifest.start_offset
        end = locator.source_end_offset - manifest.start_offset
        record_bytes = source[start:end]
        if sha256_hex(record_bytes) != locator.record_sha256:
            uninspectable += 1
            continue
        try:
            decoded.append(json.loads(record_bytes))
        except (UnicodeDecodeError, json.JSONDecodeError):
            uninspectable += 1
    return scan_token_records(
        decoded,
        source_provider=manifest.source_provider,
        source_kind=manifest.source_kind,
        scope={
            "start_offset": manifest.start_offset,
            "end_offset": manifest.end_offset,
            "source_sha256": manifest.source_sha256,
        },
        uninspectable_records=uninspectable,
    )


def build_collection_receipt(
    manifest: BatchManifest,
    server_receipt: Mapping[str, Any],
    token_payload: Mapping[str, Any],
    *,
    recorded_at: str,
) -> dict[str, object]:
    validated_server = validate_committed_receipt(manifest, server_receipt)
    normalized_scan = _validate_token_scan(token_payload, manifest)
    _validate_timestamp(recorded_at, "recorded_at")
    return {
        "collection_receipt_version": COLLECTION_RECEIPT_VERSION,
        "recorded_at": recorded_at,
        "server_receipt": {
            field: validated_server[field]
            for field in sorted(RECEIPT_FIELDS)
        },
        "source": manifest.to_dict(),
        "token_payload": normalized_scan,
    }


def _validate_timestamp(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ContractError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ContractError(f"{field} must include a timezone")
    return value


def _validate_token_scan(
    value: Mapping[str, Any],
    manifest: BatchManifest,
) -> dict[str, object]:
    if set(value) != TOKEN_SCAN_FIELDS:
        raise ContractError("token scan fields are unsupported")
    presence = value.get("presence")
    if not isinstance(presence, str) or presence not in TOKEN_PRESENCE:
        raise ContractError("token scan presence is unsupported")
    scanned = _integer(
        value.get("scanned_complete_records"),
        "scanned_complete_records",
    )
    uninspectable = _integer(
        value.get("uninspectable_records"),
        "uninspectable_records",
    )
    record_count = _integer(value.get("record_count"), "record_count")
    markers = _integer(value.get("token_count_records"), "token_count_records")
    payloads = _integer(
        value.get("token_payload_records"),
        "token_payload_records",
    )
    scope = value.get("scope")
    if not isinstance(scope, Mapping):
        raise ContractError("token scan scope must be an object")
    normalized_scope = _scope(scope)
    expected_scope = {
        "start_offset": manifest.start_offset,
        "end_offset": manifest.end_offset,
        "source_sha256": manifest.source_sha256,
    }
    if normalized_scope != expected_scope:
        raise ContractError("token scan scope does not match source manifest")
    if record_count != manifest.record_count or scanned + uninspectable != record_count:
        raise ContractError("token scan record counts do not match source manifest")
    if markers > scanned or payloads > scanned:
        raise ContractError("token scan evidence exceeds scanned records")
    if manifest.source_provider == "codex" and manifest.source_kind == "rollout":
        if payloads > markers:
            raise ContractError("Codex token payload evidence requires a token marker")
    elif markers:
        raise ContractError("token markers are unsupported for this source kind")
    expected_presence = (
        "present" if payloads else "unknown" if uninspectable else "absent"
    )
    if presence != expected_presence:
        raise ContractError("token scan presence conflicts with record evidence")
    return {
        "presence": presence,
        "scanned_complete_records": scanned,
        "uninspectable_records": uninspectable,
        "record_count": record_count,
        "token_count_records": markers,
        "token_payload_records": payloads,
        "scope": normalized_scope,
    }


def validate_collection_receipt(value: Mapping[str, Any]) -> dict[str, object]:
    if set(value) != COLLECTION_RECEIPT_FIELDS:
        raise ContractError("collection receipt fields are unsupported")
    if value.get("collection_receipt_version") != COLLECTION_RECEIPT_VERSION:
        raise ContractError("collection receipt version is unsupported")
    recorded_at = _validate_timestamp(value.get("recorded_at"), "recorded_at")
    source = value.get("source")
    server_receipt = value.get("server_receipt")
    token_payload = value.get("token_payload")
    if not isinstance(source, Mapping):
        raise ContractError("collection receipt source must be an object")
    if not isinstance(server_receipt, Mapping):
        raise ContractError("collection receipt server receipt must be an object")
    if not isinstance(token_payload, Mapping):
        raise ContractError("collection receipt token payload must be an object")
    manifest = BatchManifest.from_dict(source)
    validated_server = validate_committed_receipt(manifest, server_receipt)
    validated_scan = _validate_token_scan(token_payload, manifest)
    return {
        "collection_receipt_version": COLLECTION_RECEIPT_VERSION,
        "recorded_at": recorded_at,
        "server_receipt": validated_server,
        "source": manifest.to_dict(),
        "token_payload": validated_scan,
    }


def load_collection_receipt(path: Path | str) -> dict[str, object]:
    receipt_path = Path(path)
    try:
        value = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError(
            f"cannot read collection receipt {receipt_path.name}: {error}"
        ) from error
    if not isinstance(value, Mapping):
        raise ContractError("collection receipt must be an object")
    try:
        return validate_collection_receipt(value)
    except ContractError:
        raise
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise ContractError("collection receipt contains invalid nested values") from error
