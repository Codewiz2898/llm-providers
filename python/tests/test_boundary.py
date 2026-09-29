"""Python client → the real Node service → a stub upstream, and back.

The only tier that can catch the two languages disagreeing about the contract: every other test
here or in TypeScript checks one side against its own idea of the other.
"""

import os
import time

import pytest

from llm_providers import Client, LlmError

from .conftest import start_service

SCHEMA = {"name": "verdict", "schema": {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}}


def test_health_lists_the_configured_provider(service):
    with Client(service.url) as llm:
        assert llm.health() == {"ok": True, "providers": ["stub"], "systemOne": []}


def test_structured_json_travels_both_ways(service, upstream):
    with Client(service.url) as llm:
        r = llm.complete(model="stub:json", messages=[{"role": "user", "content": "is water wet?"}], max_tokens=50, schema=SCHEMA, label="t")
    assert r.json == {"answer": "yes"} and r.finish == "stop" and r.provider == "stub"
    assert r.usage.input_tokens == 7
    # What reached the upstream is the library's real OpenAI-wire request, built from Python's call.
    sent = upstream.requests[-1]
    assert sent["max_tokens"] == 50
    assert sent["response_format"] == {"type": "json_schema", "json_schema": {"name": "verdict", "strict": True, "schema": SCHEMA["schema"]}}


def test_a_tool_call_travels_both_ways_and_the_conversation_continues(service, upstream):
    tools = [{"name": "get_weather", "description": "Weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}]
    with Client(service.url) as llm:
        r = llm.complete(model="stub:tool", messages=[{"role": "user", "content": "weather in Paris?"}], max_tokens=50, tools=tools)
        assert r.finish == "tool_calls"
        assert r.tool_calls[0].name == "get_weather" and r.tool_calls[0].args == {"city": "Paris"}
        llm.complete(
            model="stub:json",
            messages=[{"role": "user", "content": "weather in Paris?"}, r.message, {"role": "tool", "tool_call_id": "call_1", "content": "sunny"}],
            max_tokens=50,
        )
    msgs = upstream.requests[-1]["messages"]
    assert msgs[1]["tool_calls"][0]["function"]["name"] == "get_weather"
    assert msgs[2] == {"role": "tool", "tool_call_id": "call_1", "content": "sunny"}


def test_an_upstream_failure_keeps_its_kind_across_both_hops(service):
    with Client(service.url) as llm, pytest.raises(LlmError) as e:
        llm.complete(model="stub:limited", messages=[{"role": "user", "content": "x"}], max_tokens=5)
    assert (e.value.kind, e.value.http_status, e.value.status, e.value.provider) == ("rate_limit", 429, 429, "stub")


def test_giving_up_in_python_stops_the_upstream_call(service, upstream):
    upstream.disconnected.clear()
    with Client(service.url, timeout=1.0) as llm, pytest.raises(LlmError) as e:
        llm.complete(model="stub:slow", messages=[{"role": "user", "content": "x"}], max_tokens=5)
    assert e.value.kind == "timeout"
    # Python hung up → the service aborted its request → the upstream saw the connection close.
    assert upstream.disconnected.wait(5), "the upstream call was left running after Python gave up"
    time.sleep(0.2)
    assert "error=aborted" in service.log.read_text()


def test_a_token_protected_service_refuses_a_client_without_it(upstream, tmp_path):
    svc = start_service(
        tmp_path,
        {"providers": {"stub": {"type": "openai-compatible", "baseUrl": f"{upstream.url}/v1"}}},
        {"LLM_PROVIDERS_TOKEN": "tok-abc"},
    )
    try:
        with Client(svc.url) as anon, pytest.raises(LlmError) as e:
            anon.complete(model="stub:json", messages=[{"role": "user", "content": "x"}], max_tokens=5)
        assert e.value.http_status == 401
        with Client(svc.url, token="tok-abc") as ok:
            assert ok.complete(model="stub:json", messages=[{"role": "user", "content": "x"}], max_tokens=5).text == '{"answer":"yes"}'
    finally:
        svc.proc.terminate()
        svc.proc.wait(timeout=5)


@pytest.mark.live
@pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="live: set LIVE=1 (needs Ollama running)")
def test_live_python_to_ollama(tmp_path):
    svc = start_service(tmp_path, None)  # providers from the environment: a local Ollama
    try:
        with Client(svc.url) as llm:
            r = llm.complete(
                model=f"ollama:{os.environ.get('LIVE_OLLAMA_MODEL', 'qwen3:4b')}",
                messages=[{"role": "user", "content": "Is water wet? Reply as JSON."}],
                max_tokens=300,
                schema={"name": "v", "schema": {"type": "object", "properties": {"answer": {"type": "string", "enum": ["yes", "no"]}}, "required": ["answer"]}},
                timeout_ms=90_000,
            )
        assert r.json["answer"] in ("yes", "no")
    finally:
        svc.proc.terminate()
        svc.proc.wait(timeout=5)


def test_a_gateway_knows_each_app_by_its_token_and_refuses_a_stranger(upstream, tmp_path):
    """docs/GATEWAY.md §4 — the same service, with apps: each call labelled with its app."""
    jarvis, sports = "jarvis-token-0123456789", "sports-token-0123456789"
    svc = start_service(
        tmp_path,
        {
            "providers": {"stub": {"type": "openai-compatible", "baseUrl": f"{upstream.url}/v1"}},
            "apps": {"jarvis": {"tokenEnv": "JARVIS_TOKEN"}, "sports-follow": {"tokenEnv": "SPORTS_TOKEN"}},
        },
        {"JARVIS_TOKEN": jarvis, "SPORTS_TOKEN": sports},
    )
    ask = dict(model="stub:json", messages=[{"role": "user", "content": "x"}], max_tokens=5)
    try:
        with Client(svc.url) as anon:
            assert anon.health()["apps"] == ["jarvis", "sports-follow"]  # /health needs no token
        with Client(svc.url, token=sports) as app:
            assert app.complete(**ask).text == '{"answer":"yes"}'
        with Client(svc.url, token="not-a-real-token-at-all") as stranger, pytest.raises(LlmError) as e:
            stranger.complete(**ask)
        assert e.value.kind == "unauthorized"
        assert e.value.http_status == 401
        time.sleep(0.2)
        log = svc.log.read_text()
        assert "app=sports-follow provider=stub" in log
        assert jarvis not in log and sports not in log  # a token is never logged
    finally:
        svc.proc.terminate()
        svc.proc.wait(timeout=5)
