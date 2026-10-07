"""Read-only source/receipt reconciliation; this is not a billing or usage total."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from .collection_receipt import load_collection_receipt, scan_token_records
from .contract import ContractError
from .discovery import (
    CODEX_BACKFILL_MAX_FILES,
    DEFAULT_LOOKBACK_SECONDS,
    _codex_rollout_identity,
    discover_rollouts,
)
from .rollout import _stream_key, open_regular_under_root

MAX_INSPECTION_BYTES = 64 * 1024 * 1024
MAX_INVENTORY_BYTES = 512 * 1024 * 1024
MAX_RECEIPTS = 100_000


def _token_scan(data: bytes) -> dict:
    records = []
    invalid = 0
    for line in data.splitlines():
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                invalid += 1
            else:
                records.append(value)
        except (ValueError, UnicodeDecodeError):
            invalid += 1
    return scan_token_records(records, source_provider='codex', source_kind='rollout',
                              scope={'start_offset': 0, 'end_offset': len(data),
                                     'source_sha256': hashlib.sha256(data).hexdigest()},
                              uninspectable_records=invalid)


def _inspect_source(home: Path, path: Path, native_id: str | None, receipts: list[dict],
                    budget: int) -> tuple[dict, int]:
    result = {'native_session_id': native_id, 'rollout_path': str(path),
              'source_stream_key': _stream_key(path), 'status': 'unresolved',
              'reason': None, 'token_payload': {'presence': 'unknown'}, 'receipts': []}
    if native_id is None:
        result['reason'] = 'native_session_identity_missing'
        return result, 0
    try:
        with open_regular_under_root(home, path) as handle:
            before = os.fstat(handle.fileno())
            result['snapshot_end_offset'] = before.st_size
            if before.st_size > min(MAX_INSPECTION_BYTES, budget):
                result['reason'] = 'inspection_budget_exceeded'
                return result, 0
            identity = _codex_rollout_identity(handle)
            if identity and identity[0] and native_id and identity[0] != native_id:
                result['reason'] = 'native_identity_conflict'
                return result, 0
            handle.seek(0)
            data = handle.read(before.st_size)
            after = os.fstat(handle.fileno())
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino) or len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                result['reason'] = 'source_changed_during_inspection'
                return result, len(data)
    except (OSError, ValueError):
        result['reason'] = 'source_unreadable_or_missing'
        return result, 0
    if not data:
        result['reason'] = 'empty_source_file'
        return result, 0
    result['token_payload'] = _token_scan(data)
    ranges = []
    for receipt in receipts:
        source = receipt['source']
        if source['source_stream_key'] != result['source_stream_key'] or source['source_provider'] != 'codex' or source['source_kind'] != 'rollout':
            continue
        if source.get('observed_native_session_id') != native_id:
            continue
        start, end = source['start_offset'], source['end_offset']
        if end > len(data) or hashlib.sha256(data[start:end]).hexdigest() != source['source_sha256']:
            continue
        ranges.append((start, end))
        server = receipt['server_receipt']
        result['receipts'].append({'batch_id': server['batch_id'], 'workspace_id': server['workspace_id'],
                                   'start_offset': start, 'end_offset': end,
                                   'source_sha256': source['source_sha256'],
                                   'token_payload': receipt['token_payload']})
    covered = 0
    for start, end in sorted(ranges):
        if start > covered:
            break
        covered = max(covered, end)
    result['receipted_prefix_bytes'] = covered
    if covered == len(data):
        result['status'] = 'received'
    else:
        result['status'] = 'pending'
        result['reason'] = 'matching_receipt_missing'
    return result, len(data)


def collection_inventory(codex_home: Path | str, state_root: Path | str, *,
                         session_id: str | None = None,
                         lookback_seconds: int = DEFAULT_LOOKBACK_SECONDS) -> dict:
    """Audit the selected snapshot, never infer receipt from a capture cursor."""
    home = Path(codex_home).expanduser().resolve()
    discovery = discover_rollouts(home, replay_session_id=session_id,
                                 lookback_seconds=lookback_seconds, scan_recent_files=True,
                                 rows_per_database=CODEX_BACKFILL_MAX_FILES)
    errors = list(discovery.errors)
    if not home.is_dir():
        errors.append('source_home_missing_or_unreadable')
    receipts = []
    receipt_root = Path(state_root).expanduser() / 'queue' / 'receipts'
    for index, path in enumerate(receipt_root.glob('*.json')):
        if index >= MAX_RECEIPTS:
            errors.append('receipt_inventory_limit_exceeded')
            break
        try:
            receipts.append(load_collection_receipt(path))
        except ContractError:
            errors.append('unreadable_or_invalid_collection_receipt')
    sources = {}
    for entry in discovery.source_statuses:
        if entry['reason']:
            reason = entry['reason']
            sources[(entry['native_session_id'], entry['rollout_path'])] = {
                **entry, 'status': 'unresolved',
                'token_payload': {'presence': 'unknown'}, 'receipts': [],
            }
    remaining = MAX_INVENTORY_BYTES
    candidates = {(discovery.native_session_ids.get(str(path)), str(path)): path
                  for path in discovery.paths}
    for entry in discovery.source_statuses:
        if entry['reason'] is None:
            path = Path(entry['rollout_path'])
            candidates[(entry['native_session_id'], str(path))] = path
    for index, ((native_id, _), path) in enumerate(candidates.items()):
        if index >= CODEX_BACKFILL_MAX_FILES:
            sources[(native_id, str(path))] = {'native_session_id': native_id,
                'rollout_path': str(path), 'status': 'unresolved', 'reason': 'inventory_source_limit_exceeded',
                'token_payload': {'presence': 'unknown'}, 'receipts': []}
            continue
        value, used = _inspect_source(home, path, native_id, receipts, remaining)
        sources[(native_id, str(path))] = value
        remaining -= used
    if session_id and not sources:
        sources[(session_id, '')] = {'native_session_id': session_id, 'status': 'unresolved',
                                    'reason': 'source_not_found', 'token_payload': {'presence': 'unknown'},
                                    'receipts': []}
    rows = list(sources.values())
    if not rows:
        errors.append('no_source_sessions_discovered')
    omitted = discovery.omitted_count + max(0, len(candidates) - CODEX_BACKFILL_MAX_FILES)
    unexplained_invalid = max(0, discovery.invalid_count - sum(
        entry['reason'] is not None for entry in discovery.source_statuses
    ))
    complete = not errors and not omitted and not unexplained_invalid and all(
        row['status'] in {'received', 'excluded'} for row in rows
    )
    return {'inventory_version': 'sherlock.collection-inventory.v1',
            'status': 'complete' if complete else 'partial',
            'scope': {'provider': 'codex', 'session_id': session_id,
                      'lookback_seconds': None if session_id else lookback_seconds,
                      'basis': 'selected_native_sources_at_inventory_time'},
            'sources': rows, 'discovery_errors': errors,
            'omitted_sources_or_databases': omitted,
            'invalid_discovery_entries': discovery.invalid_count,
            'limitations': ['not_continuous_collection_coverage',
                            'historical_receipts_before_this_version_may_be_unavailable',
                            'token_payload_presence_is_not_token_usage_or_billing']}
