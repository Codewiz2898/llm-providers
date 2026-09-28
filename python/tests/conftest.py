"""Fixtures for the tests that cross the language boundary: the REAL Node service, and a stub
OpenAI-compatible upstream standing in for a vLLM. Python client → Node service → stub, and back."""

from __future__ import annotations

import json
import os
import select
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "dist" / "cli.js"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Upstream:
    """What the stub saw: every request body, and whether a caller hung up mid-request."""

    def __init__(self) -> None:
        self.requests: list = []
        self.disconnected = threading.Event()


def _chat(content=None, tool_calls=None, finish="stop"):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"finish_reason": finish, "message": msg}], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}


def make_handler(up: Upstream):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            up.requests.append(body)
            model = body.get("model")
            if model == "json":
                return self._reply(200, _chat(content='{"answer":"yes"}'))
            if model == "tool":
                call = {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"Paris"}'}}
                return self._reply(200, _chat(tool_calls=[call], finish="tool_calls"))
            if model == "limited":
                return self._reply(429, {"error": {"message": "rate limited upstream"}})
            if model == "slow":
                # Wait for the caller to give up; an EOF on the socket means it did.
                deadline = time.time() + 10
                while time.time() < deadline:
                    ready, _, _ = select.select([self.connection], [], [], 0.1)
                    if ready and self.connection.recv(1, socket.MSG_PEEK) == b"":
                        up.disconnected.set()
                        return
                return self._reply(200, _chat(content="too late"))
            return self._reply(404, {"error": {"message": f"unknown model {model}"}})

    return Handler


@pytest.fixture(scope="module")
def upstream():
    up = Upstream()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(up))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    up.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield up
    server.shutdown()


def start_service(tmp: Path, config: dict | None, extra_env: dict | None = None):
    if not CLI.exists():
        pytest.skip(f"{CLI} is missing — run `pnpm build` in the repo root first")
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    port = free_port()
    args = [node, str(CLI), "serve", "--port", str(port)]
    if config is not None:
        cfg = tmp / "llm.json"
        cfg.write_text(json.dumps(config))
        args += ["--config", str(cfg)]
    log = tmp / "service.log"
    # A bare environment: the service gets only what the test hands it — never a developer's keys.
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), **(extra_env or {})}
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=log.open("w"), env=env)
    url = f"http://127.0.0.1:{port}"
    # /health sits behind the token like every route: it names the providers.
    token = (extra_env or {}).get("LLM_PROVIDERS_TOKEN")
    auth = {"authorization": f"Bearer {token}"} if token else {}
    for _ in range(100):
        try:
            if httpx.get(f"{url}/health", headers=auth, timeout=0.5).status_code == 200:
                break
        except httpx.TransportError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError(f"service did not start: {log.read_text()}")
    return SimpleNamespace(url=url, log=log, proc=proc)


@pytest.fixture(scope="module")
def service(upstream, tmp_path_factory):
    svc = start_service(
        tmp_path_factory.mktemp("svc"),
        {"providers": {"stub": {"type": "openai-compatible", "baseUrl": f"{upstream.url}/v1"}}},
    )
    yield svc
    svc.proc.terminate()
    svc.proc.wait(timeout=5)
