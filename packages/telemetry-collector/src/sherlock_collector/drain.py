from __future__ import annotations

import fcntl
import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol

from .collection_receipt import scan_token_payload
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

    def run(self, *, max_items: int = 1024, max_seconds: float = 300) -> DrainResult:
        if max_items < 1 or max_seconds <= 0:
            raise ValueError("drain budgets must be positive")
        deadline = time.monotonic() + max_seconds
        with secure_lock(self.spool.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return DrainResult(locked=True)
            recovered = self.spool.recover_processing()
            uploaded = requeued = dead_lettered = 0
            blocked_streams: set[tuple[str, str]] = set()
            frontiers, invalid = self._pending_frontiers(blocked_streams)
            while (frontiers or invalid) and uploaded + requeued + dead_lettered < max_items and time.monotonic() < deadline:
                outcomes = self._drain_frontiers(
                    frontiers,
                    invalid,
                    blocked_streams,
                    max_items - uploaded - requeued - dead_lettered,
                    deadline,
                )
                uploaded += outcomes[0]
                requeued += outcomes[1]
                dead_lettered += outcomes[2]

                # Producers do not take the drain lock. Inventory the queue again
                # only after the current frontier is quiet so artifacts enqueued
                # during uploads are observed without returning to quadratic scans.
                frontiers, invalid = self._pending_frontiers(blocked_streams)
            return DrainResult(uploaded, requeued, dead_lettered, recovered, False)

    def _pending_frontiers(
        self,
        blocked_streams: set[tuple[str, str]],
    ) -> tuple[dict[tuple[str, str], deque[Path]], deque[Path]]:
        ordered: dict[
            tuple[str, str],
            list[tuple[tuple[int, int, int, str], Path]],
        ] = {}
        invalid: deque[Path] = deque()
        for path in self.spool.list_pending():
            try:
                item = self.spool.load(path)
                manifest = item.manifest
            except ContractError:
                invalid.append(path)
                continue
            stream = manifest.stream_identity
            if stream in blocked_streams:
                continue
            # A delayed frontier blocks its own later byte ranges only.
            if item.metadata.get("next_upload_at", 0) > time.time():
                blocked_streams.add(stream)
            order = (
                manifest.generation_seq,
                manifest.start_offset,
                manifest.end_offset,
                path.name,
            )
            ordered.setdefault(stream, []).append((order, path))
        frontiers = {
            stream: deque(path for _, path in sorted(items))
            for stream, items in sorted(ordered.items()) if stream not in blocked_streams
        }
        return frontiers, invalid

    def _drain_frontiers(
        self,
        frontiers: dict[tuple[str, str], deque[Path]],
        invalid: deque[Path],
        blocked_streams: set[tuple[str, str]],
        max_items: int,
        deadline: float,
    ) -> tuple[int, int, int]:
        uploaded = requeued = dead_lettered = 0
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            in_flight: dict[Future[str], tuple[str, str] | None] = {}

            ready = deque((stream, paths.popleft()) for stream, paths in frontiers.items() if paths)
            ready.extend((None, path) for path in invalid)
            submitted = 0
            while ready or in_flight:
                while ready and len(in_flight) < self.max_workers and submitted < max_items and time.monotonic() < deadline:
                    stream, path = ready.popleft()
                    if stream in blocked_streams:
                        continue
                    in_flight[executor.submit(self._upload_claimed, path)] = stream
                    submitted += 1
                if not in_flight:
                    break
                completed, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in completed:
                    stream = in_flight.pop(future)
                    outcome = future.result()
                    if outcome == "uploaded":
                        uploaded += 1
                    elif outcome == "requeued":
                        requeued += 1
                        if stream is not None:
                            blocked_streams.add(stream)
                    elif outcome == "dead-lettered":
                        dead_lettered += 1
                    if stream is not None and stream not in blocked_streams and frontiers.get(stream):
                        ready.append((stream, frontiers[stream].popleft()))

        return uploaded, requeued, dead_lettered

    def _upload_claimed(self, pending_path: Path) -> str:
        claimed = self.spool.claim(pending_path)
        if claimed is None:
            return "missing"
        item: SpoolItem | None = None
        try:
            item = self.spool.load(claimed)
            token_payload = scan_token_payload(item.manifest, item.stored_payload)
            receipt = self.transport.upload(item)
            validated_receipt = validate_committed_receipt(
                item.manifest,
                receipt,
                expected_attribution=self.expected_attribution,
            )
            self.spool.record_collection_receipt(
                item,
                validated_receipt,
                token_payload,
            )
        except (TransientUploadError, ReceiptMismatch) as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            self.spool.requeue(claimed, item, error)
            return "requeued"
        except PermanentUploadError as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            # Keep immutable manifest/payload evidence with an auditable reason,
            # and let later ranges proceed. Inventory still exposes the gap.
            self.spool.quarantine(claimed, item, error)
            return "dead-lettered"
        except ContractError as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                return "dead-lettered"
            # A local receipt conflict is an audit problem, not a server rejection.
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
