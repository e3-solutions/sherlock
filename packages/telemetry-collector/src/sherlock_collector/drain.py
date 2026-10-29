from __future__ import annotations

import fcntl
import threading
import time
from collections import Counter, deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping, Protocol

from .collection_receipt import scan_token_payload
from .contract import (
    ContractError,
    ReceiptMismatch,
    validate_committed_receipt,
    validate_stored_payload,
)
from . import exclusion_report
from .exclusions import EXCLUDED_PROJECT, ExclusionPolicy, load_policy, observed_cwds
from .spool import (
    MAX_UPLOAD_BACKOFF_SECONDS,
    DurableSpool,
    SpoolItem,
    dead_letter_code,
    secure_lock,
)


class TransientUploadError(RuntimeError):
    pass


# Consecutive 5xx responses tolerated before every stream stops (COR-5058).
MAX_SERVER_ERRORS_IN_A_ROW = 3


def _delayed(next_upload_at: float) -> bool:
    """True while a retry delay is running. Delays longer than the current cap
    were written by an older collector (up to 24 hours) and are already due."""
    now = time.time()
    return now < float(next_upload_at) <= now + MAX_UPLOAD_BACKOFF_SECONDS


class CollectorUploadError(TransientUploadError):
    """A shared endpoint/identity failure; stop all streams until a later probe."""

    def __init__(self, message: str, *, error_code: str | None, http_status: int):
        super().__init__(message)
        self.error_code = error_code
        self.http_status = http_status


class PermanentUploadError(RuntimeError):
    """An explicit server rejection of this artifact, with its audit identity."""

    def __init__(self, message: str, *, error_code: str, http_status: int):
        super().__init__(message)
        self.error_code = error_code
        self.http_status = http_status


class UploadTransport(Protocol):
    def upload(self, item: SpoolItem) -> Mapping[str, object]: ...


@dataclass(frozen=True)
class DrainResult:
    uploaded: int = 0
    requeued: int = 0
    dead_lettered: int = 0
    recovered: int = 0
    locked: bool = False
    collector_failure: dict | None = None
    held_by_policy: int = 0
    # Best-effort report of excluded session ids so Sherlock hides copies it
    # already received: none, unchanged, reported, skipped or failed:<code>.
    exclusions_report: str | None = None
    # Batches dead-lettered by this run, by reason (e.g. 409_range_overlap).
    dead_letter_codes: dict | None = None


class Drain:
    def __init__(
        self,
        spool: DurableSpool,
        transport: UploadTransport,
        *,
        max_workers: int = 4,
        expected_attribution: Mapping[str, str] | None = None,
        exclusion_policy: ExclusionPolicy | None = None,
        source_home: Path | None = None,
    ):
        self.spool = spool
        self.transport = transport
        self.max_workers = max_workers
        self.expected_attribution = expected_attribution
        self.exclusion_policy = exclusion_policy
        self.source_home = Path(source_home) if source_home is not None else None
        self._policy = ExclusionPolicy()
        self._held: set[Path] = set()
        self._project_held_sessions: set[str] = set()
        self._dead_letter_codes: Counter[str] = Counter()
        self._codes_lock = threading.Lock()

    def _note_dead_letter(self, error: Exception) -> None:
        code = dead_letter_code(
            getattr(error, "http_status", None),
            getattr(error, "error_code", None),
            type(error).__name__,
        )
        with self._codes_lock:
            self._dead_letter_codes[code] += 1

    def run(self, *, max_items: int = 1024, max_seconds: float = 300) -> DrainResult:
        if max_items < 1 or max_seconds <= 0:
            raise ValueError("drain budgets must be positive")
        # Owner exclusions apply to already-queued batches too (for example
        # batches queued before an entry was added, or by an older runtime).
        # Held batches stay pending, unsent, and block only their own stream.
        self._policy = self.exclusion_policy or load_policy()
        self._held = set()
        self._project_held_sessions = set()
        self._dead_letter_codes = Counter()
        result = self._run(max_items, max_seconds)
        return replace(
            result,
            held_by_policy=len(self._held),
            exclusions_report=self._report_exclusions(result),
            dead_letter_codes=dict(sorted(self._dead_letter_codes.items())) or None,
        )

    def _report_exclusions(self, result: DrainResult) -> str:
        """Tell Sherlock which sessions are excluded; never affects the drain."""
        try:
            policy = self._policy
            if policy.error:
                return exclusion_report.SKIPPED
            # Explicitly excluded sessions, plus sessions whose queued batches
            # this drain held because they ran in an excluded project.
            ids = set(policy.excluded) | self._project_held_sessions
            if not exclusion_report.normalized_session_ids(ids):
                return exclusion_report.NONE
            send = getattr(self.transport, "report_exclusions", None)
            if result.locked or result.collector_failure or not callable(send):
                return exclusion_report.SKIPPED
            return exclusion_report.report_exclusions(self.spool.root, ids, send)
        except Exception as error:
            return f"failed:{type(error).__name__}"

    def _run(self, max_items: int, max_seconds: float) -> DrainResult:
        deadline = time.monotonic() + max_seconds
        with secure_lock(self.spool.lock_path) as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return DrainResult(locked=True)
            recovered = self.spool.recover_processing()
            status = self.spool.upload_status()
            if status.get("status") == "blocked" and _delayed(status["next_upload_at"]):
                return DrainResult(recovered=recovered, collector_failure=status)
            uploaded = requeued = dead_lettered = 0
            blocked_streams: set[tuple[str, str]] = set()
            frontiers, invalid = self._pending_frontiers(blocked_streams)
            while (
                (frontiers or invalid)
                and uploaded + requeued + dead_lettered < max_items
                and time.monotonic() < deadline
            ):
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

                if outcomes[3] is not None:
                    status = self.spool.defer_uploads(
                        outcomes[3], progressed=uploaded > 0
                    )
                    return DrainResult(
                        uploaded,
                        requeued,
                        dead_lettered,
                        recovered,
                        collector_failure=status,
                    )

                # Producers do not take the drain lock. Inventory the queue again
                # only after the current frontier is quiet so artifacts enqueued
                # during uploads are observed without returning to quadratic scans.
                frontiers, invalid = self._pending_frontiers(blocked_streams)
            if uploaded:
                self.spool.clear_upload_failure()
            elif status.get("status") == "blocked":
                return DrainResult(
                    uploaded,
                    requeued,
                    dead_lettered,
                    recovered,
                    collector_failure=status,
                )
            return DrainResult(uploaded, requeued, dead_lettered, recovered)

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
            reason = self._policy.active and self._policy.blocked_reason(
                manifest.source_provider,
                manifest.observed_native_session_id,
                manifest.observed_parent_native_session_id,
                source_home=self.source_home,
                # Directories recorded in the queued bytes themselves, so a
                # batch is classified by what it would upload.
                observed_cwds=(
                    observed_cwds(validate_stored_payload(manifest, item.stored_payload))
                    if self._policy.excluded_projects
                    else ()
                ),
                native_fragments=[
                    (
                        record.native_record_start_offset,
                        record.native_record_end_offset,
                        record.native_record_sha256,
                    )
                    for record in manifest.records
                    if record.parse_status == "fragment"
                ],
            )
            if reason:
                if reason == EXCLUDED_PROJECT and manifest.observed_native_session_id:
                    self._project_held_sessions.add(manifest.observed_native_session_id)
                self._held.add(path)
                blocked_streams.add(stream)
                continue
            # A delayed frontier blocks its own later byte ranges only.
            if _delayed(item.metadata.get("next_upload_at", 0)):
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
            for stream, items in sorted(ordered.items())
            if stream not in blocked_streams
        }
        return frontiers, invalid

    def _drain_frontiers(
        self,
        frontiers: dict[tuple[str, str], deque[Path]],
        invalid: deque[Path],
        blocked_streams: set[tuple[str, str]],
        max_items: int,
        deadline: float,
    ) -> tuple[int, int, int, CollectorUploadError | None]:
        uploaded = requeued = dead_lettered = 0
        collector_error = None
        server_errors_in_a_row = 0
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            in_flight: dict[
                Future[str | CollectorUploadError], tuple[str, str] | None
            ] = {}

            ready = deque(
                (stream, paths.popleft())
                for stream, paths in frontiers.items()
                if paths
            )
            ready.extend((None, path) for path in invalid)
            submitted = 0
            while ready or in_flight:
                while (
                    collector_error is None
                    and ready
                    and len(in_flight) < self.max_workers
                    and submitted < max_items
                    and time.monotonic() < deadline
                ):
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
                    if isinstance(outcome, CollectorUploadError):
                        requeued += 1
                        if (
                            outcome.http_status >= 500
                            and server_errors_in_a_row < MAX_SERVER_ERRORS_IN_A_ROW
                        ):
                            # A cold-boot 5xx between successes: delay only this
                            # stream and keep draining the others.
                            server_errors_in_a_row += 1
                            if stream is not None:
                                blocked_streams.add(stream)
                        else:
                            collector_error = outcome
                    elif outcome == "uploaded":
                        uploaded += 1
                        server_errors_in_a_row = 0
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
                        ready.append((stream, frontiers[stream].popleft()))

        return uploaded, requeued, dead_lettered, collector_error

    def _upload_claimed(self, pending_path: Path) -> str | CollectorUploadError:
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
        except CollectorUploadError as error:
            # upload() is called only after a readable item has been loaded.
            self.spool.requeue(claimed, item, error)
            return error
        except (TransientUploadError, ReceiptMismatch) as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                self._note_dead_letter(error)
                return "dead-lettered"
            self.spool.requeue(claimed, item, error)
            return "requeued"
        except PermanentUploadError as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                self._note_dead_letter(error)
                return "dead-lettered"
            # Keep immutable manifest/payload evidence with an auditable reason,
            # and let later ranges proceed. Inventory still exposes the gap.
            self.spool.quarantine(claimed, item, error)
            self._note_dead_letter(error)
            return "dead-lettered"
        except ContractError as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                self._note_dead_letter(error)
                return "dead-lettered"
            # A local receipt conflict is an audit problem, not a server rejection.
            self.spool.requeue(claimed, item, error)
            return "requeued"
        except Exception as error:
            if item is None:
                self.spool.quarantine(claimed, None, error)
                self._note_dead_letter(error)
                return "dead-lettered"
            self.spool.requeue(claimed, item, TransientUploadError(str(error)))
            return "requeued"
        self.spool.acknowledge(claimed)
        return "uploaded"
