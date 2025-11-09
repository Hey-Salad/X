#!/usr/bin/env python3
"""
Autonomous GPT-OSS HeySalad developer.

This helper acts like a conversational engineer that can reason about
requests without extra scaffolding—perfect for quick “understand the ask”
moments or when you just want the smartest chatbot in the room.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Sequence

from openai import OpenAI

DEFAULT_MODEL = "openai/gpt-oss-120b:groq"
DEFAULT_BASE_URL = "https://router.huggingface.co/v1"
DEFAULT_SYSTEM = (
    "You are HeySaladX Autonomous Developer—an expert full-stack engineer who fully "
    "understands user intent, asks clarifying questions when needed, and delivers "
    "actionable plans or code. Be proactive, reference HeySalad MCP context, and "
    "explain next steps."
)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HeySalad autonomous GPT-OSS developer.")
    parser.add_argument("prompt", help="User instruction or conversation prompt.")
    parser.add_argument("--system", default=DEFAULT_SYSTEM, help="Override system instructions.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="GPT-OSS model identifier.")
    parser.add_argument("--max-tokens", type=int, default=900, help="Maximum response tokens.")
    parser.add_argument("--temperature", type=float, default=0.25, help="Sampling temperature.")
    parser.add_argument("--history", help="Optional JSON file with prior messages.")
    parser.add_argument("--stream", action="store_true", help="Stream the response tokens.")
    return parser.parse_args(argv or sys.argv[1:])


def ensure_hf_token() -> str:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN environment variable is required for the autonomous developer.")
    return token


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise SystemExit("history file must be a JSON list of {role, content} dictionaries.")
    return data


def build_messages(system_prompt: str, history: List[dict], prompt: str) -> List[dict]:
    messages: List[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    for entry in history:
        if not isinstance(entry, dict) or "role" not in entry or "content" not in entry:
            raise SystemExit("history entries must contain 'role' and 'content'.")
        messages.append({"role": entry["role"], "content": entry["content"]})
    messages.append({"role": "user", "content": prompt})
    return messages


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    ensure_hf_token()
    history = load_history(args.history)
    messages = build_messages(args.system, history, args.prompt)

    client = OpenAI(api_key=os.environ["HF_TOKEN"], base_url=DEFAULT_BASE_URL)
    payload = dict(
        model=args.model,
        messages=messages,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
    )

    if args.stream:
        stream = client.chat.completions.create(stream=True, **payload)
        try:
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    print(delta, end="", flush=True)
        finally:
            print()
    else:
        completion = client.chat.completions.create(**payload)
        print((completion.choices[0].message.content or "").strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
