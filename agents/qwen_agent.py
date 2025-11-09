#!/usr/bin/env python3
"""
LangChain agent backed by Hugging Face's Qwen 2.5 Coder Artifacts model for
full-stack engineering assistance.
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
from langchain_community.llms import HuggingFaceHub
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

REPO_ROOT = Path(__file__).resolve().parents[1]
IGNORE_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea'}


def _iter_repo_files() -> Iterable[Path]:
    for path in REPO_ROOT.rglob('*'):
        try:
            rel = path.relative_to(REPO_ROOT)
        except ValueError:
            continue
        if any(part in IGNORE_DIRS for part in rel.parts):
            if path.is_dir():
                continue
        if path.is_file():
            yield path


def _read_text_file(path: Path, max_chars: int = 4000) -> str:
    text = path.read_text(encoding='utf-8', errors='ignore')
    if len(text) > max_chars:
        return text[:max_chars] + f'\n\n… (truncated to {max_chars} chars)'
    return text


def ensure_token() -> str:
    token = os.environ.get('HF_TOKEN') or os.environ.get('HUGGINGFACEHUB_API_TOKEN')
    if not token:
        raise SystemExit('Requires HF_TOKEN or HUGGINGFACEHUB_API_TOKEN environment variable.')
    return token


@tool
def read_repo_file(relative_path: str, max_chars: int = 4000) -> str:
    """Read a repo file trimmed to `max_chars`."""
    target = (REPO_ROOT / relative_path).resolve()
    if not target.exists():
        raise FileNotFoundError(f'{relative_path} not found.')
    if REPO_ROOT not in target.parents and target != REPO_ROOT:
        raise PermissionError('Access limited to repo files.')
    return _read_text_file(target, max_chars=max_chars)


@tool
def search_repo(keyword: str, max_hits: int = 20) -> str:
    """Search repository files for `keyword` and return matching lines."""
    keyword_lower = keyword.lower()
    matches: List[str] = []
    for path in _iter_repo_files():
        if len(matches) >= max_hits:
            break
        text = path.read_text(encoding='utf-8', errors='ignore')
        if keyword_lower in text.lower():
            for i, line in enumerate(text.splitlines(), 1):
                if keyword_lower in line.lower():
                    matches.append(f'{path.relative_to(REPO_ROOT)}:{i}: {line.strip()}')
                    break
    return 'Matches:\n' + '\n'.join(matches) if matches else f'No matches for {keyword}'


@tool
def list_repo_files(limit: int = 50) -> str:
    """List up to `limit` repository files (text only)."""
    files: List[str] = []
    for path in _iter_repo_files():
        if path.suffix.lower() in {'.png', '.svg', '.jpg', '.jpeg', '.gif', '.heic'}:
            continue
        files.append(str(path.relative_to(REPO_ROOT)))
        if len(files) >= limit:
            break
    return '\n'.join(files)


def build_agent(verbose: bool = False) -> AgentExecutor:
    token = ensure_token()
    llm = HuggingFaceHub(
        huggingfacehub_api_token=token,
        repo_id='Qwen/Qwen2.5-Coder-Artifacts',
        model_kwargs={'temperature': 0.2, 'max_tokens': 700}
    )
    prompt = ChatPromptTemplate.from_messages(
        [
            ('system', 'You are HeySalad\'s senior agent with deep infra expertise.'),
            MessagesPlaceholder('chat_history'),
            ('user', '{input}'),
            MessagesPlaceholder('agent_scratchpad')
        ]
    )
    tools = [read_repo_file, search_repo, list_repo_files]
    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=verbose)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Qwen 2.5 LangChain agent for HeySalad.')
    parser.add_argument('task', help='Question/task for the agent.')
    parser.add_argument('--stream', action='store_true', help='Stream response tokens.')
    parser.add_argument('--verbose', action='store_true', help='Enable LangChain tracing.')
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    executor = build_agent(verbose=args.verbose)
    response = executor.invoke({'input': args.task})
    if args.stream:
        # agent already streams via langchain; this is a stub for future streaming
        pass
    print(response.get('output', ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
