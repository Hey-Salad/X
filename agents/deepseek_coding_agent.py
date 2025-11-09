#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
  sys.path.append(str(REPO_ROOT))

from agents.lib.deepseek_context import gather_context  # noqa: E402

DEFAULT_SYSTEM_PROMPT = (
    'You are the HeySalad DeepSeek coding agent. Answer with clear reasoning, cite any '
    'files that appear in the context, and propose concrete implementation steps.'
)
DEFAULT_ENDPOINT = os.environ.get('DEEPSEEK_AGENT_URL', 'http://127.0.0.1:5055/chat')


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


def call_local_agent(endpoint: str, payload: dict, timeout: int = 300) -> dict:
    data = json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        endpoint,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode('utf-8', errors='ignore')
        raise RuntimeError(f'Agent HTTP {exc.code}: {error_body}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Failed to reach agent at {endpoint}: {exc}') from exc


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='DeepSeek Coder agent for HeySalad MCP.')
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
    parser.add_argument('--endpoint', default=DEFAULT_ENDPOINT, help='Deepseek agent HTTP endpoint.')
    return parser.parse_args(argv or sys.argv[1:])


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    history_path = Path(args.history).expanduser() if args.history else None
    history = load_history(history_path)
    task_text = load_task_input(args.task)

    payload = {
        'prompt': task_text,
        'systemPrompt': args.system,
        'history': history,
        'includeFiles': args.include_file,
        'searches': args.search,
        'maxNewTokens': args.max_new_tokens,
        'topP': args.top_p,
        'topK': args.top_k,
        'repetitionPenalty': args.repetition_penalty
    }
    if args.list_files is not None:
        payload['listFiles'] = args.list_files
    context_block = gather_context(args.include_file, args.list_files, args.search)
    if context_block:
        payload['prefetchedContext'] = context_block

    response_data = call_local_agent(args.endpoint, payload)
    response = response_data.get('response', '')

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
