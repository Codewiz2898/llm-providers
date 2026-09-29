# llm-providers

One library for calling models, whoever serves them. It covers:

- **Anthropic**, through the official SDK;
- **OpenRouter**;
- any **OpenAI-compatible** server: a local vLLM, LM Studio, llama.cpp, Together, Groq;
- **Ollama**, through its native API;
- **System One** questions to Jev or a self-hosted CLM.

You write a request once and pick who serves it with a model ref. What comes back has the same
shape from all of them. The design, and the reasoning behind each rule, is in
[docs/DESIGN.md](docs/DESIGN.md).

## Install

Not on npm yet, so install from git (the `prepare` script builds `dist/`):

```bash
pnpm add github:Codewiz2898/llm-providers
```

Needs Node ≥ 20.3.

## Generative calls

```ts
import { anthropic, createLlm, ollama, openaiCompatible, openrouter } from 'llm-providers';

const llm = createLlm({
  providers: {
    anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    openrouter: openrouter({ apiKey: process.env.OPENROUTER_API_KEY!, appName: 'Jarvis' }),
    vllm: openaiCompatible({
      baseUrl: 'http://gpu-box:8000/v1',
      // vLLM + Qwen3: how "thinking off" is said on this server.
      thinkingOffBody: { chat_template_kwargs: { enable_thinking: false } },
    }),
    ollama: ollama({ numCtx: 32768 }),
  },
  onCall: (e) => console.log(e.provider, e.model, e.label, e.ms, e.usage, e.warnings, e.error),
});

const r = await llm.complete({
  model: 'openrouter:moonshotai/kimi-k2.7-code', // provider:model — `ollama:qwen3:8b` works too
  system: 'You decide what to do next.',
  messages: [{ role: 'user', content: 'order a pepsi' }],
  maxTokens: 4096,
  schema: { name: 'decision', schema: { type: 'object', properties: { action: { type: 'string' } } } },
  timeoutMs: 60_000, // default 120 s
  label: 'decision', // only echoed to onCall
});

r.json;      // the parsed object, when a schema was given
r.toolCalls; // [{ id, name, args }]
r.finish;    // 'stop' | 'length' | 'tool_calls' | 'refusal' | 'other'
r.usage;     // { inputTokens, outputTokens, costUsd? (OpenRouter), cacheReadTokens? (Anthropic) }
r.warnings;  // see below
```

**Tool calls.** Pass `tools` and optionally `toolChoice`. To continue after a call, append
`r.message`, which is the assistant turn with its tool calls, and then one
`{ role: 'tool', toolCallId, content }` per result. `r.message` carries the provider's raw content
where the provider needs it back. Anthropic does: with thinking on, its thinking blocks must precede
a tool result.

**Warnings** name the failures that would otherwise be silent:

| warning | means |
|---|---|
| `schema_relaxed` | The strict schema was refused, so the reply came from JSON mode with the schema in the prompt. |
| `reasoning_fallback` | `content` was empty and the answer was read out of the model's reasoning. |
| `truncated` | The reply stopped at `maxTokens`. |
| `empty` | There was no text at all: a budget or provider problem. |
| `json_unparsed` | A schema was asked for and the text was not JSON. |
| `tool_args_unparsed` | A tool call's arguments were not JSON. |

**Errors** are `LlmError` with a `kind`: `auth`, `rate_limit`, `schema_rejected`, `bad_request`,
`server`, `timeout`, `aborted`, `network` or `parse`. Messages never carry a key.

## System One

```ts
import { askSystemOne, certainty, clm, jev } from 'llm-providers';

const target = process.env.CLM_URL ? clm({ url: process.env.CLM_URL }) : jev({ apiKey: process.env.OPENROUTER_API_KEY! });
const { answers } = await askSystemOne(target, { user_asked: 'toss a coin' }, {
  kind: { type: 'choice', instructions: 'What is being asked for?', criteria: { chance: 'a random result', fact: 'a fact' } },
});
answers.kind?.choice;          // 'chance'
certainty(answers.kind!);      // 0..1, on one scale for choice and noul
```

The OpenRouter key only ever goes to OpenRouter. `clm()` carries CLM's own key, or none.

## From Python, or anything that speaks HTTP

Run the library as a local service. It holds the keys; callers never do.

```bash
npx llm-providers serve                        # 127.0.0.1:8787, providers from the environment
npx llm-providers serve --config llm.json      # add vLLM servers etc.; keys by env-var NAME only
```

```bash
pip install "git+ssh://git@github.com/Codewiz2898/llm-providers.git#subdirectory=python"
```

```python
from llm_providers import Client

with Client() as llm:
    r = llm.complete(model="openrouter:moonshotai/kimi-k2.7-code",
                     messages=[{"role": "user", "content": "order a pepsi"}], max_tokens=4096)
```

From **TypeScript**, `connectLlm` gives the same `Llm` as `createLlm`, but every call goes to
the service:

```ts
import { connectLlm } from 'llm-providers';

const llm = connectLlm({ url: 'http://127.0.0.1:8787', onCall: (e) => metrics(e) });
await llm.complete({ model: 'openrouter:moonshotai/kimi-k2.7-code', messages, maxTokens: 4096 });
await llm.systemOne('jev', state, questions);
await llm.health(); // { providers, systemOne }
```

The Python client:
- has a sync `Client` and an async `AsyncClient`;
- uses Python names, while the service speaks the library's own JSON;
- raises `LlmError` with the same `kind` as the TypeScript library.

When Python gives up, by a timeout or a cancel, the service aborts the model call. The service
binds to `127.0.0.1`, and it requires `LLM_PROVIDERS_TOKEN` before it will listen anywhere else.
[docs/SERVICE.md](docs/SERVICE.md) has the endpoints, the config format and the error-to-status
map.

## Develop

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm lint && pnpm build
cd python && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && .venv/bin/python -m pytest -q
```

Live smoke, which is opt-in and costs a few cents at most: Ollama locally, plus OpenRouter,
Anthropic and Jev if their keys are present.

```bash
LIVE=1 LLM_ENV_FILE=/path/to/.env pnpm test:live
```
