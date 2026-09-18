"""Local-only intake and review workflow for evidence-backed learning cards.

The commands in this module only read explicit JSON inputs and, when an
``--output`` path is supplied, create a new owner-only JSON file.  They do not
know about Forum, GitHub, Linear, databases, or any network service.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .contract import (
    CARD_VERSION,
    REVIEW_DECISIONS,
    REVIEW_VERSION,
    build_reviewer_brief,
    card_sha256,
    validate_card,
)
from .measurement import build_pilot_summary
from .reviewer_pack import render_reviewer_pack

CARD_INPUT_FIELDS = frozenset(
    {
        "card_id",
        "problem",
        "learning",
        "attempts",
        "reuse_when",
        "confidence",
        "evidence",
    }
)


class WorkflowError(ValueError):
    """A local learning-card workflow step could not be completed safely."""


class _DuplicateKeyError(ValueError):
    pass


def load_json_object(path: Path) -> dict[str, Any]:
    """Load one explicit JSON object, rejecting ambiguous duplicate keys."""

    value = _load_json(path)
    if not isinstance(value, dict):
        raise WorkflowError("input JSON must be an object")
    return value


def load_card_list(path: Path) -> list[dict[str, Any]]:
    """Load one explicit JSON list containing only card objects."""

    value = _load_json(path)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise WorkflowError("cards JSON must be a list containing only objects")
    return value


def build_draft_card(candidate: Mapping[str, Any]) -> dict[str, Any]:
    """Create a draft from the deliberately narrow, private intake shape.

    The intake cannot select a public visibility or pre-approve itself. Unknown
    fields are rejected rather than copied, preventing a candidate packet from
    silently becoming an archive for source material.
    """

    if not isinstance(candidate, Mapping):
        raise WorkflowError("card input must be an object")
    unexpected = set(candidate) - CARD_INPUT_FIELDS
    if unexpected:
        names = ", ".join(sorted(str(name) for name in unexpected))
        raise WorkflowError(f"card input has unsupported fields: {names}")
    missing = CARD_INPUT_FIELDS - set(candidate)
    if missing:
        names = ", ".join(sorted(missing))
        raise WorkflowError(f"card input is missing required fields: {names}")

    draft = {
        "card_version": CARD_VERSION,
        "visibility": "private",
        "status": "draft",
        **{field: candidate[field] for field in CARD_INPUT_FIELDS},
    }
    errors = validate_card(draft)
    if errors:
        raise WorkflowError("invalid card input: " + "; ".join(errors))
    return draft


def _load_json(path: Path) -> Any:
    source = Path(path)
    if source.is_symlink():
        raise WorkflowError("input must not be a symbolic link")
    try:
        raw = source.read_text(encoding="utf-8")
    except OSError as error:
        raise WorkflowError(f"could not read input: {source}") from error
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object)
    except (_DuplicateKeyError, json.JSONDecodeError) as error:
        raise WorkflowError(f"input is not unambiguous JSON: {source}") from error
    return value


def build_review_receipt(
    card: Mapping[str, Any],
    *,
    decision: str,
    reviewer: str,
    rationale: str,
    recorded_at: str | None = None,
) -> dict[str, Any]:
    """Create a bounded local review receipt tied to one valid draft card."""

    errors = validate_card(card)
    if errors:
        raise WorkflowError("invalid card: " + "; ".join(errors))
    if card.get("status") != "draft":
        raise WorkflowError("only draft cards can receive a new review")
    if decision not in REVIEW_DECISIONS:
        raise WorkflowError(
            "review decision must be approved, rejected, or needs_evidence"
        )
    if not _text(reviewer):
        raise WorkflowError("reviewer must be a non-empty string")
    if not _text(rationale):
        raise WorkflowError("rationale must be a non-empty string")
    return {
        "review_version": REVIEW_VERSION,
        "card_id": card["card_id"],
        "card_sha256": card_sha256(card),
        "decision": decision,
        "reviewer": reviewer.strip(),
        "rationale": rationale.strip(),
        "recorded_at": recorded_at or _now(),
    }


def finalize_approved_card(
    card: Mapping[str, Any], review: Mapping[str, Any]
) -> dict[str, Any]:
    """Return a separately stored reviewed card only after a matching approval."""

    errors = validate_card(card)
    if errors:
        raise WorkflowError("invalid card: " + "; ".join(errors))
    if card.get("status") != "draft":
        raise WorkflowError("only draft cards can be finalized")
    if review.get("review_version") != REVIEW_VERSION:
        raise WorkflowError("review has an unsupported review_version")
    if review.get("decision") != "approved":
        raise WorkflowError("only an approved review can finalize a card")
    if review.get("card_id") != card.get("card_id"):
        raise WorkflowError("review does not belong to this card")
    if review.get("card_sha256") != card_sha256(card):
        raise WorkflowError("review does not bind this exact card")
    if not _text(review.get("reviewer")) or not _text(review.get("rationale")):
        raise WorkflowError("reviewer and rationale must be non-empty strings")

    finalized = dict(card)
    finalized["status"] = "reviewed"
    finalized["review"] = dict(review)
    errors = validate_card(finalized)
    if errors:
        raise WorkflowError("finalized card is invalid: " + "; ".join(errors))
    return finalized


def write_private_json(path: Path, value: Mapping[str, Any]) -> None:
    """Create a new owner-only JSON artifact without overwriting any file."""

    encoded = (
        json.dumps(value, allow_nan=False, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    ).encode("utf-8")
    _write_private_bytes(path, encoded)


def write_private_text(path: Path, value: str) -> None:
    """Create a new owner-only text artifact without overwriting any file."""

    _write_private_bytes(path, value.encode("utf-8"))


def _write_private_bytes(path: Path, encoded: bytes) -> None:
    destination = Path(path)
    if destination.is_symlink():
        raise WorkflowError("output must not be a symbolic link")
    if not destination.parent.is_dir():
        raise WorkflowError("output directory does not exist")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(destination, flags, 0o600)
    except FileExistsError as error:
        raise WorkflowError("refusing to overwrite an existing output") from error
    except OSError as error:
        raise WorkflowError(f"could not create output: {destination}") from error
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
        os.chmod(destination, 0o600)
    except OSError as error:
        raise WorkflowError(f"could not write output: {destination}") from error


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="learning-card",
        description="Create, check, and approve private learning-card JSON artifacts.",
    )
    commands = result.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="check a private card JSON file")
    validate.add_argument("card", type=Path)

    create = commands.add_parser(
        "create", help="create a private draft from narrow JSON"
    )
    create.add_argument("--input", required=True, type=Path)
    create.add_argument("--output", required=True, type=Path)

    brief = commands.add_parser("brief", help="build a local reviewer brief")
    brief.add_argument("card", type=Path)

    review = commands.add_parser("record-review", help="create a local review receipt")
    review.add_argument("--card", required=True, type=Path)
    review.add_argument(
        "--decision",
        required=True,
        choices=("approved", "rejected", "needs_evidence"),
    )
    review.add_argument("--reviewer", required=True)
    review.add_argument("--rationale", required=True)
    review.add_argument("--output", required=True, type=Path)

    finalize = commands.add_parser(
        "finalize", help="create a reviewed card from approval"
    )
    finalize.add_argument("--card", required=True, type=Path)
    finalize.add_argument("--review", required=True, type=Path)
    finalize.add_argument("--output", required=True, type=Path)

    pack = commands.add_parser("pack", help="create a local private HTML review pack")
    pack.add_argument("--cards", required=True, type=Path)
    pack.add_argument("--output", required=True, type=Path)

    summary = commands.add_parser(
        "pilot-summary", help="create a private aggregate pilot summary"
    )
    summary.add_argument("--cards", required=True, type=Path)
    summary.add_argument("--measurement", required=True, type=Path)
    summary.add_argument("--output", required=True, type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "validate":
            card = load_json_object(args.card)
            errors = validate_card(card)
            _print_json(
                {
                    "card_id": card.get("card_id"),
                    "errors": errors,
                    "valid": not errors,
                }
            )
            return 0 if not errors else 2
        if args.command == "create":
            draft = build_draft_card(load_json_object(args.input))
            write_private_json(args.output, draft)
            _print_json({"card_id": draft["card_id"], "output": str(args.output)})
            return 0
        if args.command == "brief":
            _print_json(build_reviewer_brief(load_json_object(args.card)))
            return 0
        if args.command == "record-review":
            receipt = build_review_receipt(
                load_json_object(args.card),
                decision=args.decision,
                reviewer=args.reviewer,
                rationale=args.rationale,
            )
            write_private_json(args.output, receipt)
            _print_json({"card_id": receipt["card_id"], "output": str(args.output)})
            return 0
        if args.command == "finalize":
            finalized = finalize_approved_card(
                load_json_object(args.card), load_json_object(args.review)
            )
            write_private_json(args.output, finalized)
            _print_json({"card_id": finalized["card_id"], "output": str(args.output)})
            return 0
        if args.command == "pack":
            cards = load_card_list(args.cards)
            write_private_text(args.output, render_reviewer_pack(cards))
            _print_json({"card_count": len(cards), "output": str(args.output)})
            return 0
        if args.command == "pilot-summary":
            summary = build_pilot_summary(
                load_json_object(args.measurement), load_card_list(args.cards)
            )
            write_private_json(args.output, summary)
            _print_json({"pilot_id": summary["pilot_id"], "output": str(args.output)})
            return 0
    except WorkflowError as error:
        print(f"learning-card: {error}", file=sys.stderr)
        return 2
    raise AssertionError(f"unexpected command: {args.command}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError(key)
        result[key] = value
    return result


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _print_json(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


if __name__ == "__main__":
    raise SystemExit(main())
