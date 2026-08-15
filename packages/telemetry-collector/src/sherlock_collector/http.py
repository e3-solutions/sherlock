from __future__ import annotations

import gzip
import http.client
import json
import socket
import struct
import threading
from dataclasses import dataclass
from typing import Mapping, Sequence
from urllib.parse import urlsplit

from .config import CollectorIdentity
from .drain import PermanentUploadError, TransientUploadError
from .spool import SpoolItem


BULK_CONTENT_TYPE = "application/vnd.sherlock.rollout-bulk.v2"
BULK_RECEIPT_VERSION = "sherlock.bulk-receipts.v1"
BULK_MAGIC = b"SHRBULK2"
MAX_BULK_ITEMS = 32
MAX_BULK_REQUEST_BYTES = 12 * 1024 * 1024
MAX_BULK_SOURCE_BYTES = 20 * 1024 * 1024
MAX_BULK_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_BULK_MANIFEST_TOTAL_BYTES = 20 * 1024 * 1024
MAX_RECEIPT_BYTES = 512 * 1024


@dataclass(frozen=True)
class _EncodedBulkItem:
    manifest_gzip: bytes
    manifest_bytes: int
    item: SpoolItem

    @property
    def request_bytes(self) -> int:
        return 12 + len(self.manifest_gzip) + len(self.item.stored_payload)


def _encode_bulk_item(
    item: SpoolItem, identity: CollectorIdentity | None = None
) -> _EncodedBulkItem:
    metadata: object = item.manifest.to_dict()
    if identity is not None:
        metadata = {
            "collector": identity.to_dict(),
            "manifest": metadata,
        }
    manifest = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    if len(manifest) > MAX_BULK_MANIFEST_BYTES:
        raise PermanentUploadError("bulk manifest exceeds 16 MiB")
    return _EncodedBulkItem(
        gzip.compress(manifest, compresslevel=1, mtime=0),
        len(manifest),
        item,
    )


def _encode_prepared_bulk_request(encoded: Sequence[_EncodedBulkItem]) -> bytes:
    if not 1 <= len(encoded) <= MAX_BULK_ITEMS:
        raise PermanentUploadError(
            f"bulk request must contain 1-{MAX_BULK_ITEMS} batches"
        )
    request_bytes = len(BULK_MAGIC) + 4 + sum(
        item.request_bytes for item in encoded
    )
    source_bytes = sum(
        item.item.manifest.source_byte_count for item in encoded
    )
    manifest_bytes = sum(item.manifest_bytes for item in encoded)
    if request_bytes > MAX_BULK_REQUEST_BYTES:
        raise PermanentUploadError("bulk request exceeds 12 MiB")
    if source_bytes > MAX_BULK_SOURCE_BYTES:
        raise PermanentUploadError("bulk uncompressed source exceeds 20 MiB")
    if manifest_bytes > MAX_BULK_MANIFEST_TOTAL_BYTES:
        raise PermanentUploadError("bulk manifests exceed 20 MiB")
    body = bytearray(request_bytes)
    body[: len(BULK_MAGIC)] = BULK_MAGIC
    offset = len(BULK_MAGIC)
    struct.pack_into(">I", body, offset, len(encoded))
    offset += 4
    for prepared in encoded:
        item = prepared.item
        struct.pack_into(
            ">III",
            body,
            offset,
            len(prepared.manifest_gzip),
            prepared.manifest_bytes,
            len(item.stored_payload),
        )
        offset += 12
        body[offset : offset + len(prepared.manifest_gzip)] = (
            prepared.manifest_gzip
        )
        offset += len(prepared.manifest_gzip)
        body[offset : offset + len(item.stored_payload)] = item.stored_payload
        offset += len(item.stored_payload)
    return bytes(body)


def encode_bulk_request(
    items: Sequence[SpoolItem], identity: CollectorIdentity | None = None
) -> bytes:
    return _encode_prepared_bulk_request(
        [_encode_bulk_item(item, identity) for item in items]
    )


class HttpTransport:
    max_batch_items = MAX_BULK_ITEMS
    max_batch_request_bytes = MAX_BULK_REQUEST_BYTES
    max_batch_source_bytes = MAX_BULK_SOURCE_BYTES
    max_batch_manifest_bytes = MAX_BULK_MANIFEST_TOTAL_BYTES

    def __init__(
        self,
        endpoint: str,
        principal: CollectorIdentity | str,
        *,
        timeout_seconds: float = 20.0,
    ):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise ValueError("ingest endpoint must be an HTTPS URL without user info")
        self.endpoint = endpoint
        self.identity = principal if isinstance(principal, CollectorIdentity) else None
        self.credential = principal if isinstance(principal, str) else None
        self.timeout_seconds = timeout_seconds
        self.hostname = parsed.hostname
        self.port = parsed.port
        self.request_target = parsed.path or "/"
        if parsed.query:
            self.request_target += f"?{parsed.query}"
        self._connections = threading.local()
        self._prepared = threading.local()

    def _prepared_items(self) -> dict[str, _EncodedBulkItem]:
        prepared = getattr(self._prepared, "value", None)
        if prepared is None:
            prepared = {}
            self._prepared.value = prepared
        return prepared

    def _prepare(self, item: SpoolItem) -> _EncodedBulkItem:
        prepared = self._prepared_items()
        key = item.manifest.spool_key
        encoded = prepared.get(key)
        if encoded is None:
            encoded = _encode_bulk_item(item, self.identity)
            prepared[key] = encoded
        return encoded

    def bulk_item_size(self, item: SpoolItem) -> int:
        return self._prepare(item).request_bytes

    def bulk_manifest_size(self, item: SpoolItem) -> int:
        return self._prepare(item).manifest_bytes

    def upload(self, item: SpoolItem) -> Mapping[str, object]:
        return self.upload_many([item])[0]

    def upload_many(
        self, items: Sequence[SpoolItem]
    ) -> list[Mapping[str, object]]:
        encoded = [self._prepare(item) for item in items]
        body = _encode_prepared_bulk_request(encoded)
        value = self._post(body)
        if value.get("receipt_version") != BULK_RECEIPT_VERSION:
            raise TransientUploadError("ingest returned an unsupported bulk receipt")
        receipts = value.get("receipts")
        if not isinstance(receipts, list) or len(receipts) != len(items):
            raise TransientUploadError("ingest bulk receipt count does not match request")
        if any(not isinstance(receipt, dict) for receipt in receipts):
            raise TransientUploadError("ingest returned an invalid bulk receipt")
        prepared = self._prepared_items()
        for item in items:
            prepared.pop(item.manifest.spool_key, None)
        return receipts

    def _connection(self) -> http.client.HTTPSConnection:
        connection = getattr(self._connections, "value", None)
        if connection is None:
            connection = http.client.HTTPSConnection(
                self.hostname,
                self.port,
                timeout=self.timeout_seconds,
            )
            self._connections.value = connection
        return connection

    def _discard_connection(self) -> None:
        connection = getattr(self._connections, "value", None)
        if connection is not None:
            connection.close()
            del self._connections.value

    def _post(self, body: bytes) -> Mapping[str, object]:
        connection = self._connection()
        headers = {
            "Content-Type": BULK_CONTENT_TYPE,
            "Accept": "application/json",
            "User-Agent": "sherlock-telemetry-collector/0.1.0",
        }
        if self.credential is not None:
            headers["Authorization"] = f"Bearer {self.credential}"
        try:
            connection.request(
                "POST",
                self.request_target,
                body=body,
                headers=headers,
            )
            response = connection.getresponse()
            raw = response.read(MAX_RECEIPT_BYTES + 1)
            status = response.status
            if response.getheader("Connection", "").lower() == "close":
                self._discard_connection()
        except (
            http.client.HTTPException,
            TimeoutError,
            socket.timeout,
            OSError,
        ) as error:
            self._discard_connection()
            raise TransientUploadError(f"ingest transport failed: {error}") from error
        if len(raw) > MAX_RECEIPT_BYTES:
            self._discard_connection()
            raise TransientUploadError("ingest receipt exceeds 512 KiB")
        if status < 200 or status >= 300:
            detail = raw[:4096].decode("utf-8", "replace")
            message = f"ingest returned HTTP {status}: {detail}"
            if status in {408, 425, 429} or status >= 500:
                raise TransientUploadError(message)
            raise PermanentUploadError(message)
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise TransientUploadError("ingest returned invalid JSON") from error
        if not isinstance(value, dict):
            raise TransientUploadError("ingest receipt must be an object")
        return value
