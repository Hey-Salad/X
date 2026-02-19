from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, List, Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MAX_FILE_CHARS = 4000
IGNORE_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.mypy_cache'}
SKIP_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.woff', '.ttf', '.otf', '.mp4'}


def _iter_repo_files() -> Iterable[Path]:
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = Path(root).relative_to(REPO_ROOT)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file_name in files:
            if any(part in IGNORE_DIRS for part in rel_root.parts):
                continue
            full_path = Path(root) / file_name
            if full_path.suffix.lower() in SKIP_SUFFIXES:
                continue
            yield full_path


def read_repo_file(relative_path: str, max_chars: int = DEFAULT_MAX_FILE_CHARS) -> str:
    target = (REPO_ROOT / relative_path).resolve()
    if not target.exists():
        raise FileNotFoundError(f'{relative_path} not found.')
    if REPO_ROOT not in target.parents and target != REPO_ROOT:
        raise PermissionError('Only files inside the repository may be read.')
    data = target.read_text(encoding='utf-8', errors='ignore')
    if len(data) > max_chars:
        return data[:max_chars] + f'\n\n… (truncated to {max_chars} characters)'
    return data


def list_repo_files(limit: int = 40) -> str:
    files: List[str] = []
    for path in _iter_repo_files():
        files.append(str(path.relative_to(REPO_ROOT)))
        if len(files) >= limit:
            break
    if not files:
        return 'No files discovered.'
    return '\n'.join(files)


def search_repo(keyword: str, max_hits: int = 20) -> str:
    keyword_lower = keyword.lower()
    matches: List[str] = []
    for path in _iter_repo_files():
        if len(matches) >= max_hits:
            break
        try:
            content = path.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        lower = content.lower()
        index = lower.find(keyword_lower)
        if index == -1:
            continue
        line_no = lower[:index].count('\n') + 1
        line = content.splitlines()[line_no - 1].strip() if content else ''
        rel_path = path.relative_to(REPO_ROOT)
        matches.append(f'{rel_path}:{line_no}: {line}')
    return 'Matches:\n' + '\n'.join(matches) if matches else f'No matches for "{keyword}".'


def gather_context(include_files: Sequence[str], list_limit: int | None, searches: Sequence[str]) -> str:
    blocks: List[str] = []
    for rel_path in include_files:
        try:
            content = read_repo_file(rel_path)
            blocks.append(f'File `{rel_path}` contents:\n```\n{content}\n```')
        except Exception as exc:
            blocks.append(f'Failed to read `{rel_path}`: {exc}')
    if list_limit:
        try:
            listing = list_repo_files(limit=list_limit)
            blocks.append(f'File inventory (first {list_limit} entries):\n{listing}')
        except Exception as exc:
            blocks.append(f'Failed to list files: {exc}')
    for keyword in searches:
        try:
            matches = search_repo(keyword)
            blocks.append(f'Search results for "{keyword}":\n{matches}')
        except Exception as exc:
            blocks.append(f'Search for "{keyword}" failed: {exc}')
    return '\n\n'.join(blocks)
