#!/usr/bin/env python3
"""
CLI helper that sends HeySalad MCP coding tasks to DeepSeek Coder 33B
via the hosted Hugging Face Space (gradio_client API).

It optionally inlines snippets from this repository (file listings,
search hits, or file contents) so the remote model can reason about
the codebase without direct filesystem access.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Iterable, List, Sequence

from gradio_client import Client

REPO_ROOT = Path(__file__).resolve().parents[1]
SPACE_URL = 'https://deepseek-ai-deepseek-coder-33b-instruct.hf.space/--replicas/52w5c/'
DEFAULT_SYSTEM_PROMPT = (
    'You are the HeySalad DeepSeek coding agent. Answer with clear reasoning, cite any '
    'files that appear in the context, and propose concrete implementation steps.'
)
DEFAULT_MAX_FILE_CHARS = 4000
IGNORE_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.mypy_cache'}


def _iter_repo_files() -> Iterable[Path]:
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = Path(root).relative_to(REPO_ROOT)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file_name in files:
            rel_parts = rel_root.parts + (file_name,)
            if any(part in IGNORE_DIRS for part in rel_parts):
                continue
            yield Path(root, file_name)


def _read_text_file(path: Path, max_chars: int = DEFAULT_MAX_FILE_CHARS) -> str:
    data = path.read_text(encoding='utf-8', errors='ignore')
    if len(data) > max_chars:
        return data[:max_chars] + f'\n\n… (truncated to {max_chars} characters)'
    return data


def read_repo_file(relative_path: str, max_chars: int = DEFAULT_MAX_FILE_CHARS) -> str:
    """Read a repo file relative to REPO_ROOT with bounds checking."""
    target = (REPO_ROOT / relative_path).resolve()
    if not target.exists():
        raise FileNotFoundError(f'{relative_path} not found.')
    if REPO_ROOT not in target.parents and target != REPO_ROOT:
        raise PermissionError('Only files inside the repository may be read.')
    return _read_text_file(target, max_chars=max_chars)


def list_repo_files(limit: int = 40) -> str:
    """Return up to `limit` relative file paths (skips obvious binaries)."""
    files: List[str] = []
    skip_suffixes = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.woff', '.ttf', '.otf', '.mp4'}
    for path in _iter_repo_files():
        if path.suffix.lower() in skip_suffixes:
            continue
        files.append(str(path.relative_to(REPO_ROOT)))
        if len(files) >= limit:
            break
    if not files:
        return 'No files discovered.'
    return '\n'.join(files)


def search_repo(keyword: str, max_hits: int = 20) -> str:
    """Search repo text files for `keyword` and return the first `max_hits` matches."""
    keyword_lower = keyword.lower()
    matches: List[str] = []
    for path in _iter_repo_files():
        if len(matches) >= max_hits:
            break
        try:
            content = path.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        if keyword_lower in content.lower():
            for line_no, line in enumerate(content.splitlines(), start=1):
                if keyword_lower in line.lower():
                    matches.append(f'{path.relative_to(REPO_ROOT)}:{line_no}: {line.strip()}')
                    break
    return 'Matches:\n' + '\n'.join(matches) if matches else f'No matches for "{keyword}".'


def load_history(path: Path | None) -> List[dict]:
    if not path:
        return []
    if not path.exists():
        raise FileNotFoundError(f'History file {path} not found.')
    with path.open('r', encoding='utf-8') as fp:
        data = json.load(fp)
    if not isinstance(data, list):
        raise ValueError('History file must contain a list of {role, content} objects.')
    return data


def save_history(path: Path, history: List[dict]) -> None:
    with path.open('w', encoding='utf-8') as fp:
        json.dump(history, fp, indent=2)


def load_task_input(value: str) -> str:
    if value.startswith('@'):
        task_file = (REPO_ROOT / value[1:]).resolve()
        if not task_file.exists():
            raise FileNotFoundError(f'Task file {task_file} not found.')
        if REPO_ROOT not in task_file.parents and task_file != REPO_ROOT:
            raise PermissionError('Task file must live inside the repository.')
        return task_file.read_text(encoding='utf-8')
    return value


def gather_context(include_files: Sequence[str], list_limit: int | None, searches: Sequence[str]) -> str:
    blocks: List[str] = []
    for rel_path in include_files:
        content = read_repo_file(rel_path)
        blocks.append(f'File `{rel_path}` contents:\n```\n{content}\n```')
    if list_limit:
        listing = list_repo_files(limit=list_limit)
        blocks.append(f'File inventory (first {list_limit} entries):\n{listing}')
    for keyword in searches:
        blocks.append(f'Search results for "{keyword}":\n{search_repo(keyword)}')
    return '\n\n'.join(blocks)


def history_to_text(history: List[dict]) -> str:
    lines: List[str] = []
    for message in history:
        role = message.get('role', 'user').capitalize()
        content = message.get('content', '')
        lines.append(f'{role}: {content}')
    return '\n\n'.join(lines)


def build_message(task: str, history: List[dict], context: str) -> str:
    parts: List[str] = []
    if history:
        parts.append(history_to_text(history))
    if context:
        parts.append(f'Context from repository:\n{context}')
    parts.append(f'User: {task}')
    return '\n\n'.join(parts)


def call_deepseek(
    message: str,
    system_prompt: str,
    max_new_tokens: int,
    top_p: float,
    top_k: int,
    repetition_penalty: float,
) -> str:
    client = Client(SPACE_URL)
    return client.predict(
        message,
        system_prompt,
        max_new_tokens,
        top_p,
        top_k,
        repetition_penalty,
        api_name='/chat',
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='DeepSeek Coder 33B agent for HeySalad MCP.')
    parser.add_argument('task', help='Task for the agent. Prefix with @file to load contents.')
    parser.add_argument('--system', default=DEFAULT_SYSTEM_PROMPT, help='Override the base system prompt.')
    parser.add_argument('--history', help='Path to a chat history JSON file (will be updated).')
    parser.add_argument('--include-file', action='append', default=[], help='Repo file to inline in the prompt.')
    parser.add_argument('--list-files', type=int, default=None, help='Include a file inventory of up to N entries.')
    parser.add_argument('--search', action='append', default=[], help='Keyword search to include as context (repeatable).')
    parser.add_argument('--max-new-tokens', type=int, default=1024, help='Max new tokens (1-2048).')
    parser.add_argument('--top-p', type=float, default=0.9, help='Top-p sampling value (0.05-1.0).')
    parser.add_argument('--top-k', type=int, default=50, help='Top-k sampling value (1-1000).')
    parser.add_argument('--repetition-penalty', type=float, default=1.05, help='Repetition penalty (1.0-2.0).')
    return parser.parse_args(argv or sys.argv[1:])


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    history_path = Path(args.history).expanduser() if args.history else None
    history = load_history(history_path)
    task_text = load_task_input(args.task)
    context = gather_context(args.include_file, args.list_files, args.search)
    message = build_message(task_text, history, context)

    response = call_deepseek(
        message=message,
        system_prompt=args.system,
        max_new_tokens=args.max_new_tokens,
        top_p=args.top_p,
        top_k=args.top_k,
        repetition_penalty=args.repetition_penalty,
    )

    print(response)

    if history_path:
        updated_history = history + [
            {'role': 'user', 'content': task_text},
            {'role': 'assistant', 'content': response},
        ]
        save_history(history_path, updated_history)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
