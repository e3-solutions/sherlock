"""Recover the bytes a range_overlap rejection would otherwise lose.

When a capture was interrupted between enqueueing a batch and saving its
cursor, the next capture re-read from the same start offset with a later end.
The server commits the first batch, rejects the longer one with HTTP 409
``range_overlap``, and the drain dead-letters it. The following batch starts at
the longer one's end, so the bytes between the two ends never reach Sherlock:
a byte-range gap in the session (COR-5023).

This pass reads the collector's own committed receipts, finds the part of each
such dead letter that no committed range covers, and enqueues exactly that part
as a new batch of the same generation. Only whole native records are re-sent,
from the dead letter's own stored bytes; nothing is re-read from the source
file. The dead letter stays (immutable evidence) and is marked as repaired.
"""

from __future__ import annotations

import gzip
import json
from collections import defaultdict
from pathlib import Path

from .contract import ContractError, build_source_batch
from .spool import DurableSpool, SpoolItem, _atomic_json, utc_now

REPAIRABLE_CODES = frozenset({"range_overlap"})
MAX_REPAIRS_PER_RUN = 64


def _uncovered(start: int, end: int, ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    gaps: list[tuple[int, int]] = []
    cursor = start
    for begin, finish in sorted(ranges):
        if finish <= cursor:
            continue
        if begin >= end:
            break
        if begin > cursor:
            gaps.append((cursor, min(begin, end)))
        cursor = max(cursor, finish)
        if cursor >= end:
            break
    if cursor < end:
        gaps.append((cursor, end))
    return gaps


def _committed_ranges(spool: DurableSpool) -> dict[tuple, list[tuple[int, int]]]:
    ranges: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    for path in spool.list_collection_receipts():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            source = value["source"]
            key = (
                source["source_kind"],
                source["source_stream_key"],
                source["generation_key"],
                int(source["generation_seq"]),
            )
            ranges[key].append((int(source["start_offset"]), int(source["end_offset"])))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return ranges


def _queued_ranges(spool: DurableSpool) -> dict[tuple, list[tuple[int, int]]]:
    """Byte ranges already waiting to upload. Re-sending them again would only
    collect another range_overlap once the queued copy commits (COR-5060)."""
    ranges: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    for path in [*spool.list_pending(), *sorted(spool.processing.glob("*.json"))]:
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))["manifest"]
            key = (
                manifest["source_kind"],
                manifest["source_stream_key"],
                manifest["generation_key"],
                int(manifest["generation_seq"]),
            )
            ranges[key].append(
                (int(manifest["start_offset"]), int(manifest["end_offset"]))
            )
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return ranges


def repair_overlap_dead_letters(
    spool: DurableSpool,
    *,
    max_repairs: int = MAX_REPAIRS_PER_RUN,
) -> dict[str, int]:
    """Re-enqueue the uncommitted tail of range_overlap dead letters."""
    summary = {"examined": 0, "requeued_batches": 0, "unrepairable": 0}
    candidates: list[tuple[Path, dict, SpoolItem]] = []
    index = spool.dead_letter_index()
    names = sorted(
        name
        for name, entry in index.items()
        if not entry.get("overlap_repaired")
        and any(
            str(entry.get("code", "")) == code
            or str(entry.get("code", "")).endswith(f"_{code}")
            for code in REPAIRABLE_CODES
        )
    )
    for name in names:
        path = spool.dead_letter / name
        if len(candidates) >= max_repairs:
            break
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            metadata = value.get("metadata") or {}
            dead_letter = metadata.get("dead_letter") or {}
            if (
                dead_letter.get("error_code") not in REPAIRABLE_CODES
                or metadata.get("overlap_repair") is not None
            ):
                continue
            item = SpoolItem.from_dict(value)
        except (OSError, ValueError, ContractError, AttributeError, TypeError):
            continue
        candidates.append((path, value, item))
    if not candidates:
        return summary
    committed = _committed_ranges(spool)
    # Ranges that will reach the server anyway: queued batches, and tails this
    # run re-sends. Several dead letters often share one start offset.
    claimed = _queued_ranges(spool)
    for path, value, item in candidates:
        summary["examined"] += 1
        manifest = item.manifest
        outcome: dict[str, object] = {"repaired_at": utc_now()}
        try:
            if any(record.parse_status == "fragment" for record in manifest.records):
                raise ContractError("fragment batches are not repaired")
            key = (
                manifest.source_kind,
                manifest.source_stream_key,
                manifest.generation_key,
                manifest.generation_seq,
            )
            covered = committed.get(key, [])
            if not any(
                begin < manifest.end_offset and finish > manifest.start_offset
                for begin, finish in covered
            ):
                # The overlapping range was not committed from this queue, so
                # the missing part cannot be computed locally.
                raise ContractError("no_local_receipt")
            boundaries = {record.source_start_offset for record in manifest.records}
            ends = {record.source_end_offset for record in manifest.records}
            source = gzip.decompress(item.stored_payload)
            gaps = _uncovered(
                manifest.start_offset, manifest.end_offset, [*covered, *claimed[key]]
            )
            if any(begin not in boundaries or finish not in ends for begin, finish in gaps):
                # Queued ranges may split records differently; fall back to
                # committed receipts only, as before.
                gaps = _uncovered(manifest.start_offset, manifest.end_offset, covered)
            requeued: list[list[int]] = []
            for begin, finish in gaps:
                if begin not in boundaries or finish not in ends:
                    raise ContractError("uncovered range is not record aligned")
                tail = source[
                    begin - manifest.start_offset : finish - manifest.start_offset
                ]
                repaired, stored = build_source_batch(
                    tail,
                    source_stream_key=manifest.source_stream_key,
                    generation_key=manifest.generation_key,
                    generation_seq=manifest.generation_seq,
                    start_offset=begin,
                    source_provider=manifest.source_provider,
                    source_kind=manifest.source_kind,
                    observed_native_session_id=manifest.observed_native_session_id,
                    observed_parent_native_session_id=(
                        manifest.observed_parent_native_session_id
                    ),
                    codex_version=manifest.codex_version,
                    source_version=manifest.source_version,
                    collector_version=manifest.collector_version,
                )
                spool.enqueue(repaired, stored, workload_class="backfill")
                claimed[key].append((begin, finish))
                requeued.append([begin, finish])
            outcome.update(status="requeued", ranges=requeued)
            summary["requeued_batches"] += len(requeued)
        except (ContractError, OSError, ValueError) as error:
            outcome.update(status="unrepairable", reason=str(error)[:120])
            summary["unrepairable"] += 1
        value.setdefault("metadata", {})["overlap_repair"] = outcome
        try:
            _atomic_json(path, value)
        except OSError:
            pass
    return summary
