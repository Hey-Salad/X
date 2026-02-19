#!/usr/bin/env python3
"""
Spotify + Reddit powered recommendation agent that routes prompts through
DeepSeek Coder (via the Hugging Face Space) to generate tailored playlists.

Workflow:
1. Refresh a Spotify access token (client credentials + refresh token) and
   fetch the current track for the authenticated user.
2. Query Reddit communities for similar-track discussions to capture human
   curated suggestions / talking points.
3. Hand all of the above to DeepSeek so it can reason about what to play next.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

import requests
from gradio_client import Client

SPACE_URL = 'https://deepseek-ai-deepseek-coder-33b-instruct.hf.space/--replicas/52w5c/'
DEFAULT_SYSTEM_PROMPT = (
    'You are the HeySalad Spotify concierge. Use the track metadata, listening history, '
    'and Reddit chatter to propose 3-5 fresh recommendations. Cite Reddit sources when possible.'
)
DEFAULT_REDDIT_SUBS = ('ifyoulikeblank', 'Music', 'letstalkmusic', 'spotify', 'listentothis')
USER_AGENT = 'heysalad-spotify-agent/1.0 (+github.com/Hey-Salad)'


@dataclass
class TrackInfo:
    name: str
    artist: str
    album: str
    spotify_url: str
    release_year: Optional[int]
    genres: List[str]

    def to_prompt_block(self) -> str:
        year_str = self.release_year or 'Unknown year'
        genres = ', '.join(self.genres) if self.genres else 'Unknown genres'
        return (
            f'Current track: "{self.name}" by {self.artist} (album: {self.album}, {year_str}).\n'
            f'Genres: {genres}\n'
            f'Spotify URL: {self.spotify_url}'
        )


def _env_or_arg(value: Optional[str], fallback_env: str) -> Optional[str]:
    return value or os.environ.get(fallback_env)


def refresh_spotify_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    response = requests.post(
        'https://accounts.spotify.com/api/token',
        data={'grant_type': 'refresh_token', 'refresh_token': refresh_token},
        auth=(client_id, client_secret),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    token = data.get('access_token')
    if not token:
        raise RuntimeError(f'Missing access_token in Spotify response: {data}')
    return token


def fetch_current_track(access_token: str) -> TrackInfo:
    headers = {'Authorization': f'Bearer {access_token}'}
    response = requests.get(
        'https://api.spotify.com/v1/me/player/currently-playing',
        headers=headers,
        timeout=10,
    )
    if response.status_code == 204:
        raise RuntimeError('No track is currently playing.')
    if response.status_code == 401:
        raise RuntimeError('Spotify token expired or invalid.')
    response.raise_for_status()
    payload = response.json()
    item = payload.get('item')
    if not item:
        raise RuntimeError(f'Unexpected Spotify payload: {payload}')
    artist_names = ', '.join(artist['name'] for artist in item.get('artists', []))
    album = item.get('album', {})
    release_year = None
    release_date = album.get('release_date')
    if release_date:
        release_year = int(release_date.split('-')[0])
    return TrackInfo(
        name=item.get('name', 'Unknown'),
        artist=artist_names or 'Unknown artist',
        album=album.get('name', 'Unknown album'),
        spotify_url=item.get('external_urls', {}).get('spotify', ''),
        release_year=release_year,
        genres=[],  # Spotify track endpoint does not include genre directly.
    )


def fetch_reddit_threads(query: str, subs: Iterable[str], limit: int) -> List[dict]:
    results: List[dict] = []
    for sub in subs:
        if len(results) >= limit:
            break
        response = requests.get(
            f'https://www.reddit.com/r/{sub}/search.json',
            params={
                'q': query,
                'restrict_sr': 'on',
                'sort': 'top',
                't': 'year',
                'limit': min(limit - len(results), 10),
            },
            headers={'User-Agent': USER_AGENT},
            timeout=10,
        )
        if response.status_code >= 400:
            continue
        data = response.json()
        children = data.get('data', {}).get('children', [])
        for child in children:
            post = child.get('data', {})
            results.append(
                {
                    'title': post.get('title'),
                    'score': post.get('score'),
                    'url': f"https://www.reddit.com{post.get('permalink')}",
                    'subreddit': sub,
                }
            )
            if len(results) >= limit:
                break
    return results


def format_reddit_block(posts: List[dict]) -> str:
    if not posts:
        return 'No Reddit discussions found for this track.'
    lines = []
    for post in posts:
        lines.append(
            f"- [{post['subreddit']}] {post['title']} (score {post['score']}) – {post['url']}"
        )
    return 'Top Reddit discussions:\n' + '\n'.join(lines)


def call_deepseek(message: str, system_prompt: str, max_new_tokens: int, top_p: float, top_k: int,
                  repetition_penalty: float) -> str:
    client = Client(SPACE_URL)
    return client.predict(
        message,
        system_prompt,
        max_new_tokens,
        top_p,
        top_k,
        repetition_penalty,
        api_name='/chat',
    )


def load_history(path: Optional[Path]) -> List[dict]:
    if not path or not path.exists():
        return []
    with path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError('History file must contain a list of {role, content}.')
    return data


def save_history(path: Path, history: List[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as handle:
        json.dump(history, handle, indent=2)


def build_prompt(track: TrackInfo, reddit_block: str, user_note: Optional[str]) -> str:
    parts = [track.to_prompt_block(), reddit_block]
    if user_note:
        parts.append(f'Listener note: {user_note}')
    return '\n\n'.join(parts)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Spotify → Reddit → DeepSeek recommendation agent.')
    parser.add_argument('--client-id', help='Spotify Client ID (or set SPOTIFY_CLIENT_ID).')
    parser.add_argument('--client-secret', help='Spotify Client Secret (or set SPOTIFY_CLIENT_SECRET).')
    parser.add_argument('--refresh-token', help='Spotify Refresh Token (or set SPOTIFY_REFRESH_TOKEN).')
    parser.add_argument('--access-token', help='Optional: existing Spotify access token (overrides refresh).')
    parser.add_argument('--subreddits', nargs='*', default=DEFAULT_REDDIT_SUBS,
                        help='Subreddits to mine for recommendations.')
    parser.add_argument('--reddit-limit', type=int, default=6, help='Maximum Reddit posts to include.')
    parser.add_argument('--note', help='Optional listener note (mood, vibe, venue, etc.).')
    parser.add_argument('--system', default=DEFAULT_SYSTEM_PROMPT, help='Override the DeepSeek system prompt.')
    parser.add_argument('--history', help='Persist conversation history JSON path.')
    parser.add_argument('--max-new-tokens', type=int, default=600)
    parser.add_argument('--top-p', type=float, default=0.9)
    parser.add_argument('--top-k', type=int, default=50)
    parser.add_argument('--repetition-penalty', type=float, default=1.05)
    return parser.parse_args(argv or sys.argv[1:])


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    history_path = Path(args.history).expanduser() if args.history else None
    history = load_history(history_path)

    access_token = _env_or_arg(args.access_token, 'SPOTIFY_ACCESS_TOKEN')
    if not access_token:
        client_id = _env_or_arg(args.client_id, 'SPOTIFY_CLIENT_ID')
        client_secret = _env_or_arg(args.client_secret, 'SPOTIFY_CLIENT_SECRET')
        refresh_token = _env_or_arg(args.refresh_token, 'SPOTIFY_REFRESH_TOKEN')
        if not all([client_id, client_secret, refresh_token]):
            raise SystemExit('Spotify credentials missing. Provide client id/secret + refresh token or an access token.')
        access_token = refresh_spotify_token(client_id, client_secret, refresh_token)

    track = fetch_current_track(access_token)
    reddit_posts = fetch_reddit_threads(
        query=f'"{track.name}" "{track.artist}" recommendations',
        subs=args.subreddits,
        limit=args.reddit_limit,
    )
    reddit_block = format_reddit_block(reddit_posts)
    message = build_prompt(track, reddit_block, args.note)
    if history:
        conversation = '\n\n'.join(f"{turn['role'].capitalize()}: {turn['content']}" for turn in history)
        message = f'{conversation}\n\nUser Context:\n{message}'

    response = call_deepseek(
        message=message,
        system_prompt=args.system,
        max_new_tokens=args.max_new_tokens,
        top_p=args.top_p,
        top_k=args.top_k,
        repetition_penalty=args.repetition_penalty,
    )

    print(response)

    if history_path:
        updated_history = history + [
            {'role': 'user', 'content': message},
            {'role': 'assistant', 'content': response},
        ]
        save_history(history_path, updated_history)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
