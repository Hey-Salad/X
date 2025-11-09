#!/usr/bin/env python3
"""
Prompt management LangChain agent for HeySalad.

This helper curates user prompts, captures responses, and can summarize intent
before handing work to other agents. Ideal for crafting high-quality MCP tasks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Sequence

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import tool
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROMPT_LOG = REPO_ROOT / "prompt_agent.log.json"


def ensure_hf_token() -> str:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN environment variable is required for prompt_agent.")
    return token


@tool
def store_prompt(payload: str, log_path: str | None = None) -> str:
    """Persist a prompt/output pair (expects JSON: {"prompt": "...", "response": "..."})."""
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON payload: {exc}") from exc
    if not isinstance(data, dict) or "prompt" not in data or "response" not in data:
        raise ValueError('Payload must contain "prompt" and "response" fields.')

    destination = Path(log_path or DEFAULT_PROMPT_LOG)
    destination.parent.mkdir(parents=True, exist_ok=True)
    existing: List[dict] = []
    if destination.exists():
        try:
            existing = json.loads(destination.read_text(encoding="utf-8"))
        except Exception:
            existing = []
    existing.append(
        {
            "prompt": data["prompt"],
            "response": data["response"],
            "tags": data.get("tags", []),
        }
    )
    destination.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return f"Stored prompt log entry ({destination})."


@tool
def list_prompt_history(log_path: str | None = None, limit: int = 5) -> str:
    """Show the most recent prompt/response pairs."""
    destination = Path(log_path or DEFAULT_PROMPT_LOG)
    if not destination.exists():
        return "No prompt history recorded yet."
    try:
        entries = json.loads(destination.read_text(encoding="utf-8"))
    except Exception:
        return "Failed to parse prompt history."
    if not isinstance(entries, list):
        return "Prompt history corrupted."
    subset = entries[-limit:]
    lines = []
    for idx, entry in enumerate(subset, start=1):
        prompt = entry.get("prompt", "").strip().replace("\n", " ")[:120]
        response = entry.get("response", "").strip().replace("\n", " ")[:160]
        lines.append(f"{idx}. Prompt: {prompt}\n   Response: {response}")
    return "\n".join(lines) if lines else "No prompts logged."


def build_agent(verbose: bool = False) -> AgentExecutor:
    ensure_hf_token()
    llm = ChatOpenAI(
        api_key=os.environ["HF_TOKEN"],
        base_url=os.environ.get("HF_BASE_URL", "https://router.huggingface.co/v1"),
        model=os.environ.get("PROMPT_AGENT_MODEL", "openai/gpt-oss-120b:groq"),
        temperature=float(os.environ.get("PROMPT_AGENT_TEMPERATURE", "0.2")),
        max_retries=2,
    )

    tools = [store_prompt, list_prompt_history]
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are the HeySalad prompt curator. Capture intent, refine wording, "
                "and suggest how downstream agents should tackle the task. Use the tools "
                "to store or retrieve prompt history when helpful.",
            ),
            MessagesPlaceholder("chat_history"),
            ("user", "{input}"),
            MessagesPlaceholder("agent_scratchpad"),
        ]
    )
    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=verbose, handle_parsing_errors=True)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HeySalad prompt management agent.")
    parser.add_argument("task", help="Instruction or prompt to curate.")
    parser.add_argument("--history", help="Optional JSON chat history file.")
    parser.add_argument("--verbose", action="store_true", help="Enable LangChain debug output.")
    return parser.parse_args(argv or sys.argv[1:])


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    history_file = Path(path)
    if not history_file.exists():
        raise FileNotFoundError(f"History file {path} not found.")
    data = json.loads(history_file.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("History file must be a JSON list of messages.")
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
