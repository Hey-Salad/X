#!/usr/bin/env python3
"""
Senior engineering agent powered by openai/gpt-oss-120b via Hugging Face router.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Sequence

from openai import OpenAI

DEFAULT_MODEL = 'openai/gpt-oss-120b:groq'
DEFAULT_BASE_URL = 'https://router.huggingface.co/v1'
DEFAULT_SYSTEM = (
    'You are HeySalad’s senior engineering partner. Provide full-stack guidance, '
    'concrete code suggestions, and highlight risks. Be concise but specific.'
)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='HeySalad senior engineering agent (GPT-OSS-120B).')
    parser.add_argument('prompt', help='Question or task for the agent (string or @file.json).')
    parser.add_argument('--system', default=DEFAULT_SYSTEM, help='Override system prompt.')
    parser.add_argument('--model', default=DEFAULT_MODEL, help='Router model name.')
    parser.add_argument('--history', help='Optional JSON file with prior chat history.')
    parser.add_argument('--max-tokens', type=int, default=800, help='Response token cap.')
    parser.add_argument('--temperature', type=float, default=0.2, help='Sampling temperature.')
    parser.add_argument('--stream', action='store_true', help='Stream tokens instead of waiting.')
    return parser.parse_args(argv)


def ensure_hf_token() -> str:
    token = os.environ.get('HF_TOKEN')
    if not token:
        raise SystemExit('HF_TOKEN environment variable is required.')
    return token


def load_history(path: str | None):
    if not path:
        return []
    with open(path, 'r', encoding='utf-8') as fp:
        data = json.load(fp)
    if not isinstance(data, list):
        raise SystemExit('history file must be a list of {role, content} objects.')
    return data


def load_prompt(prompt_arg: str) -> str:
    if prompt_arg.startswith('@'):
        file_path = prompt_arg[1:]
        with open(file_path, 'r', encoding='utf-8') as fp:
            return fp.read()
    return prompt_arg


def build_messages(system_prompt: str, user_prompt: str, history):
    messages = []
    if system_prompt:
        messages.append({'role': 'system', 'content': system_prompt})
    messages.extend(history)
    messages.append({'role': 'user', 'content': user_prompt})
    return messages


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ensure_hf_token()
    history = load_history(args.history)
    prompt = load_prompt(args.prompt)
    messages = build_messages(args.system, prompt, history)

    client = OpenAI(base_url=DEFAULT_BASE_URL, api_key=os.environ['HF_TOKEN'])
    payload = dict(
        model=args.model,
        messages=messages,
        max_tokens=args.max_tokens,
        temperature=args.temperature
    )

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
        print(completion.choices[0].message.content or '')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
