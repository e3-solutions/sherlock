from __future__ import annotations

import fcntl
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol

from .contract import ContractError, ReceiptMismatch, validate_committed_receipt
from .spool import DurableSpool, SpoolItem, secure_lock


class TransientUploadError(RuntimeError):
    pass


class PermanentUploadError(RuntimeError):
    pass


class UploadTransport(Protocol):
    def upload(self, item: SpoolItem) -> Mapping[str, object]: ...


@dataclass(frozen=True)
class DrainResult:
    uploaded: int = 0
    requeued: int = 0
    dead_lettered: int = 0
    recovered: int = 0
    locked: bool = False


class Drain:
    def __init__(
        self,
        spool: DurableSpool,
        transport: UploadTransport,
        *,
        max_workers: int = 4,
        expected_attribution: Mapping[str, str] | None = None,
    ):
        self.spool = spool
        self.transport = transport
        self.max_workers = max_workers
        self.expected_attribution = expected_attribution

    def run(self) -> DrainResult:
        with secure_lock(self.spool.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return DrainResult(locked=True)
            recovered = self.spool.recover_processing()
            uploaded = requeued = dead_lettered = 0
            blocked_streams: set[tuple[str, str]] = set()
            while True:
                candidates = self._next_per_stream(blocked_streams)
                if not candidates:
                    break
                with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                    futures = {
                        executor.submit(self._upload_claimed, path): (path, stream)
                        for path, stream in candidates
                    }
                    for future in as_completed(futures):
                        path, stream = futures[future]
                        outcome = future.result()
                        if outcome == "uploaded":
                            uploaded += 1
                        elif outcome == "requeued":
                            requeued += 1
                            blocked_streams.add(stream)
                        elif outcome == "dead-lettered":
                            dead_lettered += 1
            return DrainResult(uploaded, requeued, dead_lettered, recovered, False)

    def _next_per_stream(
        self,
        blocked_streams: set[tuple[str, str]],
    ) -> list[tuple[Path, tuple[str, str]]]:
        earliest: dict[tuple[str, str], tuple[tuple[int, int, int, str], Path]] = {}
        invalid: list[tuple[Path, tuple[str, str]]] = []
        for path in self.spool.list_pending():
            try:
                manifest = self.spool.load(path).manifest
            except ContractError:
                invalid.append((path, ("invalid", path.name)))
                continue
            stream = manifest.stream_identity
            if stream in blocked_streams:
                continue
            order = (
                manifest.generation_seq,
                manifest.start_offset,
                manifest.end_offset,
                path.name,
            )
            if stream not in earliest or order < earliest[stream][0]:
                earliest[stream] = (order, path)
        return invalid + [
            (path, stream) for stream, (_, path) in sorted(earliest.items())
        ]

    def _upload_claimed(self, pending_path: Path) -> str:
        claimed = self.spool.claim(pending_path)
        if claimed is None:
            return "missing"
        item: SpoolItem | None = None
        try:
            item = self.spool.load(claimed)
            receipt = self.transport.upload(item)
            validate_committed_receipt(
                item.manifest,
                receipt,
                expected_attribution=self.expected_attribution,
            )
        except (TransientUploadError, ReceiptMismatch) as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            self.spool.requeue(claimed, item, error)
            return "requeued"
        except (PermanentUploadError, ContractError) as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            # A readable local artifact remains the source of truth even when the
            # server rejects it. Retain it and block later ranges in this stream so
            # a rollout/version mismatch cannot silently create a source gap.
            self.spool.requeue(claimed, item, error)
            return "requeued"
        except Exception as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            self.spool.requeue(claimed, item, TransientUploadError(str(error)))
            return "requeued"
        self.spool.acknowledge(claimed)
        return "uploaded"
