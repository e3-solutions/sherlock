#!/usr/bin/env python3
"""Decide whether a merged PR needs a docs follow-up (COR-5202 backstop gate).

Prints GitHub Actions outputs (`needed=true|false`, `reason=...`) and writes the
changed code files to --files-out. A follow-up is needed when the PR changed
code (10+ lines, or added/deleted a code file), touched no Markdown, docs/,
.agents/ or .claude/ file, and no commit carries a `Docs-Check:` trailer, which
the agent-side Stop hook asks for once docs were checked.

It reads the PR's own files and commits from the GitHub API (`--repo`, `--pr`),
so other PRs merged meanwhile and squash merges do not change the answer.
`--base`/`--head` diff two local commits instead, for testing.

Usage: python3 .agents/docs_backstop_gate.py --repo OWNER/NAME --pr N [--files-out PATH]
       python3 .agents/docs_backstop_gate.py --base SHA --head SHA [--files-out PATH]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

DOC_PREFIXES = ("docs/", ".agents/", ".claude/", ".codex/", ".github/ISSUE_TEMPLATE/")
NOT_CODE_SUFFIXES = (".lock", "-lock.json", "-lock.yaml", ".lockb", ".png", ".jpg", ".svg", ".pdf")
MIN_CHANGED_LINES = 10


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def is_doc(path: str) -> bool:
    return path.endswith(".md") or path.startswith(DOC_PREFIXES)


def is_code(path: str) -> bool:
    return not is_doc(path) and not path.endswith(NOT_CODE_SUFFIXES)


def from_git(base: str, head: str) -> tuple[list[dict], str]:
    changes = []
    status = {row.split("\t")[-1]: row[:1] for row in
              git("diff", "--name-status", "--no-renames", base, head).splitlines()}
    for row in git("diff", "--numstat", "--no-renames", base, head).splitlines():
        added, deleted, path = (row.split("\t", 2) + ["", ""])[:3]
        changes.append({"filename": path, "status": {"A": "added", "D": "removed"}.get(status.get(path, ""), "modified"),
                        "additions": int(added) if added.isdigit() else 0,
                        "deletions": int(deleted) if deleted.isdigit() else 0})
    return changes, git("log", "--format=%B", f"{base}..{head}")


def gh_lines(*args: str) -> list[str]:
    out = subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def from_github(repo: str, pr: str) -> tuple[list[dict], str]:
    files = [json.loads(line) for line in gh_lines(
        "api", f"repos/{repo}/pulls/{pr}/files", "--paginate",
        "--jq", ".[] | {filename, status, additions, deletions} | @json")]
    messages = [json.loads(line) for line in gh_lines(
        "api", f"repos/{repo}/pulls/{pr}/commits", "--paginate", "--jq", ".[].commit.message | @json")]
    return files, "\n".join(messages)


def decide(changes: list[dict], messages: str) -> tuple[bool, str, list[str]]:
    files = [c["filename"] for c in changes]
    lines = sum(c["additions"] + c["deletions"] for c in changes if is_code(c["filename"]))
    structural = any(c["status"] in ("added", "removed") and is_code(c["filename"]) for c in changes)
    code = [p for p in files if is_code(p)]
    if not code:
        return False, "no code changed", code
    if any(is_doc(p) for p in files):
        return False, "docs already changed in this PR", code
    if lines < MIN_CHANGED_LINES and not structural:
        return False, f"trivial code change ({lines} lines)", code
    if any(line.lower().startswith("docs-check:") for line in messages.splitlines()):
        return False, "a commit carries a Docs-Check trailer", code
    return True, f"{len(code)} code files, {lines} lines, no docs touched", code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo")
    parser.add_argument("--pr")
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--files-out")
    args = parser.parse_args()
    try:
        if args.repo and args.pr:
            changes, messages = from_github(args.repo, args.pr)
        elif args.base and args.head:
            changes, messages = from_git(args.base, args.head)
        else:
            parser.error("give --repo and --pr, or --base and --head")
        needed, reason, code = decide(changes, messages)
    except (subprocess.CalledProcessError, ValueError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        needed, reason, code = False, "lookup failed: " + " ".join(str(detail).split())[:200], []
    if args.files_out:
        with open(args.files_out, "w", encoding="utf-8") as handle:
            handle.write("\n".join(code) + ("\n" if code else ""))
    print(f"needed={'true' if needed else 'false'}")
    print(f"reason={reason}")
    print(f"docs backstop gate: {reason}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
