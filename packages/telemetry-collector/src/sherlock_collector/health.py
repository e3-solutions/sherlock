from __future__ import annotations

from datetime import datetime, timezone

from .contract import ContractError
from .spool import DurableSpool

# Health visibility only; crossing this threshold never changes queue retention.
PERMANENT_REJECTION_THRESHOLD_SECONDS = 300


def pending_health(spool: DurableSpool) -> dict[str, object]:
    now = datetime.now(timezone.utc)
    oldest_age: float | None = None
    blocked = set()
    stale = set()
    unreadable = 0
    paths = spool.list_pending()

    def age(value: object) -> float | None:
        if not isinstance(value, str):
            return None
        try:
            timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if timestamp.tzinfo is None:
                return None
            return max(0.0, (now - timestamp).total_seconds())
        except ValueError:
            return None

    for path in paths:
        try:
            item = spool.load(path)
        except (OSError, ContractError):
            unreadable += 1
            continue
        pending_age = age(item.metadata.get('enqueued_at'))
        if pending_age is not None:
            oldest_age = max(oldest_age or 0.0, pending_age)
        rejection_age = age(item.metadata.get('permanent_rejection_since'))
        if rejection_age is not None:
            blocked.add(item.manifest.stream_identity)
            if rejection_age >= PERMANENT_REJECTION_THRESHOLD_SECONDS:
                stale.add(item.manifest.stream_identity)
    return {
        'pending_batches': len(paths),
        'oldest_pending_age_seconds': oldest_age,
        'blocked_streams': len(blocked),
        'stale_blocked_streams': len(stale),
        'unreadable_pending_batches': unreadable,
    }
