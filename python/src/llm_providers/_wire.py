"""Python names in, the library's wire names out — and back.

ONLY the contract's own keys are renamed. A JSON schema, tool parameters and tool arguments are the
caller's data and pass through untouched: a schema property called ``max_tokens`` must reach the
model as ``max_tokens``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .results import CompletionResult, SystemOneResult, ToolCall, Usage

_MESSAGE_OUT = {"tool_calls": "toolCalls", "tool_call_id": "toolCallId"}
_MESSAGE_IN = {v: k for k, v in _MESSAGE_OUT.items()}
_USAGE_IN = {
    "inputTokens": "input_tokens",
    "outputTokens": "output_tokens",
    "cacheReadTokens": "cache_read_tokens",
    "cacheWriteTokens": "cache_write_tokens",
    "costUsd": "cost_usd",
}


def message_out(m: Dict[str, Any]) -> Dict[str, Any]:
    return {_MESSAGE_OUT.get(k, k): v for k, v in m.items()}


def message_in(m: Dict[str, Any]) -> Dict[str, Any]:
    return {_MESSAGE_IN.get(k, k): v for k, v in m.items()}


def completion_request(
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
    capture: bool = False,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "model": model,
        "messages": [message_out(m) for m in messages],
        "maxTokens": max_tokens,
    }
    optional = {
        "system": system,
        "schema": schema,
        "tools": tools,
        "toolChoice": tool_choice,
        "thinking": thinking,
        "effort": effort,
        "cacheSystem": cache_system,
        "temperature": temperature,
        "timeoutMs": timeout_ms,
        "label": label,
    }
    body.update({k: v for k, v in optional.items() if v is not None})
    if capture:
        body["capture"] = True  # a gateway records this call's prompt and reply text (GATEWAY.md §5)
    return body


def completion_result(j: Dict[str, Any]) -> CompletionResult:
    usage = j.get("usage") or {}
    return CompletionResult(
        text=j.get("text", ""),
        json=j.get("json"),
        tool_calls=[ToolCall(id=c["id"], name=c["name"], args=c.get("args") or {}) for c in j.get("toolCalls", [])],
        message=message_in(j.get("message") or {"role": "assistant", "content": j.get("text", "")}),
        finish=j.get("finish", "other"),
        usage=Usage(**{py: usage[w] for w, py in _USAGE_IN.items() if w in usage}),
        provider=j.get("provider", ""),
        model=j.get("model", ""),
        ms=int(j.get("ms", 0)),
        warnings=list(j.get("warnings", [])),
    )


def system_one_request(
    target: str, state: Any, questions: Dict[str, Any], timeout_ms: Optional[int], label: Optional[str] = None
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"target": target, "state": state, "questions": questions}
    if timeout_ms is not None:
        body["timeoutMs"] = timeout_ms
    if label:
        body["label"] = label
    return body


def system_one_result(j: Dict[str, Any]) -> SystemOneResult:
    return SystemOneResult(answers=j.get("answers", {}), ms=int(j.get("ms", 0)), cost_usd=j.get("costUsd"))
