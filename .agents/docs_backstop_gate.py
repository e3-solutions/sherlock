#!/usr/bin/env python3
"""Decide whether a merged PR needs a docs follow-up (COR-5202 backstop gate).

Prints GitHub Actions outputs (`needed=true|false`, `reason=...`) and writes the
changed code files to --files-out. A follow-up is needed when the PR changed
code (10+ lines, or added/deleted a code file), touched no Markdown, docs/,
.agents/ or .claude/ file, and no commit carries a `Docs-Check:` trailer, which
the agent-side Stop hook asks for once docs were checked.

Usage: python3 .agents/docs_backstop_gate.py --base SHA --head SHA [--files-out PATH]
"""
from __future__ import annotations

import argparse
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


def decide(base: str, head: str) -> tuple[bool, str, list[str]]:
    files: list[str] = []
    lines = 0
    for row in git("diff", "--numstat", "--no-renames", base, head).splitlines():
        added, deleted, path = (row.split("\t", 2) + ["", ""])[:3]
        files.append(path)
        if is_code(path):
            lines += (int(added) if added.isdigit() else 0) + (int(deleted) if deleted.isdigit() else 0)
    structural = any(row[:1] in ("A", "D") and is_code(row.split("\t")[-1])
                     for row in git("diff", "--name-status", "--no-renames", base, head).splitlines())
    code = [p for p in files if is_code(p)]
    if not code:
        return False, "no code changed", code
    if any(is_doc(p) for p in files):
        return False, "docs already changed in this PR", code
    if lines < MIN_CHANGED_LINES and not structural:
        return False, f"trivial code change ({lines} lines)", code
    messages = git("log", "--format=%B", f"{base}..{head}")
    if any(line.lower().startswith("docs-check:") for line in messages.splitlines()):
        return False, "a commit carries a Docs-Check trailer", code
    return True, f"{len(code)} code files, {lines} lines, no docs touched", code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--files-out")
    args = parser.parse_args()
    try:
        needed, reason, code = decide(args.base, args.head)
    except subprocess.CalledProcessError as exc:
        needed, reason, code = False, f"git failed: {exc.stderr.strip()[:200]}", []
    if args.files_out:
        with open(args.files_out, "w", encoding="utf-8") as handle:
            handle.write("\n".join(code) + ("\n" if code else ""))
    print(f"needed={'true' if needed else 'false'}")
    print(f"reason={reason}")
    print(f"docs backstop gate: {reason}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
