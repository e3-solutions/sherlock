"""Offline synthetic probe against a pinned, read-only Sesh checkout.

No credentials, network calls, Storage writes, index writes or private inputs.
This demonstrates a contract boundary, not successful Sesh publication/search.
"""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SESH_REVISION = "f1abaae89dbcf007293ea703d5e6e9896f764427"
OWNER = "00000000-0000-4000-8000-000000000001"
SESSION = "synthetic-hosted-task"
REPOSITORY = "e3-solutions/synthetic-slack-setup"
CREATED_AT = "2026-10-05T08:00:00+00:00"


def consent(scope="full_transcript_indexing"):
    return {"schema_version": 1, "opted_in": True, "owner_id": OWNER,
            "repository_id": REPOSITORY, "session_id": SESSION,
            "attested_at": CREATED_AT, "scope": scope}


def timetracker_export():
    """Synthetic positive control only, never a hosted-task conversion."""
    text = "SYNTHETIC_ONLY: three weekday Slack setup checks at 08:00, 10:00, 18:00."
    digest = hashlib.sha256(text.encode()).hexdigest()
    common = {"id": "00000000-0000-4000-8000-000000000002", "session_id": SESSION,
              "user_id": OWNER, "seq": 1, "role": "assistant",
              "content_sha256": digest, "content_byte_size": len(text.encode()),
              "metadata": {"synthetic": True}, "created_at": CREATED_AT}
    stored = {**common, "type": "message", "thread_id": "synthetic-thread",
              "turn_id": "synthetic-turn", "content": text}
    return {"chat": {"id": SESSION, "user_id": OWNER, "repo": REPOSITORY,
                     "branch": None, "metadata": {"synthetic": True},
                     "started_at": CREATED_AT, "ended_at": None},
            "messages": [{**common, "content_excerpt": "Synthetic excerpt", "content": stored}]}


def hosted_handoff():
    # Proposed handoff identity is truthful about partial, reviewed content.
    # It is NOT an accepted Sesh schema and does not imply authentic consent.
    return {"schema_version": "hosted-reviewed-excerpt-proposal-v1",
            "source": "codex-app.read_thread.v1", "session_id": SESSION,
            "coverage": {"content": "selected_reviewed_excerpt", "full_transcript": False},
            "messages": [{"id": "synthetic-item", "role": "assistant",
                          "text": "SYNTHETIC_ONLY: Slack automation setup."}]}


def load_source_handle_without_runtime(root):
    # Execute only the current pure source_handle function; avoid server imports,
    # optional models, runtime credentials and any network setup.
    path = root / "sesh_search/service.py"
    tree = ast.parse(path.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "source_handle")
    namespace = {}
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, str(path), "exec"), namespace)
    return namespace["source_handle"]


def run(root):
    root = Path(root).resolve()
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    modified = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], text=True)
    if revision != SESH_REVISION or modified:
        raise ValueError("pinned_clean_sesh_checkout_required")
    sys.path.insert(0, str(root))
    from sesh_ingest.cosmos_get_chat import ConsentReceipt, CosmosExportError, CosmosGetChatAdapter
    from sesh_ingest.models import SourceSessionMeta
    from sesh_ingest.normalize import JsonTranscriptNormalizer

    adapter = CosmosGetChatAdapter()
    results = []

    def converted(value, receipt):
        return adapter.convert(json.dumps(value).encode(), consent=receipt,
                               expected_owner_id=OWNER, expected_repository_id=REPOSITORY)

    control = converted(timetracker_export(), consent())
    assert len(control.message_provenance) == 1
    results.append({"case": "synthetic_timetracker_positive_control", "result": "accepted"})

    def rejected(name, operation, expected):
        try:
            operation()
        except CosmosExportError as error:
            if str(error) != expected:
                raise AssertionError("unexpected_contract_rejection") from None
            results.append({"case": name, "result": "rejected", "reason": expected})
        else:
            raise AssertionError("unexpected_contract_acceptance")

    rejected("selected_excerpt_consent", lambda: ConsentReceipt.from_value(consent("selected_excerpt_indexing")),
             "consent scope does not permit transcript indexing")
    rejected("truthful_hosted_handoff_shape", lambda: converted(hosted_handoff(), consent()),
             "get_chat export must contain only chat and messages")
    excerpt = timetracker_export()
    excerpt["messages"][0].pop("content")
    rejected("excerpt_without_original_stored_message", lambda: converted(excerpt, consent()),
             "full stored message JSON is required")

    # The low-level normalizer can accept text but does not preserve handoff
    # coverage/provenance in NormalizedMessage. Acceptance alone is not support.
    meta = SourceSessionMeta("synthetic-hosted-handoff", SESSION, OWNER, REPOSITORY,
                             "codex", datetime(2026, 10, 5, tzinfo=timezone.utc))
    normalized = JsonTranscriptNormalizer().normalize(json.dumps(hosted_handoff()).encode(), meta)
    assert len(normalized.messages) == 1
    assert set(normalized.messages[0].__dict__) == {"message_id", "role", "text"}
    results.append({"case": "generic_normalizer", "result": "accepts_text_but_drops_handoff_provenance"})

    handle = load_source_handle_without_runtime(root)({"source_session_id": SESSION,
        "source_message_ids": ["synthetic-item"], "source_kind": "hosted_reviewed_excerpt"})
    assert handle["provider"] == "Cosmos Coding Sessions" and handle["tool"] == "get_chat"
    assert handle["arguments"] == {"sessionId": SESSION, "includeContent": True}
    results.append({"case": "hosted_source_open", "result": "routes_to_existing_timetracker_catalog"})
    return {"schema_version": 1, "sesh_revision": revision, "synthetic_only": True,
            "network_used": False, "content_published": False,
            "hosted_excerpt_sesh_support": "requires_external_sesh_changes", "probes": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sesh-root", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.sesh_root), sort_keys=True, indent=2))
    except Exception:
        print(json.dumps({"error": "sesh_boundary_probe_failed"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
