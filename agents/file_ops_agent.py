#!/usr/bin/env python3
"""
File scanning / creation / writing LangChain agent for HeySalad MCP.

Backed by GPT-OSS via Hugging Face router. Provides repo-aware tools:
- list_repo_files
- search_repo
- read_repo_file
- write_repo_file (create/overwrite)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Iterable, List, Sequence

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import tool
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

REPO_ROOT = Path(__file__).resolve().parents[1]
IGNORE_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".idea", ".mypy_cache"}
DEFAULT_MAX_CHARS = 6000


def ensure_hf_token() -> str:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN environment variable is required for file_ops_agent.")
    return token


def _iter_repo_files() -> Iterable[Path]:
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = Path(root).relative_to(REPO_ROOT)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file_name in files:
            rel_parts = rel_root.parts + (file_name,)
            if any(part in IGNORE_DIRS for part in rel_parts):
                continue
            yield Path(root, file_name)


def _read_text(path: Path, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    data = path.read_text(encoding="utf-8", errors="ignore")
    if len(data) > max_chars:
        return data[:max_chars] + f"\n\n… (truncated to {max_chars} chars)"
    return data


def _resolve_relative(relative_path: str) -> Path:
    target = (REPO_ROOT / relative_path).resolve()
    if REPO_ROOT not in target.parents and target != REPO_ROOT:
        raise PermissionError("Can only access files inside the HeySalad MCP repo.")
    return target


@tool
def list_repo_files(limit: int = 120) -> str:
    """List up to `limit` repository files (text-first)."""
    files: List[str] = []
    skip_suffixes = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".mp4", ".mov", ".lock"}
    for path in _iter_repo_files():
        if path.suffix.lower() in skip_suffixes:
            continue
        files.append(str(path.relative_to(REPO_ROOT)))
        if len(files) >= limit:
            break
    return "\n".join(files) if files else "No files discovered."


@tool
def search_repo(keyword: str, max_hits: int = 40) -> str:
    """Search repository files for `keyword` and return matching lines."""
    keyword_lower = keyword.lower()
    matches: List[str] = []
    for path in _iter_repo_files():
        if len(matches) >= max_hits:
            break
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if keyword_lower in content.lower():
            for line_no, line in enumerate(content.splitlines(), start=1):
                if keyword_lower in line.lower():
                    matches.append(f"{path.relative_to(REPO_ROOT)}:{line_no}: {line.strip()}")
                    break
    return "Matches:\n" + "\n".join(matches) if matches else f'No matches for "{keyword}".'


@tool
def read_repo_file(relative_path: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """Read a file relative to the repo root."""
    target = _resolve_relative(relative_path)
    if not target.exists():
        raise FileNotFoundError(f"{relative_path} not found.")
    return _read_text(target, max_chars=max_chars)


@tool
def write_repo_file(relative_path: str, content: str) -> str:
    """Create or overwrite a file inside the repo."""
    target = _resolve_relative(relative_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Wrote {relative_path} ({len(content)} chars)."


def build_agent(verbose: bool = False) -> AgentExecutor:
    ensure_hf_token()
    llm = ChatOpenAI(
        api_key=os.environ["HF_TOKEN"],
        base_url=os.environ.get("HF_BASE_URL", "https://router.huggingface.co/v1"),
        model=os.environ.get("FILE_OPS_MODEL", "openai/gpt-oss-120b:groq"),
        temperature=float(os.environ.get("FILE_OPS_TEMPERATURE", "0.1")),
        max_retries=2,
    )

    tools = [list_repo_files, search_repo, read_repo_file, write_repo_file]
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                (
                    "You are the HeySalad file operations expert. You can scan, read, "
                    "and write files inside the repository at {repo_root}. "
                    "Use the provided tools to gather context or apply changes. "
                    "Be explicit about modifications and warn before overwriting data."
                ),
            ),
            MessagesPlaceholder("chat_history"),
            ("user", "{input}"),
            MessagesPlaceholder("agent_scratchpad"),
        ]
    ).partial(repo_root=str(REPO_ROOT))

    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=verbose, handle_parsing_errors=True)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HeySalad file scanning / writing agent.")
    parser.add_argument("task", help="Instruction for the agent.")
    parser.add_argument("--history", help="Optional JSON history file.", default=None)
    parser.add_argument("--verbose", action="store_true", help="Enable LangChain debug output.")
    return parser.parse_args(argv or sys.argv[1:])


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    history_file = Path(path)
    if not history_file.exists():
        raise FileNotFoundError(f"history file {path} not found.")
    data = json.loads(history_file.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("history file must be a JSON list of messages.")
    return data


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    history = load_history(args.history)
    executor = build_agent(verbose=args.verbose)
    result = executor.invoke({"input": args.task, "chat_history": history})
    print(result.get("output", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
