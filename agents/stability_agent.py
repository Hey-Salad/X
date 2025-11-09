#!/usr/bin/env python3
"""
Simple Stability AI image generation helper tailored for HeySalad.

Usage:

    export STABILITY_API_KEY=sk-... (production key)
    python stability_agent.py "Generate fresh HeySalad kiosk UI mockups in vector style."

Use --steps/--scale to tweak quality and size.
"""

from __future__ import annotations

import argparse
import os
import sys
from io import BytesIO
from pathlib import Path

from stability_sdk import client
DEFAULT_ENGINE = "stable-diffusion-xl-1024-v1-0"
OUTPUT_DIR = Path(__file__).resolve().parent / "stability_outputs"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="HeySalad Stability AI image generator.")
    parser.add_argument("prompt", help="Text prompt describing the image.")
    parser.add_argument("--negative", default="low quality, blurry", help="Negative prompt.")
    parser.add_argument("--steps", type=int, default=20, help="Sampling steps.")
    parser.add_argument("--scale", type=float, default=9.0, help="Guidance scale.")
    parser.add_argument("--seed", type=int, help="Optional deterministic seed.")
    parser.add_argument("--engine", default=DEFAULT_ENGINE, help="Stability engine/model name.")
    parser.add_argument("--out", default="", help="Optional output filename (PNG).")
    return parser.parse_args(argv)


def ensure_api_key():
    key = os.environ.get("STABILITY_API_KEY")
    if not key:
        raise SystemExit("Set STABILITY_API_KEY before running the stability agent.")
    return key


def save_image(data: bytes, out_name: str) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUTPUT_DIR / out_name
    with target.open("wb") as fp:
        fp.write(data)
    return target


def generate_image(args):
    key = ensure_api_key()
    stability = client.StabilityInference(
        key=key,
        verbose=False,
        engine=args.engine
    )

    response = stability.generate(
        prompt=args.prompt,
        width=1024,
        height=1024,
        steps=args.steps,
        cfg_scale=args.scale,
        seed=args.seed
    )

    for resp in response:
        for artifact in getattr(resp, "artifacts", []):
            if artifact.binary:
                out_name = args.out or f"stability-{int(getattr(artifact, 'seed', 0) or 0)}.png"
                image_path = save_image(artifact.binary, out_name)
                print(f"Saved {image_path}")
                return
    raise SystemExit("No successful image generated.")


def main(argv=None):
    args = parse_args(argv)
    generate_image(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
