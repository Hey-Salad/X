#!/usr/bin/env python3
"""
HeySalad hardware + firmware engineering agent.

Backed by GPT-OSS-120B (via Hugging Face router) with LangChain tools that can
inspect both the HeySalad MCP repository and the KellAI firmware sample.

Example:

    export HF_TOKEN=hf_your_token
    python hardware_agent.py "Design an OTA flow for KellAI while updating MCP APIs."

Optional flags let you capture a quick Raspberry Pi probe for extra context or
point at a custom KellAI checkout via KELLAI_REPO.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain.tools import tool
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KELLAI_PATH = Path(os.environ.get("KELLAI_REPO", Path.home() / "KellAI"))
IGNORE_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".idea", ".mypy_cache", "build"}
DEFAULT_MAX_CHARS = 5000
MAX_FILE_CHARS = DEFAULT_MAX_CHARS


def ensure_hf_token() -> str:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN environment variable is required for the hardware agent.")
    return token


@dataclass(frozen=True)
class RepoConfig:
    key: str
    path: Path
    description: str

    @property
    def exists(self) -> bool:
        return self.path.exists()


REPOS: Dict[str, RepoConfig] = {
    "mcp": RepoConfig(key="mcp", path=REPO_ROOT, description="HeySalad MCP server"),
    "kellai": RepoConfig(
        key="kellai",
        path=DEFAULT_KELLAI_PATH,
        description="KellAI firmware / PlatformIO workspace"
    )
}


def _get_repo(repo_key: str) -> RepoConfig:
    normalized = repo_key.lower()
    if normalized not in REPOS:
        raise ValueError(f"Unknown repo '{repo_key}'. Valid options: {', '.join(REPOS)}.")
    repo = REPOS[normalized]
    if not repo.exists:
        raise FileNotFoundError(
            f"Repo '{repo.key}' expected at {repo.path}, but it was not found. "
            f"Clone it or set KELLAI_REPO when targeting KellAI."
        )
    return repo


def _iter_files(repo: RepoConfig) -> Iterable[Path]:
    for root, dirs, files in os.walk(repo.path):
        rel_root = Path(root).relative_to(repo.path)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file_name in files:
            rel_parts = rel_root.parts + (file_name,)
            if any(part in IGNORE_DIRS for part in rel_parts):
                continue
            yield Path(root, file_name)


def _read_text_file(path: Path, max_chars: int | None = None) -> str:
    limit = max_chars or MAX_FILE_CHARS
    data = path.read_text(encoding="utf-8", errors="ignore")
    if len(data) > limit:
        return data[:limit] + f"\n\n… (truncated to {limit} chars)"
    return data


@tool
def read_hw_repo_file(repo: str, relative_path: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """Read a file from the specified repo ('mcp' or 'kellai')."""
    repo_cfg = _get_repo(repo)
    target = (repo_cfg.path / relative_path).resolve()
    if not target.exists():
        raise FileNotFoundError(f"{relative_path} not found in {repo_cfg.key}.")
    if repo_cfg.path not in target.parents and target != repo_cfg.path:
        raise PermissionError("Access limited to files inside the target repository.")
    return _read_text_file(target, max_chars=max_chars)


@tool
def search_hw_repo(repo: str, keyword: str, max_hits: int = 20) -> str:
    """Search for a keyword in the target repo and return up to `max_hits` matches."""
    repo_cfg = _get_repo(repo)
    keyword_lower = keyword.lower()
    matches: List[str] = []
    for path in _iter_files(repo_cfg):
        if len(matches) >= max_hits:
            break
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if keyword_lower in content.lower():
            for line_no, line in enumerate(content.splitlines(), start=1):
                if keyword_lower in line.lower():
                    matches.append(f"{repo_cfg.key}:{path.relative_to(repo_cfg.path)}:{line_no}: {line.strip()}")
                    break
    return "Matches:\n" + "\n".join(matches) if matches else f"No matches for '{keyword}' in {repo_cfg.key}."


@tool
def list_hw_repo_files(repo: str = "kellai", limit: int = 60) -> str:
    """List up to `limit` files for navigation (defaults to the KellAI repo)."""
    repo_cfg = _get_repo(repo)
    files: List[str] = []
    for path in _iter_files(repo_cfg):
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg", ".gif", ".bmp", ".mp4"}:
            continue
        files.append(f"{repo_cfg.key}:{path.relative_to(repo_cfg.path)}")
        if len(files) >= limit:
            break
    return "\n".join(files) if files else f"No files discovered for repo {repo_cfg.key}."


@tool
def load_platformio_config() -> str:
    """Return the PlatformIO configuration from the KellAI repo."""
    repo_cfg = _get_repo("kellai")
    ini_path = repo_cfg.path / "platformio.ini"
    if not ini_path.exists():
        return f"No platformio.ini found at {ini_path}."
    return ini_path.read_text(encoding="utf-8", errors="ignore")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HeySalad hardware / firmware LangChain agent.")
    parser.add_argument("task", help="Instruction for the agent.")
    parser.add_argument("--history", help="Optional chat history JSON file.", default=None)
    parser.add_argument("--verbose", action="store_true", help="Enable LangChain verbose traces.")
    parser.add_argument(
        "--probe-rpi",
        metavar="HOST",
        help="SSH target (e.g., admin@raspbx) to probe with --probe-command before asking the LLM."
    )
    parser.add_argument(
        "--probe-command",
        default="uname -a",
        help="Command to execute on the Raspberry Pi host when --probe-rpi is set."
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help=f"Max characters per file read (default {DEFAULT_MAX_CHARS})."
    )
    return parser.parse_args(argv or sys.argv[1:])


def load_history(path: str | None) -> List[dict]:
    if not path:
        return []
    history_path = Path(path)
    if not history_path.exists():
        raise SystemExit(f"History file {path} not found.")
    data = json.loads(history_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("History file must contain a JSON list of LangChain message dicts.")
    return data


def capture_rpi_probe(host: str | None, command: str) -> str | None:
    if not host:
        return None
    try:
        completed = subprocess.run(
            ["ssh", host, command],
            check=True,
            capture_output=True,
            text=True,
            timeout=15
        )
        output = completed.stdout.strip() or completed.stderr.strip()
        return f"SSH {host} ➜ {command}\n{output}".strip()
    except FileNotFoundError:
        return "SSH binary not available on this host."
    except subprocess.TimeoutExpired:
        return f"SSH probe to {host} timed out."
    except subprocess.CalledProcessError as exc:
        details = exc.stdout or exc.stderr or exc.args
        return f"SSH probe failed ({host} ➜ {command}): {details}"


def build_agent(max_chars: int, verbose: bool = False) -> AgentExecutor:
    global MAX_FILE_CHARS
    MAX_FILE_CHARS = max_chars
    ensure_hf_token()
    llm = ChatOpenAI(
        api_key=os.environ["HF_TOKEN"],
        base_url=os.environ.get("HF_BASE_URL", "https://router.huggingface.co/v1"),
        model=os.environ.get("HARDWARE_AGENT_MODEL", "openai/gpt-oss-120b:groq"),
        temperature=float(os.environ.get("HARDWARE_AGENT_TEMPERATURE", "0.15")),
        max_retries=2
    )

    tools = [read_hw_repo_file, search_hw_repo, list_hw_repo_files, load_platformio_config]

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                (
                    "You are HeySaladX Hardware + Firmware architect. You understand Raspberry Pi "
                    "bring-up, PlatformIO, Arduino, C/C++, Python, HTML/CSS/JS, and hardware APIs. "
                    f"Primary repositories:\n- MCP: {REPO_ROOT}\n- KellAI: {DEFAULT_KELLAI_PATH} "
                    f"(present: {DEFAULT_KELLAI_PATH.exists()}). "
                    "Use the available tools to inspect source files before suggesting changes."
                ),
            ),
            MessagesPlaceholder("chat_history"),
            ("user", "{input}\n\nAdditional context:\n{extra_context}"),
            MessagesPlaceholder("agent_scratchpad"),
        ]
    )

    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(agent=agent, tools=tools, verbose=verbose, handle_parsing_errors=True)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    history = load_history(args.history)
    executor = build_agent(max_chars=args.max_chars, verbose=args.verbose)

    context_lines: List[str] = []
    if args.probe_rpi:
        probe = capture_rpi_probe(args.probe_rpi, args.probe_command)
        if probe:
            context_lines.append(probe)

    context_text = "\n".join(context_lines) if context_lines else "n/a"
    input_payload = {
        "input": args.task,
        "chat_history": history,
        "extra_context": context_text,
    }
    result = executor.invoke(input_payload)
    print(result.get("output", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
