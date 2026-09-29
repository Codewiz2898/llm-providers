# llm-providers from Python: a local service and a thin client

> Status: **BUILT (2026-09-29): tests pass, verified live Python → Ollama.** An addendum to
> [DESIGN.md](./DESIGN.md), approved the same day. Option 1 was chosen: one TypeScript
> implementation served over HTTP, with a thin Python client. The rejected alternative was a Python
> port that would drift from the TypeScript.

## 1. Shape

```
Python code ──httpx──▶ llm-providers serve (Node, 127.0.0.1:8787) ──▶ Anthropic · OpenRouter · vLLM · Ollama
     │                        holds the API keys                    └──▶ Jev · CLM
     └── llm_providers.Client / AsyncClient
```

- **One implementation.** Every provider, lesson and fix lives in the TypeScript, and Python gets
  them by upgrading the service.
- **The keys stay in the service.** Python never holds an API key.
- **Same JSON on both sides.** The wire is the library's own contract (DESIGN §5), so the service
  translates almost nothing.

## 2. Scope

**In:**
- `llm-providers serve`, run with a `bin` entry or `npx`: `node:http`, no new dependencies;
- `POST /v1/complete`, `POST /v1/systemone`, `GET /health`;
- configuration by environment, or a JSON file;
- a Python package `llm_providers` with `Client` and `AsyncClient`, built on `httpx`;
- tests on both sides, plus one test crossing the language boundary;
- Python in CI.

**Deferred:**

| deferred | lands in |
|---|---|
| Streaming | when a caller needs it (DESIGN §2) |
| Publishing to npm / PyPI | when something outside this machine needs it; until then, git installs |
| Docker image | when the service runs somewhere other than beside its caller |
| Auth beyond one shared token | never, while it binds to loopback |

## 3. The service

**Start:**
```bash
npx llm-providers serve                      # 127.0.0.1:8787, providers from the environment
npx llm-providers serve --config llm.json --port 8787
```

**Configuration.** With no `--config`, providers are registered from what the environment has:
- `anthropic`, if `ANTHROPIC_API_KEY` is set;
- `openrouter`, if `OPENROUTER_API_KEY` is set;
- `ollama` at `OLLAMA_URL` (default `http://127.0.0.1:11434`);
- System One targets `jev` (with the OpenRouter key) and `clm` (at `CLM_URL`, if set).

A config file adds OpenAI-compatible servers and anything else. **Keys are named by environment
variable, never written into the file:**

```json
{
  "providers": {
    "vllm":       { "type": "openai-compatible", "baseUrl": "http://gpu-box:8000/v1",
                    "thinkingOffBody": { "chat_template_kwargs": { "enable_thinking": false } } },
    "openrouter": { "type": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY", "appName": "Jarvis" },
    "ollama":     { "type": "ollama", "numCtx": 32768 }
  },
  "systemOne": {
    "jev": { "type": "jev", "apiKeyEnv": "OPENROUTER_API_KEY" },
    "clm": { "type": "clm", "url": "http://127.0.0.1:8700/v1/systemone" }
  }
}
```

**Endpoints:**

| method | path | body → reply |
|---|---|---|
| `GET` | `/health` | → `{ ok, providers: [...], systemOne: [...] }` (names only) |
| `POST` | `/v1/complete` | `CompletionRequest` as JSON (no `signal`) → `CompletionResult` |
| `POST` | `/v1/systemone` | `{ target: "jev" \| "clm" \| <name>, state, questions, timeoutMs? }` → `SystemOneResult` |

**Errors** come back as `{ "error": { kind, message, provider, model, status? } }`. The HTTP status
follows from `kind`:

| kind | HTTP status |
|---|---|
| `bad_request` | 400 |
| `rate_limit` | 429 |
| `timeout` | 504 |
| `aborted` | 499 |
| `auth`, `schema_rejected`, `server`, `network`, `parse` | 502 (the upstream failed, not the caller) |

The Python client turns these back into `LlmError` with the same `kind`.

**A cancel crosses the boundary.** If the HTTP client disconnects, the service aborts the upstream
call, so a Python `timeout` or task cancel stops the model call too (DESIGN §6: a cancel must abort
the request itself).

**Safety:**
- It binds to `127.0.0.1` unless `--host` says otherwise.
- `LLM_PROVIDERS_TOKEN` adds bearer auth, and it is **required** for any non-loopback host: the
  service refuses to start without it.
- Request bodies are limited to 10 MB. No CORS headers are sent.
- It logs one line per call to stderr (provider, model, label, ms, warnings, error kind), and never
  a body or a key.

## 4. The Python client

- A `python/` directory in this repo. Install it with
  `pip install "git+ssh://git@github.com/Codewiz2898/llm-providers.git#subdirectory=python"`.
- Python ≥ 3.10; the only dependency is `httpx`; built with hatchling.

```python
from llm_providers import Client, LlmError

llm = Client("http://127.0.0.1:8787", token=None, timeout=130.0)
r = llm.complete(
    model="openrouter:moonshotai/kimi-k2.7-code",
    system="You decide.",
    messages=[{"role": "user", "content": "order a pepsi"}],
    max_tokens=4096,
    schema={"name": "decision", "schema": {...}},
    timeout_ms=60_000,
)
r.json, r.tool_calls, r.finish, r.usage.cost_usd, r.warnings, r.message
res = llm.system_one("clm", state={...}, questions={...})

# asyncio: the same surface
async with AsyncClient("http://127.0.0.1:8787") as llm: ...
```

- **snake_case in Python, camelCase on the wire.** The client converts the contract's known keys
  in both directions: `max_tokens`, `tool_choice`, `timeout_ms`, `cache_system`, and in messages
  `tool_calls` and `tool_call_id`. Nothing else is renamed, so a JSON schema or tool arguments
  pass through untouched.
- **Results are frozen dataclasses:** `CompletionResult`, `ToolCall`, `Usage`, `SystemOneResult`.
  `r.message` is a dict ready to append to `messages` when continuing, and it keeps `raw`.
- **The client's HTTP timeout defaults above the service's own 120 s.** The service reports
  `timeout` precisely, and the client only catches a service that has hung.

## 4b. The TypeScript client: `connectLlm` (added for Jarvis, doc 67)

`connectLlm({ url, token, onCall })` returns the same `Llm` interface as `createLlm`, plus
`systemOne(target, …)` and `health()`.
- Model refs pass through; the service routes them.
- Errors come back with the service's kind, provider, model and status. The service now sends a
  `detail` field beside `message`, so the rebuilt error doesn't prefix "provider model: kind"
  twice.
- An unreachable service is `network`, naming the URL and the command that starts it.
- Aborting closes the connection, and the service aborts upstream.
- The HTTP timeout is the call's own timeout plus 10 s of slack, so the service reports a timeout
  precisely and the client only catches a hung service.
- `onCall` fires in the caller's process, from the result.

**Missing keys no longer stop the service.** A provider or System One target whose key variable is
unset is left out and listed at startup as `llm-providers skipped <name>: <VAR> is not set`, by
variable name, never by value. One config then serves a machine that has only some keys.

## 5. Testing

| tier | what |
|---|---|
| **TS unit** | The server against fake providers on an ephemeral port: routing, the error-kind → status table, the token (missing / wrong / right), the non-loopback refusal, the body limit, a client disconnect aborting the provider's signal, and config parsing, including that a key is read from its env var and never from the file. |
| **Python unit** | `httpx.MockTransport`: key conversion both ways, result dataclasses, error bodies → `LlmError`, and the async twin. |
| **Across the boundary** | pytest starts the real `node dist/cli.js serve` against a tiny local OpenAI-compatible stub standing in for vLLM. A Python `complete()` with a schema, a tool call, and an upstream error all travel Python → Node → stub → back. This is what catches a contract mismatch between the two languages, which no single-language test can. |
| **Live** (opt-in) | Python → service → Ollama for real, once. |

CI gains a `python` job (3.10 and 3.13) that builds the Node service and runs pytest, including the
cross-boundary test.

## 6. Acceptance

- [x] `npx llm-providers serve` starts with providers from the environment; `/health` lists them.
      *Checked by hand: an empty environment gives `providers: ollama`.*
- [x] Every error kind maps to its status and back to the same Python `LlmError.kind`. *TS unit
      (the status table) and cross-boundary (an upstream 429 → `rate_limit` in Python).*
- [x] A Python timeout or cancel aborts the upstream call. *Cross-boundary: the stub sees the
      connection close, and the service logs `error=aborted`.*
- [x] A non-loopback host without a token refuses to start (exit 2); with a token, a wrong or
      missing token gets 401. *TS unit and cross-boundary.* `/health` is behind the token too,
      since it names the providers.
- [ ] The cross-boundary test passes locally ✓ and in CI (the `python` job, pending its first
      run); one live Python → Ollama call ✓.
- [x] README: starting the service, the Python install, and one example.

## 7. Build order

1. `src/server/`: config loading, the HTTP handler, the error → status map, disconnect → abort,
   and `src/cli.ts` with a `bin` entry. TS unit tests.
2. `python/llm_providers/`: `Client`, `AsyncClient`, types, errors, key conversion. Python unit
   tests.
3. The cross-boundary test, with the stub upstream; then live Python → Ollama.
4. CI `python` job; README; this doc's status.
5. Commits by concern on `feat/python-service`; push; a PR stacked on #1 (base `feat/initial-library`).
