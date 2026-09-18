"""Offline consistency checks for evidence attached to learning cards.

This module never retrieves GitHub, CI, Linear, or session data.  It checks the
identifiers in evidence that a caller has already captured locally.  A passing
result therefore means that the supplied provenance is internally consistent,
not that this module independently established an external fact.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

_COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_RUN_ID = re.compile(r"^[1-9][0-9]*$")


def verify_evidence_provenance(
    evidence: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Check exact local commit/PR/CI linkage without making network calls.

    Evidence may omit ``provenance`` while a card is still a low- or
    medium-confidence draft.  Once provenance is supplied, each enriched
    commit, pull request, and CI record must be precise and mutually linked:

    * a PR names its repository, number, and exact head commit SHA;
    * a CI run names the same repository and exact tested head SHA; and
    * both SHAs resolve to an explicit commit artifact in this local bundle.

    ``independent_outcome_evidence_ids`` is deliberately conservative: a CI
    run qualifies only when its conclusion is ``success`` and it belongs to a
    complete chain.  Direct human review and a passed benchmark can also
    qualify when their bounded result metadata is present.
    """

    errors: list[str] = []
    enriched_ids: set[str] = set()
    commits: dict[tuple[str, str], str] = {}
    pull_requests: list[dict[str, str | int]] = []
    ci_runs: list[dict[str, str]] = []
    independent_outcomes: list[str] = []

    for index, item in enumerate(evidence):
        if not isinstance(item, Mapping):
            errors.append(f"evidence[{index}] must be a mapping")
            continue

        evidence_id = item.get("evidence_id")
        if not _text(evidence_id):
            errors.append(f"evidence[{index}].evidence_id must be a non-empty string")
            continue

        provenance = item.get("provenance")
        if provenance is None:
            continue
        enriched_ids.add(evidence_id)
        if not isinstance(provenance, Mapping):
            errors.append(f"evidence {evidence_id} provenance must be a mapping")
            continue

        kind = item.get("kind")
        if kind == "commit":
            record = _commit_record(item, provenance, errors)
            if record is not None:
                repository, commit_sha = record
                commits[(repository, commit_sha)] = evidence_id
        elif kind == "pull_request":
            record = _pull_request_record(item, provenance, errors)
            if record is not None:
                pull_requests.append({**record, "evidence_id": evidence_id})
        elif kind == "ci_run":
            record = _ci_run_record(item, provenance, errors)
            if record is not None:
                ci_runs.append({**record, "evidence_id": evidence_id})
        elif kind == "human_review":
            if _review_is_independent_outcome(item, provenance, errors):
                independent_outcomes.append(evidence_id)
        elif kind == "benchmark":
            if _benchmark_is_independent_outcome(item, provenance, errors):
                independent_outcomes.append(evidence_id)
        else:
            errors.append(
                f"evidence {evidence_id} has provenance for unsupported kind {kind!r}"
            )

    linked_pull_request_ids: set[str] = set()
    for pull_request in pull_requests:
        repository = str(pull_request["repository"])
        head_commit_sha = str(pull_request["head_commit_sha"])
        evidence_id = str(pull_request["evidence_id"])
        if (repository, head_commit_sha) not in commits:
            errors.append(
                f"pull request evidence {evidence_id} must link to an exact commit artifact"
            )
        else:
            linked_pull_request_ids.add(evidence_id)

    linked_chains: list[dict[str, Any]] = []
    for ci_run in ci_runs:
        repository = ci_run["repository"]
        head_commit_sha = ci_run["head_commit_sha"]
        evidence_id = ci_run["evidence_id"]
        linked_prs = [
            pull_request
            for pull_request in pull_requests
            if pull_request["repository"] == repository
            and pull_request["head_commit_sha"] == head_commit_sha
            and pull_request["evidence_id"] in linked_pull_request_ids
        ]
        if (repository, head_commit_sha) not in commits or not linked_prs:
            errors.append(
                f"CI evidence {evidence_id} must link to the exact commit and pull-request artifacts"
            )
            continue

        linked_chains.append(
            {
                "repository": repository,
                "commit_sha": head_commit_sha,
                "commit_evidence_id": commits[(repository, head_commit_sha)],
                "pull_request_evidence_ids": [
                    pull_request["evidence_id"] for pull_request in linked_prs
                ],
                "ci_run_evidence_id": evidence_id,
            }
        )
        if (
            ci_run["conclusion"] == "success"
            and _supports_outcome(ci_run)
            and ci_run["verification"] == "direct"
        ):
            independent_outcomes.append(evidence_id)

    return {
        "valid": not errors,
        "errors": errors,
        "enriched_evidence_ids": sorted(enriched_ids),
        "linked_chains": linked_chains,
        "independent_outcome_evidence_ids": sorted(independent_outcomes),
    }


def _commit_record(
    evidence: Mapping[str, Any], provenance: Mapping[str, Any], errors: list[str]
) -> tuple[str, str] | None:
    evidence_id = str(evidence["evidence_id"])
    repository = provenance.get("repository")
    commit_sha = provenance.get("commit_sha")
    if not _repository(repository):
        errors.append(f"commit evidence {evidence_id} needs a repository owner/name")
    if not _commit_sha(commit_sha):
        errors.append(
            f"commit evidence {evidence_id} needs a 40-character lowercase SHA"
        )
    if _repository(repository) and _commit_sha(commit_sha):
        expected_reference = f"git:{commit_sha}"
        if evidence.get("reference") != expected_reference:
            errors.append(
                f"commit evidence {evidence_id} reference must equal {expected_reference}"
            )
        return repository, commit_sha
    return None


def _pull_request_record(
    evidence: Mapping[str, Any], provenance: Mapping[str, Any], errors: list[str]
) -> dict[str, str | int] | None:
    evidence_id = str(evidence["evidence_id"])
    repository = provenance.get("repository")
    pull_number = provenance.get("pull_number")
    head_commit_sha = provenance.get("head_commit_sha")
    if not _repository(repository):
        errors.append(
            f"pull request evidence {evidence_id} needs a repository owner/name"
        )
    if (
        not isinstance(pull_number, int)
        or isinstance(pull_number, bool)
        or pull_number < 1
    ):
        errors.append(
            f"pull request evidence {evidence_id} needs a positive pull_number"
        )
    if not _commit_sha(head_commit_sha):
        errors.append(
            f"pull request evidence {evidence_id} needs a 40-character lowercase head_commit_sha"
        )
    if (
        _repository(repository)
        and isinstance(pull_number, int)
        and not isinstance(pull_number, bool)
        and pull_number > 0
    ):
        expected_reference = f"{repository}#{pull_number}"
        if evidence.get("reference") != expected_reference:
            errors.append(
                f"pull request evidence {evidence_id} reference must equal {expected_reference}"
            )
    if (
        _repository(repository)
        and isinstance(pull_number, int)
        and not isinstance(pull_number, bool)
        and pull_number > 0
        and _commit_sha(head_commit_sha)
    ):
        return {
            "repository": repository,
            "pull_number": pull_number,
            "head_commit_sha": head_commit_sha,
        }
    return None


def _ci_run_record(
    evidence: Mapping[str, Any], provenance: Mapping[str, Any], errors: list[str]
) -> dict[str, str] | None:
    evidence_id = str(evidence["evidence_id"])
    repository = provenance.get("repository")
    run_id = provenance.get("run_id")
    head_commit_sha = provenance.get("head_commit_sha")
    conclusion = provenance.get("conclusion")
    if not _repository(repository):
        errors.append(f"CI evidence {evidence_id} needs a repository owner/name")
    if not _run_id(run_id):
        errors.append(f"CI evidence {evidence_id} needs a positive numeric run_id")
    if not _commit_sha(head_commit_sha):
        errors.append(
            f"CI evidence {evidence_id} needs a 40-character lowercase head_commit_sha"
        )
    if conclusion not in {"success", "failure", "cancelled", "skipped"}:
        errors.append(
            f"CI evidence {evidence_id} conclusion must be success, failure, cancelled, or skipped"
        )
    if _run_id(run_id) and evidence.get("reference") != f"github-actions:{run_id}":
        errors.append(
            f"CI evidence {evidence_id} reference must equal github-actions:{run_id}"
        )
    if (
        _repository(repository)
        and _run_id(run_id)
        and _commit_sha(head_commit_sha)
        and isinstance(conclusion, str)
    ):
        return {
            "repository": repository,
            "run_id": run_id,
            "head_commit_sha": head_commit_sha,
            "conclusion": conclusion,
            "verification": str(evidence.get("verification")),
            "supports": evidence.get("supports"),
        }
    return None


def _review_is_independent_outcome(
    evidence: Mapping[str, Any], provenance: Mapping[str, Any], errors: list[str]
) -> bool:
    evidence_id = str(evidence["evidence_id"])
    review_id = provenance.get("review_id")
    if not _text(review_id):
        errors.append(f"human review evidence {evidence_id} needs a review_id")
        return False
    if provenance.get("decision") != "approved":
        errors.append(f"human review evidence {evidence_id} decision must be approved")
        return False
    return evidence.get("verification") == "direct" and _supports_outcome(evidence)


def _benchmark_is_independent_outcome(
    evidence: Mapping[str, Any], provenance: Mapping[str, Any], errors: list[str]
) -> bool:
    evidence_id = str(evidence["evidence_id"])
    benchmark_id = provenance.get("benchmark_id")
    if not _text(benchmark_id):
        errors.append(f"benchmark evidence {evidence_id} needs a benchmark_id")
        return False
    if provenance.get("result") != "passed":
        errors.append(f"benchmark evidence {evidence_id} result must be passed")
        return False
    return evidence.get("verification") == "direct" and _supports_outcome(evidence)


def _supports_outcome(evidence: Mapping[str, Any]) -> bool:
    supports = evidence.get("supports")
    return isinstance(supports, list) and "outcome" in supports


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _commit_sha(value: Any) -> bool:
    return isinstance(value, str) and bool(_COMMIT_SHA.fullmatch(value))


def _repository(value: Any) -> bool:
    return isinstance(value, str) and bool(_REPOSITORY.fullmatch(value))


def _run_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_RUN_ID.fullmatch(value))
