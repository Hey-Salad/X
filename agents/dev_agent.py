#!/usr/bin/env python3
"""
DeepSeek + LangChain developer agent.

This script exposes a compact command-line helper that can answer developer
questions about the HeySalad MCP repository by combining a DeepSeek model with
LangChain's tool-aware agent framework. It is intentionally lightweight so it
can run on a workstation or Raspberry Pi with minimal dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import tool
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IGNORE_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.mypy_cache'}
DEFAULT_MAX_FILE_CHARS = 4000


def _ensure_api_key() -> str:
    api_key = os.environ.get('DEEPSEEK_API_KEY')
    if not api_key:
        raise SystemExit(
            'Missing DEEPSEEK_API_KEY environment variable. '
            'Create an API key at https://platform.deepseek.com/ and export it before running.'
        )
    return api_key


def _iter_repo_files() -> Iterable[Path]:
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = Path(root).relative_to(REPO_ROOT)
        dirs[:] = [d for d in dirs if d not in DEFAULT_IGNORE_DIRS]
        for file_name in files:
            candidate = Path(root, file_name)
            rel_parts = rel_root.parts + (file_name,)
            if any(part in DEFAULT_IGNORE_DIRS for part in rel_parts):
                continue
            yield candidate


def _read_text_file(path: Path, max_chars: int = DEFAULT_MAX_FILE_CHARS) -> str:
    data = path.read_text(encoding='utf-8', errors='ignore')
    if len(data) > max_chars:
        return data[:max_chars] + f'\n\n… (truncated to {max_chars} characters)'
    return data


@tool
def read_repo_file(relative_path: str, max_chars: int = DEFAULT_MAX_FILE_CHARS) -> str:
    """Read a text file relative to the repo root."""
    target = (REPO_ROOT / relative_path).resolve()
    if not target.exists():
        raise FileNotFoundError(f'Path {relative_path} does not exist.')
    if REPO_ROOT not in target.parents and target != REPO_ROOT:
        raise PermissionError('Only files inside the repository can be read.')
    return _read_text_file(target, max_chars=max_chars)


@tool
def search_repo(keyword: str, max_hits: int = 20) -> str:
    """Search for a keyword in readable files."""
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
            rel_path = path.relative_to(REPO_ROOT)
            snippet = content.splitlines()
            for line_no, line in enumerate(snippet, start=1):
                if keyword_lower in line.lower():
                    matches.append(f'{rel_path}:{line_no}: {line.strip()}')
                    break
    if not matches:
        return f'No matches for "{keyword}".'
    return 'Matches:\n' + '\n'.join(matches)


@tool
def list_repo_files(limit: int = 50) -> str:
    """List up to `limit` source-ish files to help the agent navigate the repo."""
    files: List[str] = []
    skip_suffixes = {'.log', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.woff', '.woff2', '.ttf'}
    for path in _iter_repo_files():
        if path.suffix.lower() in skip_suffixes:
            continue
        files.append(str(path.relative_to(REPO_ROOT)))
        if len(files) >= limit:
            break
    return '\n'.join(files)


@dataclass
class AgentConfig:
    model: str = os.environ.get('DEEPSEEK_MODEL', 'deepseek-reasoner')
    base_url: str = os.environ.get('DEEPSEEK_API_BASE', 'https://api.deepseek.com')
    temperature: float = float(os.environ.get('DEEPSEEK_TEMPERATURE', '0.2'))


def build_agent(verbose: bool = False) -> AgentExecutor:
    _ensure_api_key()
    cfg = AgentConfig()
    llm = ChatOpenAI(
        api_key=os.environ['DEEPSEEK_API_KEY'],
        model=cfg.model,
        base_url=cfg.base_url,
        temperature=cfg.temperature,
        max_retries=2,
    )

    tools = [read_repo_file, search_repo, list_repo_files]

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                'system',
                (
                    'You are the HeySalad smart developer agent. '
                    'Use the provided tools to inspect the repository at {repo_root} '
                    'before proposing changes. '
                    'Explain your reasoning and cite files you read.'
                ),
            ),
            MessagesPlaceholder('chat_history'),
            ('user', '{input}'),
            MessagesPlaceholder('agent_scratchpad'),
        ]
    ).partial(repo_root=str(REPO_ROOT))

    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=verbose, handle_parsing_errors=True)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='DeepSeek + LangChain developer agent for HeySalad MCP.')
    parser.add_argument('task', help='Instruction for the agent to work on.')
    parser.add_argument('--history', help='Optional path to a JSON chat history file.', default=None)
    parser.add_argument('--verbose', action='store_true', help='Enable LangChain debug output.')
    return parser.parse_args(argv)


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    history_file = Path(path)
    if not history_file.exists():
        raise FileNotFoundError(f'History file {path} not found.')
    with history_file.open('r', encoding='utf-8') as fp:
        data = json.load(fp)
    if not isinstance(data, list):
        raise ValueError('History file must be a list of message dictionaries.')
    return data


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    executor = build_agent(verbose=args.verbose)
    chat_history = load_history(args.history)
    result = executor.invoke({'input': args.task, 'chat_history': chat_history})
    print(result.get('output', ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
