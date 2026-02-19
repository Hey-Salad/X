#!/usr/bin/env python3
"""
Lightweight HTTP shim for the upcoming HeySalad GitHub agent.

PM2 runs this script to keep a health endpoint online (for Cloudflare + uptime checks)
while we iterate on the full agent orchestration layer.
"""

from __future__ import annotations

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='HeySalad GitHub agent microservice.')
    parser.add_argument('--host', default='0.0.0.0', help='Bind address.')
    parser.add_argument('--port', type=int, default=8700, help='Listen port.')
    return parser.parse_args()


class AgentHandler(BaseHTTPRequestHandler):
    server_version = 'HeySaladGitHubAgent/0.1'

    def _send(self, status: int, payload: dict, content_type: str = 'application/json') -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == '/' or self.path == '/healthz':
            self._send(200, {'status': 'ok', 'service': 'heysalad-github-agent'})
            return
        self._send(404, {'error': 'not_found', 'path': self.path})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(length) if length else b'{}'
        logging.debug('Received POST payload: %s', data.decode('utf-8') or '{}')
        self._send(202, {'status': 'accepted', 'note': 'Stub agent placeholder'})


def serve(host: str, port: int) -> None:
    logging.info('Starting HeySalad GitHub agent server on %s:%s', host, port)
    with ThreadingHTTPServer((host, port), AgentHandler) as httpd:
        httpd.serve_forever()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s')
    args = parse_args()
    try:
        serve(args.host, args.port)
    except KeyboardInterrupt:
        logging.info('Shutting down HeySalad GitHub agent server.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
