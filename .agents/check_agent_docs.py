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


def looks_like_path(token: str, doc: Path, root: Path) -> bool:
    if any(c in token for c in " <>{}*$|\\'\"") or "://" in token:
        return False
    if token.startswith(("~", "/", "-", "@", "origin/", "refs/", "#")):
        return False
    if token in PATH_EXT or re.fullmatch(r"\.[A-Za-z0-9]+", token):
        return False
    if re.search(r"[=:,;()]", token):
        return False
    if token.endswith(PATH_EXT):
        return True
    if "/" not in token.strip("/"):
        return False
    # Without a file extension, `a/b` is a path only if `a` is a real folder
    # (this skips owner/repo, application/json, and/or, v1/v2 and the like).
    first = token.strip("/").split("/")[0]
    return (root / first).is_dir() or (doc.parent / first).is_dir()


def words_with_extension(text: str) -> list[str]:
    """Path-like words inside commands, e.g. `cat docs/x.md` or a fenced line."""
    words = []
    for word in re.split(r"[\s=]+", text):
        word = word.strip("'\"`,;()[]")
        if word.endswith(PATH_EXT) and not word.startswith(("-", "$", "<", "~", "/", "http")) \
                and not any(c in word for c in "<>{}*$"):
            words.append(word)
    return words


def path_status(token: str, doc: Path, root: Path, paths: set[str]) -> str:
    """'ok', 'missing' or 'ambiguous'."""
    token = token.rstrip("/").split("#")[0]
    if not token:
        return "ok"
    relative_to_doc = os.path.normpath(os.path.join(os.path.relpath(doc.parent, root), token)).replace(os.sep, "/")
    if token in paths or relative_to_doc in paths:
        return "ok"
    # Paths written relative to a folder the doc names ("From voice-agent/: tests/x.py").
    suffix = "/" + token
    matches = [p for p in paths if p.endswith(suffix)]
    if not matches:
        return "missing"
    # A bare file name ("README.md") may legitimately match several files. A path
    # with a folder part must point at one file, or a deleted file goes unnoticed.
    return "ok" if len(matches) == 1 or "/" not in token else "ambiguous"


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
    """Input names under on.workflow_dispatch.inputs, read by indentation."""
    lines = path.read_text().splitlines()
    names: set[str] = set()
    for i, line in enumerate(lines):
        if line.strip() != "workflow_dispatch:":
            continue
        base = len(line) - len(line.lstrip())
        j = i + 1
        while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > base):
            stripped = lines[j].strip()
            if stripped == "inputs:":
                inputs_indent = len(lines[j]) - len(lines[j].lstrip())
                key_indent = None
                k = j + 1
                while k < len(lines):
                    if not lines[k].strip() or lines[k].strip().startswith("#"):
                        k += 1
                        continue
                    indent = len(lines[k]) - len(lines[k].lstrip())
                    if indent <= inputs_indent:
                        break
                    key_indent = indent if key_indent is None else key_indent
                    found = re.match(r"\s*([A-Za-z0-9_-]+):", lines[k])
                    if indent == key_indent and found:
                        names.add(found.group(1))
                    k += 1
            j += 1
    return names


def check(root: Path) -> list[tuple[str, int, str]]:
    problems: list[tuple[str, int, str]] = []
    paths = list_repo_paths(root)
    allow = read_list(root / ".agents" / "doc-check-allow.txt")
    codex_only = read_list(root / ".agents" / "codex-only.txt")

    for doc in doc_files(root):
        rel_doc = doc.relative_to(root).as_posix()
        lines = doc.read_text().splitlines()
        in_fence = False
        for number, line in enumerate(lines, 1):
            if line.lstrip().startswith(("```", "~~~")):
                in_fence = not in_fence
                continue
            if in_fence:
                commands = [line]
                tokens = words_with_extension(line)
            else:
                inline = re.findall(r"`([^`\n]+)`", line)
                commands = inline
                tokens = [t for t in inline if " " not in t.strip()]
                tokens += [w for t in inline if " " in t.strip() for w in words_with_extension(t)]
                tokens += re.findall(r"\]\(([^)\s]+)\)", line)
            for ref in set(re.findall(r"(?<![a-z])([a-z]{20})(?:\.supabase\.co)", line)) | \
                    {t.strip() for t in tokens if re.fullmatch(r"[a-z]{20}", t.strip())}:
                if ref not in allow:
                    problems.append((rel_doc, number, f"unlisted Supabase project ref `{ref}` (add it to .agents/doc-check-allow.txt if it is right)"))
            for command in commands:
                for module in re.findall(r"python3?\s+(?:-[A-Za-z]\s+)*-m\s+([A-Za-z_][\w.]*)", command):
                    if module not in allow and module_exists(module, paths) is False:
                        problems.append((rel_doc, number, f"module `{module}` not found"))
                for workflow, rest in re.findall(r"gh workflow run\s+(\S+\.ya?ml)(.*)", command):
                    wf = root / ".github" / "workflows" / workflow.strip("'\"")
                    if not wf.is_file():
                        problems.append((rel_doc, number, f"workflow `{workflow}` not found"))
                        continue
                    declared = workflow_inputs(wf)
                    for key in re.findall(r"(?:-f|-F|--field|--raw-field)\s+['\"]?([\w-]+)=", rest):
                        if key not in declared:
                            problems.append((rel_doc, number, f"workflow `{workflow}` has no input `{key}`"))
            for raw in tokens:
                token = raw.strip()
                if token in allow or re.fullmatch(r"[a-z]{20}", token):
                    continue
                if not looks_like_path(token, doc, root):
                    continue
                status = path_status(token, doc, root, paths)
                if status == "missing":
                    problems.append((rel_doc, number, f"path `{token}` not found"))
                elif status == "ambiguous":
                    problems.append((rel_doc, number, f"path `{token}` matches several files; write it from the repo root"))
        if rel_doc == "AGENTS.md" and len(lines) > MAX_AGENTS_LINES:
            problems.append((rel_doc, 1, f"{len(lines)} lines; keep AGENTS.md under {MAX_AGENTS_LINES} and route detail to docs/"))
        if rel_doc == "CLAUDE.md" and "@AGENTS.md" not in "\n".join(lines):
            problems.append((rel_doc, 1, "CLAUDE.md should import @AGENTS.md"))

    skills = root / ".agents" / "skills"
    for skill_dir in sorted(skills.iterdir()) if skills.is_dir() else []:
        if not skill_dir.is_dir():
            continue
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
        desc = re.search(r"^description:[ \t]*(.*)\n?((?:[ \t]+.*\n?)*)", match.group(1) + "\n", re.M)
        desc_text = ""
        if desc:
            desc_text = desc.group(1).strip()
            if desc_text in ("", ">", "|", ">-", "|-", ">+", "|+"):
                desc_text = " ".join(l.strip() for l in desc.group(2).splitlines())
        if not desc_text or len(desc_text) > MAX_DESCRIPTION:
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
