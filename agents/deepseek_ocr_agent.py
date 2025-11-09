#!/usr/bin/env python3
"""
DeepSeek OCR assistant via Hugging Face router.

Example usage:

    export HF_TOKEN=hf_token
    python deepseek_ocr_agent.py "Describe the building" --image https://...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Sequence

from openai import OpenAI

DEFAULT_MODEL = "deepseek-ai/DeepSeek-OCR:novita"
DEFAULT_BASE_URL = "https://router.huggingface.co/v1"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DeepSeek OCR agent (HF router).")
    parser.add_argument("prompt", help="Text prompt describing the image.")
    parser.add_argument("--image", help="URL to the image to inspect.")
    parser.add_argument("--history", help="JSON file with prior {role, content}.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="DeepSeek model path.")
    parser.add_argument("--system", default="You are a DeepSeek OCR assistant.", help="Override system message.")
    parser.add_argument("--stream", action="store_true", help="Stream tokens.")
    return parser.parse_args(argv)


def ensure_token() -> str:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is required to call the Hugging Face router.")
    return token


def load_history(path: str | None):
    if not path:
        return []
    with open(path, "r", encoding="utf-8") as fp:
        data = json.load(fp)
    if not isinstance(data, list):
        raise SystemExit("History file must be a JSON array of {role, content}.")
    return data


def build_message(prompt: str, image_url: str | None) -> dict:
    content = [{"type": "text", "text": prompt}]
    if image_url:
        content.append({"type": "image_url", "image_url": {"url": image_url}})
    return {"role": "user", "content": content}


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    ensure_token()
    history = load_history(args.history)

    client = OpenAI(base_url=DEFAULT_BASE_URL, api_key=os.environ["HF_TOKEN"])
    payload = {
        "model": args.model,
        "messages": [{"role": "system", "content": args.system}, *history, build_message(args.prompt, args.image)],
        "stream": args.stream,
    }

    if args.stream:
        stream = client.chat.completions.create(**payload)
        try:
            for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    print(delta, end="", flush=True)
        finally:
            print()
    else:
        completion = client.chat.completions.create(**payload)
        print(completion.choices[0].message.content or "")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
