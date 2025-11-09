#!/usr/bin/env python3
"""
Safety agent that calls the GPT OSS Safeguard model hosted on the Hugging Face router.

Usage example:
    export HF_TOKEN=hf_xxx
    python safety_agent.py "Screen this user prompt for ToS violations." --stream
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Sequence

from openai import OpenAI

DEFAULT_MODEL = 'openai/gpt-oss-safeguard-20b:groq'
DEFAULT_BASE_URL = 'https://router.huggingface.co/v1'
DEFAULT_SYSTEM = (
  'You are the HeySalad safety agent. Screen every request for policy violations, '
  'flag unsafe content, and suggest compliant alternatives when possible.'
)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='HeySalad GPT safeguard safety agent.')
    parser.add_argument('prompt', help='User prompt to screen.')
    parser.add_argument(
        '--model',
        default=DEFAULT_MODEL,
        help=f'Model identifier (default: {DEFAULT_MODEL}).'
    )
    parser.add_argument(
        '--system',
        default=DEFAULT_SYSTEM,
        help='Override the default system prompt.'
    )
    parser.add_argument(
        '--history',
        help='Optional path to a JSON file containing prior chat history (list of {role, content}).'
    )
    parser.add_argument(
        '--stream',
        action='store_true',
        help='Stream the response tokens instead of waiting for completion.'
    )
    parser.add_argument(
        '--max-tokens',
        type=int,
        default=512,
        help='Maximum tokens to sample (default: 512).'
    )
    return parser.parse_args(argv)


def ensure_hf_token() -> str:
    token = os.environ.get('HF_TOKEN')
    if not token:
        raise SystemExit('HF_TOKEN environment variable is required to contact the Hugging Face router.')
    return token


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    history_path = Path(path)
    if not history_path.exists():
        raise SystemExit(f'History file {path} not found.')
    data = json.loads(history_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        raise SystemExit('History file must be a JSON list of message dicts.')
    return data


def build_messages(system_prompt: str, prompt: str, history: List[dict]) -> List[dict]:
    messages: List[dict] = []
    if system_prompt:
        messages.append({'role': 'system', 'content': system_prompt})
    for entry in history:
        if not isinstance(entry, dict) or 'role' not in entry or 'content' not in entry:
            raise SystemExit('History entries must be {"role": "...", "content": "..."} objects.')
        messages.append({'role': entry['role'], 'content': entry['content']})
    messages.append({'role': 'user', 'content': prompt})
    return messages


def run_safety_agent(args: argparse.Namespace) -> None:
    token = ensure_hf_token()
    history = load_history(args.history)
    messages = build_messages(args.system, args.prompt, history)

    client = OpenAI(base_url=DEFAULT_BASE_URL, api_key=token)
    payload = {
        'model': args.model,
        'messages': messages,
        'max_tokens': args.max_tokens
    }

    if args.stream:
        stream = client.chat.completions.create(stream=True, **payload)
        try:
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    print(delta, end='', flush=True)
        finally:
            print()
    else:
        completion = client.chat.completions.create(**payload)
        message = completion.choices[0].message
        print(message.content or '')


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    run_safety_agent(args)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
