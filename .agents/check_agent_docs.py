#!/usr/bin/env python3
"""Check that agent docs and skills still match the repository.

Reads AGENTS.md, CLAUDE.md, docs/README.md and .agents/skills/*/SKILL.md and
reports names that no longer exist: file paths, `python -m` modules, workflow
files and `gh workflow run -f` inputs. It also checks skill frontmatter, the
.claude/skills links, and file sizes. Standard library only; runs nothing and
uses no network.

Usage: python3 .agents/check_agent_docs.py [--warn] [--root DIR]
  --warn  print GitHub warning annotations and exit 0 (rollout mode)

Exceptions, one per line, in .agents/doc-check-allow.txt (for names that live in
another repository or branch, or files created at runtime). Skills that are
Codex-only (no .claude/skills link) go in .agents/codex-only.txt.

Vendored copy. Canonical source: e3-solutions/jolly-roger .agents/check_agent_docs.py.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
PATH_EXT = (".md", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".yml", ".yaml", ".sql",
            ".sh", ".json", ".toml", ".txt", ".ini", ".html", ".tmpl")
MAX_AGENTS_LINES = 150
MAX_SKILL_LINES = 500
MAX_DESCRIPTION = 1024


def list_repo_paths(root: Path) -> set[str]:
    """Every file and directory, relative to root, with '/' separators."""
    paths: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel = os.path.relpath(dirpath, root)
        rel = "" if rel == "." else rel.replace(os.sep, "/")
        if rel:
            paths.add(rel)
        for name in filenames + dirnames:
            paths.add(f"{rel}/{name}" if rel else name)
    return paths


def read_list(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text().splitlines()
            if line.strip() and not line.strip().startswith("#")}


def doc_files(root: Path) -> list[Path]:
    files = [root / name for name in ("AGENTS.md", "CLAUDE.md", "docs/README.md") if (root / name).is_file()]
    skills = root / ".agents" / "skills"
    if skills.is_dir():
        files += sorted(p / "SKILL.md" for p in skills.iterdir() if (p / "SKILL.md").is_file())
    return files


def looks_like_path(token: str) -> bool:
    if any(c in token for c in " <>{}*$|\\") or "://" in token:
        return False
    if token.startswith(("~", "/", "-", "@", "origin/", "refs/", "#")):
        return False
    if token in PATH_EXT or re.fullmatch(r"\.[A-Za-z0-9]+", token):
        return False
    if re.search(r"[=:,;()]", token):
        return False
    return "/" in token.strip("/") or token.endswith(PATH_EXT)


def path_exists(token: str, doc: Path, root: Path, paths: set[str]) -> bool:
    token = token.rstrip("/").split("#")[0]
    if not token:
        return True
    relative_to_doc = os.path.normpath(os.path.join(os.path.relpath(doc.parent, root), token)).replace(os.sep, "/")
    if token in paths or relative_to_doc in paths:
        return True
    # Paths written relative to a folder the doc names ("From voice-agent/: tests/x.py").
    suffix = "/" + token
    return any(p.endswith(suffix) for p in paths)


def module_exists(module: str, paths: set[str]) -> bool | None:
    """True/False for repo-local modules; None for third-party modules."""
    rel = module.replace(".", "/")
    candidates = (rel + ".py", rel + "/__init__.py", rel + "/__main__.py")
    if any(c in paths or any(p.endswith("/" + c) for p in paths) for c in candidates):
        return True
    top = module.split(".")[0]
    local_tops = {p.rsplit("/", 1)[-1] for p in paths if p.rsplit("/", 1)[-1] in (top, top + ".py")}
    return False if local_tops else None


def workflow_inputs(path: Path) -> set[str]:
    text = path.read_text()
    match = re.search(r"workflow_dispatch:\s*\n\s+inputs:\s*\n((?:\s{6,}.*\n?)*)", text)
    if not match:
        return set()
    return set(re.findall(r"^\s{6,8}([A-Za-z0-9_-]+):\s*$", match.group(1), re.M))


def check(root: Path) -> list[tuple[str, int, str]]:
    problems: list[tuple[str, int, str]] = []
    paths = list_repo_paths(root)
    allow = read_list(root / ".agents" / "doc-check-allow.txt")
    codex_only = read_list(root / ".agents" / "codex-only.txt")

    for doc in doc_files(root):
        rel_doc = doc.relative_to(root).as_posix()
        lines = doc.read_text().splitlines()
        for number, line in enumerate(lines, 1):
            tokens = re.findall(r"`([^`\n]+)`", line) + re.findall(r"\]\(([^)\s]+)\)", line)
            for raw in tokens:
                token = raw.strip()
                if token in allow:
                    continue
                if re.fullmatch(r"[a-z]{20}", token):
                    problems.append((rel_doc, number, f"unlisted Supabase project ref `{token}` (add it to .agents/doc-check-allow.txt if it is right)"))
                    continue
                for module in re.findall(r"python3?\s+(?:-[A-Za-z]\s+)*-m\s+([A-Za-z_][\w.]*)", token):
                    if module not in allow and module_exists(module, paths) is False:
                        problems.append((rel_doc, number, f"module `{module}` not found"))
                for workflow, inputs in re.findall(r"gh workflow run\s+(\S+\.ya?ml)((?:\s+-f\s+[\w-]+=\S*)*)", token):
                    wf = root / ".github" / "workflows" / workflow
                    if not wf.is_file():
                        problems.append((rel_doc, number, f"workflow `{workflow}` not found"))
                        continue
                    declared = workflow_inputs(wf)
                    for key in re.findall(r"-f\s+([\w-]+)=", inputs):
                        if key not in declared:
                            problems.append((rel_doc, number, f"workflow `{workflow}` has no input `{key}`"))
                if looks_like_path(token) and not path_exists(token, doc, root, paths):
                    problems.append((rel_doc, number, f"path `{token}` not found"))
        if rel_doc == "AGENTS.md" and len(lines) > MAX_AGENTS_LINES:
            problems.append((rel_doc, 1, f"{len(lines)} lines; keep AGENTS.md under {MAX_AGENTS_LINES} and route detail to docs/"))
        if rel_doc == "CLAUDE.md" and "@AGENTS.md" not in "\n".join(lines):
            problems.append((rel_doc, 1, "CLAUDE.md should import @AGENTS.md"))

    skills = root / ".agents" / "skills"
    for skill_dir in sorted(skills.iterdir()) if skills.is_dir() else []:
        name = skill_dir.name
        rel = f".agents/skills/{name}/SKILL.md"
        skill = skill_dir / "SKILL.md"
        if not skill.is_file():
            problems.append((rel, 1, "missing SKILL.md"))
            continue
        text = skill.read_text()
        match = re.match(r"---\n(.*?)\n---\n", text, re.S)
        if not match:
            problems.append((rel, 1, "missing frontmatter"))
            continue
        keys = re.findall(r"^([A-Za-z_-]+):", match.group(1), re.M)
        if keys != ["name", "description"]:
            problems.append((rel, 1, f"frontmatter keys {keys}; use only name and description so Claude Code and Codex both accept it"))
        found = re.search(r"^name:\s*(.+)$", match.group(1), re.M)
        if not found or found.group(1).strip() != name:
            problems.append((rel, 1, "name must equal the folder name"))
        desc = re.search(r"^description:\s*(.+)$", match.group(1), re.M)
        if not desc or len(desc.group(1)) > MAX_DESCRIPTION:
            problems.append((rel, 1, f"description missing or over {MAX_DESCRIPTION} characters"))
        if text.count("\n") > MAX_SKILL_LINES:
            problems.append((rel, 1, f"over {MAX_SKILL_LINES} lines; move detail to a references/ file"))
        if name not in codex_only:
            link = root / ".claude" / "skills" / name
            if not link.is_symlink() or os.readlink(link) != f"../../.agents/skills/{name}":
                problems.append((rel, 1, f".claude/skills/{name} must be a symlink to ../../.agents/skills/{name}"))
    claude_skills = root / ".claude" / "skills"
    for link in sorted(claude_skills.iterdir()) if claude_skills.is_dir() else []:
        if link.is_symlink() and not link.exists():
            problems.append((f".claude/skills/{link.name}", 1, "broken symlink"))
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--warn", action="store_true", help="annotate and exit 0")
    parser.add_argument("--root", default=".", help="repository root")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    problems = check(root)
    for file, line, message in problems:
        if args.warn and os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::warning file={file},line={line}::{message}")
        else:
            print(f"{file}:{line}: {message}")
    print(f"agent docs check: {len(problems)} problem(s)")
    return 0 if args.warn or not problems else 1


if __name__ == "__main__":
    sys.exit(main())
