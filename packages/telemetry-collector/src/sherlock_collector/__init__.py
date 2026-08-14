"""Sherlock's rollout-only durable telemetry collector."""

from .contract import (
    CONTRACT_VERSION,
    RECEIPT_VERSION,
    BatchManifest,
    CommittedReceipt,
    RecordLocator,
    build_rollout_batch,
    validate_committed_receipt,
)
from .drain import Drain, DrainResult
from .rollout import RolloutCapturer
from .spool import DurableSpool

__all__ = [
    "CONTRACT_VERSION",
    "RECEIPT_VERSION",
    "BatchManifest",
    "CommittedReceipt",
    "Drain",
    "DrainResult",
    "DurableSpool",
    "RecordLocator",
    "RolloutCapturer",
    "build_rollout_batch",
    "validate_committed_receipt",
]
