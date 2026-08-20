from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Mapping

CONTRACT_VERSION = "sherlock.rollout-batch.v1"
RECEIPT_VERSION = "sherlock.committed-receipt.v1"
SPOOL_VERSION = "sherlock.spool.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
NATIVE_LABEL_BYTES = 256
IDENTITY_HINT_BYTES = 512
VERSION_HINT_BYTES = 128
MAX_RECORDS = 20_000
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_STORED_BYTES = 17 * 1024 * 1024
FRAGMENT_BYTES = 4 * 1024 * 1024
MAX_LOGICAL_RECORD_BYTES = 100 * 1024 * 1024
SOURCE_KINDS = {
    "codex": frozenset({"rollout"}),
    "claude_code": frozenset({"transcript", "hook"}),
}


class ContractError(ValueError):
    """The local manifest, payload, or server receipt violates the contract."""


class ReceiptMismatch(ContractError):
    """A successful HTTP response did not acknowledge this exact batch."""


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} must be a non-empty string")
    return value


def _integer(value: Any, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ContractError(f"{field} must be an integer >= {minimum}")
    return value


def _hash(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ContractError(f"{field} must be a lowercase SHA-256")
    return value


def _bounded_text(value: str | None, field: str, limit: int) -> str | None:
    if value is None:
        return None
    _nonempty(value, field)
    if len(value.encode("utf-8")) > limit:
        raise ContractError(f"{field} exceeds {limit} UTF-8 bytes")
    return value


@dataclass(frozen=True)
class RecordLocator:
    record_index: int
    source_start_offset: int
    source_end_offset: int
    record_sha256: str
    native_type: str | None
    native_payload_type: str | None
    occurred_at: str | None
    parse_status: str
    native_record_start_offset: int | None = None
    native_record_end_offset: int | None = None
    native_record_sha256: str | None = None
    fragment_index: int | None = None
    fragment_count: int | None = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RecordLocator":
        parse_status = _nonempty(value.get("parse_status"), "record.parse_status")
        if parse_status not in {"ok", "unknown", "malformed", "fragment"}:
            raise ContractError("record.parse_status is unsupported")
        native_type = value.get("native_type")
        native_payload_type = value.get("native_payload_type")
        occurred_at = value.get("occurred_at")
        if occurred_at is not None:
            _nonempty(occurred_at, "record.occurred_at")
        return cls(
            record_index=_integer(value.get("record_index"), "record.record_index"),
            source_start_offset=_integer(
                value.get("source_start_offset"), "record.source_start_offset"
            ),
            source_end_offset=_integer(
                value.get("source_end_offset"), "record.source_end_offset", minimum=1
            ),
            record_sha256=_hash(value.get("record_sha256"), "record.record_sha256"),
            native_type=native_type,
            native_payload_type=native_payload_type,
            occurred_at=occurred_at,
            parse_status=parse_status,
            native_record_start_offset=(
                _integer(
                    value.get("native_record_start_offset"),
                    "record.native_record_start_offset",
                )
                if value.get("native_record_start_offset") is not None
                else None
            ),
            native_record_end_offset=(
                _integer(
                    value.get("native_record_end_offset"),
                    "record.native_record_end_offset",
                    minimum=1,
                )
                if value.get("native_record_end_offset") is not None
                else None
            ),
            native_record_sha256=(
                _hash(
                    value.get("native_record_sha256"),
                    "record.native_record_sha256",
                )
                if value.get("native_record_sha256") is not None
                else None
            ),
            fragment_index=(
                _integer(value.get("fragment_index"), "record.fragment_index")
                if value.get("fragment_index") is not None
                else None
            ),
            fragment_count=(
                _integer(
                    value.get("fragment_count"),
                    "record.fragment_count",
                    minimum=2,
                )
                if value.get("fragment_count") is not None
                else None
            ),
        )


@dataclass(frozen=True)
class BatchManifest:
    contract_version: str
    source_provider: str
    source_kind: str
    source_stream_key: str
    generation_key: str
    generation_seq: int
    start_offset: int
    end_offset: int
    source_byte_count: int
    source_sha256: str
    storage_encoding: str
    stored_byte_count: int
    stored_sha256: str
    record_count: int
    records: tuple[RecordLocator, ...]
    observed_native_session_id: str | None = None
    observed_parent_native_session_id: str | None = None
    first_occurred_at: str | None = None
    last_occurred_at: str | None = None
    codex_version: str | None = None
    source_version: str | None = None
    collector_version: str | None = None

    @property
    def stream_identity(self) -> tuple[str, str]:
        return (self.source_kind, self.source_stream_key)

    @property
    def spool_key(self) -> str:
        canonical = json.dumps(
            {
                "source_kind": self.source_kind,
                "source_stream_key": self.source_stream_key,
                "generation_key": self.generation_key,
                "generation_seq": self.generation_seq,
                "start_offset": self.start_offset,
                "end_offset": self.end_offset,
                "source_sha256": self.source_sha256,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return sha256_hex(canonical)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "BatchManifest":
        raw_records = value.get("records")
        if not isinstance(raw_records, list):
            raise ContractError("records must be an array")
        manifest = cls(
            contract_version=_nonempty(
                value.get("contract_version"), "contract_version"
            ),
            source_provider=_nonempty(
                value.get("source_provider", "codex"), "source_provider"
            ),
            source_kind=_nonempty(value.get("source_kind"), "source_kind"),
            source_stream_key=_nonempty(
                value.get("source_stream_key"), "source_stream_key"
            ),
            generation_key=_nonempty(value.get("generation_key"), "generation_key"),
            generation_seq=_integer(value.get("generation_seq"), "generation_seq"),
            start_offset=_integer(value.get("start_offset"), "start_offset"),
            end_offset=_integer(value.get("end_offset"), "end_offset", minimum=1),
            source_byte_count=_integer(
                value.get("source_byte_count"), "source_byte_count", minimum=1
            ),
            source_sha256=_hash(value.get("source_sha256"), "source_sha256"),
            storage_encoding=_nonempty(
                value.get("storage_encoding"), "storage_encoding"
            ),
            stored_byte_count=_integer(
                value.get("stored_byte_count"), "stored_byte_count", minimum=1
            ),
            stored_sha256=_hash(value.get("stored_sha256"), "stored_sha256"),
            record_count=_integer(value.get("record_count"), "record_count", minimum=1),
            records=tuple(RecordLocator.from_dict(record) for record in raw_records),
            observed_native_session_id=value.get("observed_native_session_id"),
            observed_parent_native_session_id=value.get(
                "observed_parent_native_session_id"
            ),
            first_occurred_at=value.get("first_occurred_at"),
            last_occurred_at=value.get("last_occurred_at"),
            codex_version=value.get("codex_version"),
            source_version=value.get("source_version", value.get("codex_version")),
            collector_version=value.get("collector_version"),
        )
        manifest.validate()
        return manifest

    def validate(self) -> None:
        if self.contract_version != CONTRACT_VERSION:
            raise ContractError("unsupported contract_version")
        if self.source_provider not in SOURCE_KINDS:
            raise ContractError("source_provider is unsupported")
        if self.source_kind not in SOURCE_KINDS[self.source_provider]:
            raise ContractError("source_kind does not match source_provider")
        if self.storage_encoding != "gzip":
            raise ContractError("the stable rollout encoding must be gzip")
        if self.end_offset <= self.start_offset:
            raise ContractError("batch byte range must be non-empty")
        if self.source_byte_count != self.end_offset - self.start_offset:
            raise ContractError("source_byte_count must equal the byte range")
        if self.record_count != len(self.records) or not self.records:
            raise ContractError("record_count must equal the non-empty records array")
        if (
            self.record_count > MAX_RECORDS
            or self.source_byte_count > MAX_SOURCE_BYTES
            or self.stored_byte_count > MAX_STORED_BYTES
        ):
            raise ContractError("batch exceeds rollout v1 limits")
        if (self.first_occurred_at is None) != (self.last_occurred_at is None):
            raise ContractError("first/last occurred timestamps must be paired")
        previous_end: int | None = None
        for index, record in enumerate(self.records):
            if record.record_index != index:
                raise ContractError("record indexes must be ordered and contiguous")
            if not (self.start_offset <= record.source_start_offset):
                raise ContractError("record starts before its batch")
            if not (
                record.source_start_offset < record.source_end_offset <= self.end_offset
            ):
                raise ContractError("record range is outside its batch")
            if previous_end is not None and record.source_start_offset < previous_end:
                raise ContractError("record ranges must be ordered and non-overlapping")
            previous_end = record.source_end_offset
        for field in ("first_occurred_at", "last_occurred_at"):
            item = getattr(self, field)
            if item is not None:
                _nonempty(item, field)
        _bounded_text(
            self.observed_native_session_id,
            "observed_native_session_id",
            IDENTITY_HINT_BYTES,
        )
        _bounded_text(
            self.observed_parent_native_session_id,
            "observed_parent_native_session_id",
            IDENTITY_HINT_BYTES,
        )
        _bounded_text(self.codex_version, "codex_version", VERSION_HINT_BYTES)
        _bounded_text(self.source_version, "source_version", VERSION_HINT_BYTES)
        _bounded_text(self.collector_version, "collector_version", VERSION_HINT_BYTES)
        for record in self.records:
            _bounded_text(record.native_type, "record.native_type", NATIVE_LABEL_BYTES)
            _bounded_text(
                record.native_payload_type,
                "record.native_payload_type",
                NATIVE_LABEL_BYTES,
            )
            fragment_fields = (
                record.native_record_start_offset,
                record.native_record_end_offset,
                record.native_record_sha256,
                record.fragment_index,
                record.fragment_count,
            )
            if record.parse_status != "fragment":
                if any(value is not None for value in fragment_fields):
                    raise ContractError(
                        "non-fragment records cannot include fragment metadata"
                    )
                continue
            if any(value is None for value in fragment_fields):
                raise ContractError("fragment record metadata must be complete")
            if (
                self.record_count != 1
                or record.source_start_offset != self.start_offset
                or record.source_end_offset != self.end_offset
            ):
                raise ContractError("fragment locator must cover its complete batch")
            if any(
                value is not None
                for value in (
                    record.native_type,
                    record.native_payload_type,
                    record.occurred_at,
                    self.first_occurred_at,
                    self.last_occurred_at,
                )
            ):
                raise ContractError("fragment records cannot include parsed metadata")
            assert record.native_record_start_offset is not None
            assert record.native_record_end_offset is not None
            assert record.fragment_index is not None
            assert record.fragment_count is not None
            native_length = (
                record.native_record_end_offset - record.native_record_start_offset
            )
            if not MAX_SOURCE_BYTES < native_length <= MAX_LOGICAL_RECORD_BYTES:
                raise ContractError("fragmented native record has invalid size")
            expected_count = (native_length + FRAGMENT_BYTES - 1) // FRAGMENT_BYTES
            expected_start = (
                record.native_record_start_offset
                + record.fragment_index * FRAGMENT_BYTES
            )
            expected_end = min(
                expected_start + FRAGMENT_BYTES,
                record.native_record_end_offset,
            )
            if (
                record.fragment_count != expected_count
                or record.fragment_index >= expected_count
                or record.source_start_offset != expected_start
                or record.source_end_offset != expected_end
            ):
                raise ContractError("fragment range or count is not canonical")


def _record_locator(
    record_bytes: bytes, absolute_start: int, index: int
) -> RecordLocator:
    stripped = record_bytes.rstrip(b"\r\n")
    native_type: str | None = None
    native_payload_type: str | None = None
    occurred_at: str | None = None
    parse_status = "malformed"
    try:
        decoded = json.loads(stripped)
        if isinstance(decoded, dict):
            parse_status = "ok"
            if (
                isinstance(decoded.get("type"), str)
                and decoded["type"].strip()
                and len(decoded["type"].encode("utf-8")) <= NATIVE_LABEL_BYTES
            ):
                native_type = decoded["type"]
            payload = decoded.get("payload")
            if isinstance(payload, dict):
                candidate = payload.get("type")
                if (
                    isinstance(candidate, str)
                    and candidate.strip()
                    and len(candidate.encode("utf-8")) <= NATIVE_LABEL_BYTES
                ):
                    native_payload_type = candidate
            for key in ("timestamp", "occurred_at", "time"):
                candidate = decoded.get(key)
                if (
                    isinstance(candidate, str)
                    and candidate.strip()
                    and RFC3339_RE.fullmatch(candidate)
                ):
                    try:
                        parsed = datetime.fromisoformat(
                            candidate.replace("Z", "+00:00")
                        )
                        if parsed.tzinfo is not None:
                            occurred_at = candidate
                    except ValueError:
                        pass
                    break
            if native_type is None:
                parse_status = "unknown"
        else:
            parse_status = "unknown"
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    return RecordLocator(
        record_index=index,
        source_start_offset=absolute_start,
        source_end_offset=absolute_start + len(record_bytes),
        record_sha256=sha256_hex(record_bytes),
        native_type=native_type,
        native_payload_type=native_payload_type,
        occurred_at=occurred_at,
        parse_status=parse_status,
    )


def build_source_batch(
    source_bytes: bytes,
    *,
    source_stream_key: str,
    generation_key: str,
    generation_seq: int,
    start_offset: int,
    source_provider: str,
    source_kind: str,
    observed_native_session_id: str | None = None,
    observed_parent_native_session_id: str | None = None,
    codex_version: str | None = None,
    source_version: str | None = None,
    collector_version: str | None = None,
    native_record_fragment: Mapping[str, Any] | None = None,
) -> tuple[BatchManifest, bytes]:
    if not source_bytes:
        raise ContractError("source batch must not be empty")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ContractError("source batch exceeds rollout v1 limits")
    if native_record_fragment is None:
        parts = source_bytes.split(b"\n")
        lines = [part + b"\n" for part in parts[:-1]]
        if parts[-1]:
            lines.append(parts[-1])
        records: list[RecordLocator] = []
        offset = start_offset
        for index, line in enumerate(lines):
            records.append(_record_locator(line, offset, index))
            offset += len(line)
    else:
        records = [
            RecordLocator(
                record_index=0,
                source_start_offset=start_offset,
                source_end_offset=start_offset + len(source_bytes),
                record_sha256=sha256_hex(source_bytes),
                native_type=None,
                native_payload_type=None,
                occurred_at=None,
                parse_status="fragment",
                native_record_start_offset=_integer(
                    native_record_fragment.get("native_record_start_offset"),
                    "native_record_start_offset",
                ),
                native_record_end_offset=_integer(
                    native_record_fragment.get("native_record_end_offset"),
                    "native_record_end_offset",
                    minimum=1,
                ),
                native_record_sha256=_hash(
                    native_record_fragment.get("native_record_sha256"),
                    "native_record_sha256",
                ),
                fragment_index=_integer(
                    native_record_fragment.get("fragment_index"),
                    "fragment_index",
                ),
                fragment_count=_integer(
                    native_record_fragment.get("fragment_count"),
                    "fragment_count",
                    minimum=2,
                ),
            )
        ]
    if len(records) > MAX_RECORDS:
        raise ContractError(f"source batch exceeds {MAX_RECORDS} native records")
    stored = gzip.compress(source_bytes, compresslevel=6, mtime=0)
    occurred = [
        (
            datetime.fromisoformat(record.occurred_at.replace("Z", "+00:00")),
            record.occurred_at,
        )
        for record in records
        if record.occurred_at is not None
    ]
    manifest = BatchManifest(
        contract_version=CONTRACT_VERSION,
        source_provider=source_provider,
        source_kind=source_kind,
        source_stream_key=_nonempty(source_stream_key, "source_stream_key"),
        generation_key=_nonempty(generation_key, "generation_key"),
        generation_seq=_integer(generation_seq, "generation_seq"),
        start_offset=_integer(start_offset, "start_offset"),
        end_offset=start_offset + len(source_bytes),
        source_byte_count=len(source_bytes),
        source_sha256=sha256_hex(source_bytes),
        storage_encoding="gzip",
        stored_byte_count=len(stored),
        stored_sha256=sha256_hex(stored),
        record_count=len(records),
        records=tuple(records),
        observed_native_session_id=observed_native_session_id,
        observed_parent_native_session_id=observed_parent_native_session_id,
        first_occurred_at=min(occurred)[1] if occurred else None,
        last_occurred_at=max(occurred)[1] if occurred else None,
        codex_version=codex_version,
        source_version=source_version,
        collector_version=collector_version,
    )
    manifest.validate()
    return manifest, stored


def build_rollout_batch(
    source_bytes: bytes,
    *,
    source_stream_key: str,
    generation_key: str,
    generation_seq: int,
    start_offset: int,
    observed_native_session_id: str | None = None,
    codex_version: str | None = None,
    collector_version: str | None = None,
    native_record_fragment: Mapping[str, Any] | None = None,
) -> tuple[BatchManifest, bytes]:
    return build_source_batch(
        source_bytes,
        source_stream_key=source_stream_key,
        generation_key=generation_key,
        generation_seq=generation_seq,
        start_offset=start_offset,
        source_provider="codex",
        source_kind="rollout",
        observed_native_session_id=observed_native_session_id,
        codex_version=codex_version,
        source_version=codex_version,
        collector_version=collector_version,
        native_record_fragment=native_record_fragment,
    )


RECEIPT_FIELDS = {
    "receipt_version",
    "status",
    "batch_id",
    "workspace_id",
    "person_id",
    "collector_key",
    "source_kind",
    "source_stream_key",
    "generation_key",
    "generation_seq",
    "start_offset",
    "end_offset",
    "source_byte_count",
    "source_sha256",
    "storage_path",
    "stored_byte_count",
    "stored_sha256",
    "record_count",
    "contract_version",
    "committed_at",
}


def validate_committed_receipt(
    manifest: BatchManifest,
    value: Mapping[str, Any],
    *,
    expected_attribution: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    if set(value) != RECEIPT_FIELDS:
        raise ReceiptMismatch(
            "receipt fields do not match the committed receipt contract"
        )
    if (
        value.get("receipt_version") != RECEIPT_VERSION
        or value.get("status") != "committed"
    ):
        raise ReceiptMismatch("receipt version or status is not committed")
    try:
        uuid.UUID(str(value.get("batch_id")))
        uuid.UUID(str(value.get("workspace_id")))
        uuid.UUID(str(value.get("person_id")))
    except (ValueError, TypeError, AttributeError) as error:
        raise ReceiptMismatch("receipt IDs must be UUIDs") from error
    expected = {
        "source_kind": manifest.source_kind,
        "source_stream_key": manifest.source_stream_key,
        "generation_key": manifest.generation_key,
        "generation_seq": manifest.generation_seq,
        "start_offset": manifest.start_offset,
        "end_offset": manifest.end_offset,
        "source_byte_count": manifest.source_byte_count,
        "source_sha256": manifest.source_sha256,
        "stored_byte_count": manifest.stored_byte_count,
        "stored_sha256": manifest.stored_sha256,
        "record_count": manifest.record_count,
        "contract_version": manifest.contract_version,
    }
    for field, item in expected.items():
        if value.get(field) != item:
            raise ReceiptMismatch(f"receipt {field} does not match the spooled batch")
    for field in ("collector_key", "storage_path", "committed_at"):
        try:
            _nonempty(value.get(field), f"receipt.{field}")
        except ContractError as error:
            raise ReceiptMismatch(str(error)) from error
    try:
        committed_at = datetime.fromisoformat(
            str(value["committed_at"]).replace("Z", "+00:00")
        )
    except ValueError as error:
        raise ReceiptMismatch("receipt committed_at must be ISO-8601") from error
    if committed_at.tzinfo is None:
        raise ReceiptMismatch("receipt committed_at must include a timezone")
    canonical_path = (
        f"workspaces/{value['workspace_id']}/collectors/{value['collector_key']}/"
        f"{manifest.source_kind}/{manifest.source_stream_key}/generations/"
        f"{manifest.generation_seq}-{manifest.generation_key}/"
        f"{manifest.start_offset}-{manifest.end_offset}-{manifest.source_sha256}.jsonl.gz"
    )
    if value["storage_path"] != canonical_path:
        raise ReceiptMismatch("receipt storage_path is not canonical for the batch")
    if expected_attribution:
        for field in ("workspace_id", "person_id", "collector_key"):
            if (
                field in expected_attribution
                and value.get(field) != expected_attribution[field]
            ):
                raise ReceiptMismatch(
                    f"receipt {field} does not match local configuration"
                )
    return dict(value)


def validate_stored_payload(manifest: BatchManifest, stored: bytes) -> bytes:
    if (
        len(stored) != manifest.stored_byte_count
        or sha256_hex(stored) != manifest.stored_sha256
    ):
        raise ContractError("stored payload size/hash does not match its manifest")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(stored)) as payload:
            source = payload.read(MAX_SOURCE_BYTES + 1)
    except (OSError, EOFError) as error:
        raise ContractError("stored payload is not valid gzip") from error
    if len(source) > MAX_SOURCE_BYTES:
        raise ContractError("source payload exceeds rollout v1 limits")
    if (
        len(source) != manifest.source_byte_count
        or sha256_hex(source) != manifest.source_sha256
    ):
        raise ContractError("source payload size/hash does not match its manifest")
    return source
