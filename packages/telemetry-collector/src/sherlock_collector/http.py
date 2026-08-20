from __future__ import annotations

import base64
import json
import socket
import urllib.error
import urllib.request
from typing import Mapping

from .config import CollectorIdentity
from .drain import PermanentUploadError, TransientUploadError
from .spool import SpoolItem


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
            detail = error.read(4096).decode("utf-8", "replace")
            message = f"ingest returned HTTP {error.code}: {detail}"
            if error.code in {408, 425, 429} or error.code >= 500:
                raise TransientUploadError(message) from error
            raise PermanentUploadError(message) from error
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
