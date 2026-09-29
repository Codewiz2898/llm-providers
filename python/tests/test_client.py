"""The client alone, against a mock transport: no service, no network."""

import asyncio
import json

import httpx
import pytest

from llm_providers import AsyncClient, Client, CompletionResult, LlmError, ToolCall

RESULT = {
    "text": '{"action":"act"}',
    "json": {"action": "act"},
    "toolCalls": [{"id": "t1", "name": "search", "args": {"q": "pepsi"}}],
    "message": {
        "role": "assistant",
        "content": '{"action":"act"}',
        "toolCalls": [{"id": "t1", "name": "search", "args": {"q": "pepsi"}}],
        "raw": {"provider": "anthropic", "content": [{"type": "thinking", "thinking": "x", "signature": "s"}]},
    },
    "finish": "tool_calls",
    "usage": {"inputTokens": 100, "outputTokens": 9, "cacheReadTokens": 80, "costUsd": 0.0004},
    "provider": "openrouter",
    "model": "m",
    "ms": 321,
    "warnings": ["schema_relaxed"],
}


def mock(status=200, body=None, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=RESULT if body is None else body)

    return httpx.MockTransport(handler)


def test_python_names_go_out_as_the_wire_names_and_caller_data_is_untouched():
    seen = []
    schema = {"name": "d", "schema": {"type": "object", "properties": {"max_tokens": {"type": "integer"}}}}
    with Client(transport=mock(seen=seen)) as llm:
        llm.complete(
            model="openrouter:m",
            system="s",
            messages=[
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "name": "search", "args": {"tool_call_id": 1}}]},
                {"role": "tool", "tool_call_id": "t1", "content": "[]"},
            ],
            max_tokens=500,
            schema=schema,
            tool_choice={"name": "search"},
            timeout_ms=5000,
            cache_system=True,
            label="decision",
        )
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/complete"
    assert body["maxTokens"] == 500 and body["timeoutMs"] == 5000 and body["cacheSystem"] is True
    assert body["toolChoice"] == {"name": "search"}
    assert body["messages"][1]["toolCalls"][0]["args"] == {"tool_call_id": 1}  # arguments untouched
    assert body["messages"][2] == {"role": "tool", "toolCallId": "t1", "content": "[]"}
    assert body["schema"] == schema  # a schema property named max_tokens stays max_tokens
    assert "temperature" not in body and "thinking" not in body  # unset stays unsent


def test_a_result_comes_back_as_dataclasses_with_python_names():
    with Client(transport=mock()) as llm:
        r = llm.complete(model="openrouter:m", messages=[{"role": "user", "content": "hi"}], max_tokens=10)
    assert isinstance(r, CompletionResult)
    assert r.json == {"action": "act"}
    assert r.tool_calls == [ToolCall(id="t1", name="search", args={"q": "pepsi"})]
    assert r.usage.input_tokens == 100 and r.usage.cache_read_tokens == 80 and r.usage.cost_usd == 0.0004
    assert r.finish == "tool_calls" and r.warnings == ["schema_relaxed"] and r.ms == 321
    # Ready to append when continuing: Python names, and the provider's raw content kept.
    assert r.message["tool_calls"][0]["name"] == "search"
    assert r.message["raw"]["provider"] == "anthropic"


def test_an_appended_message_goes_back_out_in_wire_form():
    seen = []
    with Client(transport=mock(seen=seen)) as llm:
        first = llm.complete(model="p:m", messages=[{"role": "user", "content": "go"}], max_tokens=10)
        llm.complete(model="p:m", messages=[{"role": "user", "content": "go"}, first.message, {"role": "tool", "tool_call_id": "t1", "content": "ok"}], max_tokens=10)
    sent = json.loads(seen[1].content)["messages"][1]
    assert sent["toolCalls"][0]["id"] == "t1" and sent["raw"]["provider"] == "anthropic"
    assert "tool_calls" not in sent


def test_the_service_error_body_becomes_an_llm_error_of_the_same_kind():
    body = {"error": {"kind": "rate_limit", "message": "slow down", "provider": "openrouter", "model": "m", "status": 429}}
    with Client(transport=mock(429, body)) as llm, pytest.raises(LlmError) as e:
        llm.complete(model="openrouter:m", messages=[], max_tokens=10)
    assert (e.value.kind, e.value.provider, e.value.status, e.value.http_status) == ("rate_limit", "openrouter", 429, 429)


def test_an_unreachable_service_and_a_client_timeout_are_named():
    def refuse(_):
        raise httpx.ConnectError("connection refused")

    def slow(_):
        raise httpx.ReadTimeout("timed out")

    with Client(transport=httpx.MockTransport(refuse)) as llm, pytest.raises(LlmError) as e:
        llm.health()
    assert e.value.kind == "network" and "llm-providers serve" in e.value.message
    with Client(transport=httpx.MockTransport(slow)) as llm, pytest.raises(LlmError) as t:
        llm.complete(model="p:m", messages=[], max_tokens=1)
    assert t.value.kind == "timeout"


def test_the_token_is_sent_and_a_long_call_gets_a_long_enough_http_timeout():
    seen = []
    with Client(token="tok", timeout=30, transport=mock(seen=seen)) as llm:
        llm.complete(model="p:m", messages=[], max_tokens=1, timeout_ms=300_000)
    assert seen[0].headers["authorization"] == "Bearer tok"
    assert seen[0].extensions["timeout"]["read"] == 310


def test_system_one_round_trip():
    seen = []
    reply = {"answers": {"d": {"type": "choice", "choice": "billing", "confidence": 0.98}}, "ms": 12, "costUsd": 0.00003}
    with Client(transport=mock(body=reply, seen=seen)) as llm:
        r = llm.system_one("clm", "charged twice", {"d": {"type": "choice", "instructions": "?", "criteria": {"billing": "b"}}}, timeout_ms=900)
    assert json.loads(seen[0].content) == {
        "target": "clm",
        "state": "charged twice",
        "questions": {"d": {"type": "choice", "instructions": "?", "criteria": {"billing": "b"}}},
        "timeoutMs": 900,
    }
    assert r.answers["d"]["choice"] == "billing" and r.cost_usd == 0.00003 and r.ms == 12


def test_the_async_client_has_the_same_surface():
    async def go():
        async with AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=RESULT))) as llm:
            return await llm.complete(model="p:m", messages=[{"role": "user", "content": "hi"}], max_tokens=10)

    r = asyncio.run(go())
    assert r.json == {"action": "act"} and r.tool_calls[0].name == "search"


def test_capture_is_sent_only_when_asked():
    seen = []
    with Client("http://svc", transport=mock(seen=seen)) as llm:
        llm.complete(model="p:m", messages=[{"role": "user", "content": "x"}], max_tokens=5)
        llm.complete(model="p:m", messages=[{"role": "user", "content": "x"}], max_tokens=5, capture=True)
    first, second = (json.loads(r.content) for r in seen)
    assert "capture" not in first
    assert second["capture"] is True


def test_the_callers_trace_travels_as_traceparent_so_the_gateway_span_joins_it():
    """GATEWAY.md §5 — one trace across the caller and the gateway. OpenTelemetry is optional for
    the client; this needs the SDK (the dev extra) to make a span to be inside of."""
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider

    tracer = TracerProvider().get_tracer("test")
    seen = []
    with Client("http://svc", transport=mock(seen=seen)) as llm:
        llm.complete(model="p:m", messages=[{"role": "user", "content": "x"}], max_tokens=5)
        with tracer.start_as_current_span("turn") as span:
            llm.complete(model="p:m", messages=[{"role": "user", "content": "x"}], max_tokens=5)
            trace_id = format(span.get_span_context().trace_id, "032x")
            span_id = format(span.get_span_context().span_id, "016x")
    outside, inside = seen
    assert "traceparent" not in outside.headers  # no active span: nothing is invented
    # version-traceid-spanid-flags; the flags byte varies by SDK (level 2 adds a "random" bit).
    assert inside.headers["traceparent"].startswith(f"00-{trace_id}-{span_id}-")


def test_the_async_client_sends_the_trace_too():
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider

    tracer = TracerProvider().get_tracer("test")
    seen = []

    async def run():
        async with AsyncClient("http://svc", transport=mock(seen=seen)) as llm:
            with tracer.start_as_current_span("turn"):
                await llm.complete(model="p:m", messages=[{"role": "user", "content": "x"}], max_tokens=5)

    asyncio.run(run())
    assert seen[0].headers["traceparent"].startswith("00-")
