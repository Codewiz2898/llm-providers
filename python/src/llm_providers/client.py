"""The Python face of ``llm-providers serve``: every provider, one call, the keys never here.

    from llm_providers import Client
    llm = Client()  # http://127.0.0.1:8787
    r = llm.complete(model="ollama:qwen3:8b", messages=[{"role": "user", "content": "hi"}], max_tokens=200)

A Python timeout or cancel closes the connection, and the service then aborts the model call — so
giving up here stops the spend there.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from . import _wire
from .errors import LlmError, error_from_body
from .results import CompletionResult, SystemOneResult

DEFAULT_URL = "http://127.0.0.1:8787"
#: Above the service's own 120 s default, so the service reports a timeout precisely and this only
#: catches a service that has hung.
DEFAULT_TIMEOUT = 130.0


def _headers(token: Optional[str]) -> Dict[str, str]:
    return {"authorization": f"Bearer {token}"} if token else {}


def _http_timeout(base: float, timeout_ms: Optional[int]) -> float:
    """A call allowed longer than the client's default gets a matching HTTP timeout, plus slack."""
    return max(base, timeout_ms / 1000 + 10) if timeout_ms else base


def _unreachable(base_url: str, e: Exception) -> LlmError:
    return LlmError("network", f"llm-providers service unreachable at {base_url} — is `npx llm-providers serve` running? ({e})")


def _parse(res: httpx.Response) -> Any:
    try:
        body = res.json()
    except ValueError:
        body = None
    if res.status_code >= 400:
        raise error_from_body(res.status_code, body)
    if not isinstance(body, dict):
        raise LlmError("parse", "service reply was not a JSON object", http_status=res.status_code)
    return body


class Client:
    """Synchronous client. Use as a context manager, or call ``close()``."""

    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        *,
        token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._http = httpx.Client(base_url=self.base_url, headers=_headers(token), timeout=timeout, transport=transport)

    def _post(self, path: str, body: Dict[str, Any], timeout_ms: Optional[int]) -> Dict[str, Any]:
        try:
            res = self._http.post(path, json=body, timeout=_http_timeout(self.timeout, timeout_ms))
        except httpx.TimeoutException as e:
            raise LlmError("timeout", f"no reply from the service within the client timeout ({e})") from e
        except httpx.TransportError as e:
            raise _unreachable(self.base_url, e) from e
        return _parse(res)

    def complete(
        self,
        *,
        model: str,
        messages: List[Dict[str, Any]],
        max_tokens: int,
        system: Optional[str] = None,
        schema: Optional[Dict[str, Any]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        thinking: Optional[str] = None,
        effort: Optional[str] = None,
        cache_system: Optional[bool] = None,
        temperature: Optional[float] = None,
        timeout_ms: Optional[int] = None,
        label: Optional[str] = None,
    ) -> CompletionResult:
        body = _wire.completion_request(
            model=model, messages=messages, max_tokens=max_tokens, system=system, schema=schema, tools=tools,
            tool_choice=tool_choice, thinking=thinking, effort=effort, cache_system=cache_system,
            temperature=temperature, timeout_ms=timeout_ms, label=label,
        )  # fmt: skip
        return _wire.completion_result(self._post("/v1/complete", body, timeout_ms))

    def system_one(
        self, target: str, state: Any, questions: Dict[str, Any], *, timeout_ms: Optional[int] = None
    ) -> SystemOneResult:
        body = _wire.system_one_request(target, state, questions, timeout_ms)
        return _wire.system_one_result(self._post("/v1/systemone", body, timeout_ms))

    def health(self) -> Dict[str, Any]:
        try:
            return _parse(self._http.get("/health"))
        except httpx.TransportError as e:
            raise _unreachable(self.base_url, e) from e

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncClient:
    """The same surface for asyncio. Cancelling the task closes the connection, which aborts the call."""

    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        *,
        token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._http = httpx.AsyncClient(base_url=self.base_url, headers=_headers(token), timeout=timeout, transport=transport)

    async def _post(self, path: str, body: Dict[str, Any], timeout_ms: Optional[int]) -> Dict[str, Any]:
        try:
            res = await self._http.post(path, json=body, timeout=_http_timeout(self.timeout, timeout_ms))
        except httpx.TimeoutException as e:
            raise LlmError("timeout", f"no reply from the service within the client timeout ({e})") from e
        except httpx.TransportError as e:
            raise _unreachable(self.base_url, e) from e
        return _parse(res)

    async def complete(
        self,
        *,
        model: str,
        messages: List[Dict[str, Any]],
        max_tokens: int,
        system: Optional[str] = None,
        schema: Optional[Dict[str, Any]] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Any = None,
        thinking: Optional[str] = None,
        effort: Optional[str] = None,
        cache_system: Optional[bool] = None,
        temperature: Optional[float] = None,
        timeout_ms: Optional[int] = None,
        label: Optional[str] = None,
    ) -> CompletionResult:
        body = _wire.completion_request(
            model=model, messages=messages, max_tokens=max_tokens, system=system, schema=schema, tools=tools,
            tool_choice=tool_choice, thinking=thinking, effort=effort, cache_system=cache_system,
            temperature=temperature, timeout_ms=timeout_ms, label=label,
        )  # fmt: skip
        return _wire.completion_result(await self._post("/v1/complete", body, timeout_ms))

    async def system_one(
        self, target: str, state: Any, questions: Dict[str, Any], *, timeout_ms: Optional[int] = None
    ) -> SystemOneResult:
        body = _wire.system_one_request(target, state, questions, timeout_ms)
        return _wire.system_one_result(await self._post("/v1/systemone", body, timeout_ms))

    async def health(self) -> Dict[str, Any]:
        try:
            return _parse(await self._http.get("/health"))
        except httpx.TransportError as e:
            raise _unreachable(self.base_url, e) from e

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()
