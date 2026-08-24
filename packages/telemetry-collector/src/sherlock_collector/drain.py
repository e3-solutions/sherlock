from __future__ import annotations

import fcntl
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
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
            frontiers, invalid = self._pending_frontiers(blocked_streams)
            while frontiers or invalid:
                outcomes = self._drain_frontiers(
                    frontiers,
                    invalid,
                    blocked_streams,
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
                manifest = self.spool.load(path).manifest
            except ContractError:
                invalid.append(path)
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
            ordered.setdefault(stream, []).append((order, path))
        frontiers = {
            stream: deque(path for _, path in sorted(items))
            for stream, items in sorted(ordered.items())
        }
        return frontiers, invalid

    def _drain_frontiers(
        self,
        frontiers: dict[tuple[str, str], deque[Path]],
        invalid: deque[Path],
        blocked_streams: set[tuple[str, str]],
    ) -> tuple[int, int, int]:
        uploaded = requeued = dead_lettered = 0
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            in_flight: dict[Future[str], tuple[str, str] | None] = {}

            def submit_next(stream: tuple[str, str]) -> None:
                frontier = frontiers.get(stream)
                if frontier:
                    in_flight[
                        executor.submit(self._upload_claimed, frontier.popleft())
                    ] = stream

            # At most one future is submitted for each valid stream. A successful
            # completion advances only that stream's ordered frontier.
            for stream in frontiers:
                submit_next(stream)
            for path in invalid:
                in_flight[executor.submit(self._upload_claimed, path)] = None

            while in_flight:
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

                    if (
                        stream is not None
                        and stream not in blocked_streams
                        and frontiers.get(stream)
                    ):
                        submit_next(stream)

        return uploaded, requeued, dead_lettered

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
