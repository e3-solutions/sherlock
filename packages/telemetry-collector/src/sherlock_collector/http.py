from __future__ import annotations

import base64
import json
import socket
import urllib.error
import urllib.request
from typing import Mapping

from .config import CollectorIdentity
from .drain import CollectorUploadError, PermanentUploadError, TransientUploadError
from .spool import SpoolItem


# Exact status/code pairs emitted by the ingest contract, service, storage and
# repository. Unknown responses fail closed: a proxy's 413 or an identity 409
# must never drain the queue into dead-letter. Unsupported contract/encoding
# may indicate a deploy mismatch, so those also require a collector-wide probe.
ARTIFACT_REJECTIONS = {
    400: frozenset(
        {
            "invalid_manifest",
            "invalid_payload",
            "invalid_gzip",
            "stored_integrity_mismatch",
            "source_integrity_mismatch",
            "record_integrity_mismatch",
        }
    ),
    409: frozenset(
        {
            "storage_integrity_conflict",
            "range_identity_conflict",
            "record_identity_conflict",
            "generation_mapping_conflict",
            "range_overlap",
        }
    ),
    413: frozenset({"payload_too_large"}),
}


class HttpTransport:
    def __init__(
        self,
        endpoint: str,
        identity: CollectorIdentity,
        *,
        timeout_seconds: float = 20.0,
    ):
        self.endpoint = endpoint
        self.identity = identity
        self.timeout_seconds = timeout_seconds

    def upload(self, item: SpoolItem) -> Mapping[str, object]:
        body = json.dumps(
            {
                "collector": self.identity.to_dict(),
                "manifest": item.manifest.to_dict(),
                "stored_payload_base64": base64.b64encode(item.stored_payload).decode(
                    "ascii"
                ),
            },
            separators=(",", ":"),
        ).encode()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "sherlock-telemetry-collector/0.1.0",
        }
        workload_class = item.metadata.get("workload_class")
        if workload_class in {"live", "backfill"}:
            headers["X-Sherlock-Workload-Class"] = str(workload_class)
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout_seconds
            ) as response:
                raw = response.read(65_537)
        except urllib.error.HTTPError as error:
            with error:
                detail = error.read(4096).decode("utf-8", "replace")
            message = f"ingest returned HTTP {error.code}: {detail}"
            try:
                value = json.loads(detail)
                server_error = value.get("error") if isinstance(value, dict) else None
                code = (
                    server_error.get("code") if isinstance(server_error, dict) else None
                )
                code = code if isinstance(code, str) else None
            except ValueError:
                code = None
            if code in ARTIFACT_REJECTIONS.get(error.code, ()):
                raise PermanentUploadError(
                    message, error_code=code, http_status=error.code
                ) from error
            # Includes 401/403/404/405/407/410: credentials, routing and endpoint
            # retirement affect every artifact. Retry after operator/deploy repair.
            raise CollectorUploadError(
                message, error_code=code, http_status=error.code
            ) from error
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as error:
            raise TransientUploadError(f"ingest transport failed: {error}") from error
        if len(raw) > 65_536:
            raise TransientUploadError("ingest receipt exceeds 64 KiB")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise TransientUploadError("ingest returned invalid JSON") from error
        if not isinstance(value, dict):
            raise TransientUploadError("ingest receipt must be an object")
        return value
