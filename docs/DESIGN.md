# llm-providers: one library for calling models, whoever serves them

> Status: **LLD, awaiting review.** Nothing is built yet. It is extracted from Jarvis
> (`Codewiz2898/jarvis`, `apps/server/src/ai`), where three hand-written clients and a Jev client
> each learned the same lessons separately.

## 1. Why

Jarvis calls models in two ways.

- **Generative calls** go to Anthropic, OpenRouter or Ollama. Each has its own client
  (`client.ts` 1,785 lines, `openrouter.ts` 298, `ollama.ts` 237), and a separate client handles
  tool calls for compose.
- **System One questions** go to Jev (`jev.ts`), and now a self-hosted CLM is being piloted beside
  it.

Every client relearned the same things:
- strict JSON schemas can be silently ignored;
- a reasoning model can return an empty `content`;
- truncation has to be named;
- a cancel must abort the HTTP request itself.

A new backend, such as a local vLLM, would mean a fourth copy. This library holds **the transport
once**. Jarvis keeps its own methods (`decide`, `authorFreeform`, `profile`…) and later builds them
on top of it (§10).

## 2. Scope

**In:**

| | |
|---|---|
| Providers | **Anthropic** (official SDK) · **OpenRouter** · **OpenAI-compatible** (a local vLLM, LM Studio, llama.cpp server, any `/v1/chat/completions`) · **Ollama** (native `/api/chat`) |
| Generative | Structured JSON output against a JSON Schema; plain text; tool definitions in, tool calls out (one turn — the caller owns the loop) |
| System One | Choice, noul and score questions; targets Jev on OpenRouter and a self-hosted CLM, or any server speaking the same wire format |
| Cross-cutting | Model refs (`openrouter:moonshotai/kimi-k2.7-code`); a per-call timeout; typed errors; one normalised result; an `onCall` hook for logging, metrics and cost — the library itself logs nothing |

**Deferred, each with a home:**

| deferred | why | lands in |
|---|---|---|
| Jarvis on the library | Decided at review: extract first, then switch | Phase 2 (§10) |
| Streaming tokens to the caller | Jarvis consumes whole replies; Anthropic streams internally only because the SDK requires it at 64K | When a caller needs it |
| Fallback chains (try B when A fails) | A routing policy, not transport; Jarvis has none today | Phase 3, if wanted |
| Embeddings | Only CLM's encoder uses them, and CLM calls it itself | When a caller needs it |
| Multi-turn memory / agent loop | The caller's concern | — |

## 3. Stack

| | version | why |
|---|---|---|
| Node | ≥ 20 (machine: 20.18.1) | global `fetch`, `AbortSignal.any`, `AbortSignal.timeout` |
| TypeScript | ^5.5.4 | as Jarvis |
| pnpm | 9.7.0 | as Jarvis |
| `@anthropic-ai/sdk` | ^0.114.0 | as Jarvis; Claude is called through the official SDK |
| vitest | ^2.1.4 | as Jarvis |
| @biomejs/biome | ^1.8.3 | as Jarvis |

OpenRouter, OpenAI-compatible, Ollama and System One use plain `fetch`, so there is no OpenAI SDK
and no second HTTP stack. The package is ESM, built with `tsc` to `dist/` with type declarations,
and consumed by Jarvis as a git dependency until it is published (§10).

**Step 0 (toolchain):** `pnpm install && pnpm typecheck && pnpm test` on an empty scaffold before
any library code.

## 4. Layout

```
src/
  index.ts              public exports
  types.ts              Message, CompletionRequest, CompletionResult, ToolDef, ToolCall, Usage
  errors.ts             LlmError + kinds
  json.ts               extractJson (fence-tolerant), schema helpers
  client.ts             createLlm(): provider registry, model refs, timeout, onCall hook
  providers/
    openaiCompatible.ts the shared /v1/chat/completions core (vLLM, LM Studio, OpenRouter's base)
    openrouter.ts       openaiCompatible + require_parameters, attribution headers, cost
    ollama.ts           native /api/chat, format=schema, think:false, num_ctx
    anthropic.ts        SDK, streaming→finalMessage, output_config.format, thinking, tools
  systemOne/
    index.ts            question/answer types, askSystemOne, jev(), clm(), certainty helpers
test/
  unit/                 every provider against a stubbed fetch / fake SDK — no network
  contract/             the SAME requests through every provider → the same normalised result
  live/                 opt-in (LIVE=1): Ollama locally; OpenRouter, Anthropic, Jev at cents
docs/DESIGN.md          this document
```

## 5. The contract

```ts
type Role = 'user' | 'assistant' | 'tool';
interface Message { role: Role; content: string; toolCalls?: ToolCall[]; toolCallId?: string }

interface CompletionRequest {
  model: string;                        // "openrouter:moonshotai/kimi-k2.7-code", "anthropic:claude-opus-4-8", "vllm:qwen3-8b"
  system?: string;
  messages: Message[];
  maxTokens: number;
  schema?: { name: string; schema: object };   // structured output; the result carries `json`
  tools?: ToolDef[];                    // { name, description, parameters: JSON Schema }
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  thinking?: 'off' | 'adaptive';        // mapped per provider; `off` also sends Ollama think:false
  effort?: 'low' | 'medium' | 'high';   // Anthropic output_config.effort; ignored where unsupported
  cacheSystem?: boolean;                // Anthropic prompt caching on the system prompt
  timeoutMs?: number;                   // default 120 000; combined with `signal`
  signal?: AbortSignal;
  label?: string;                       // "decision", "author" — echoed to onCall, never sent
}

interface CompletionResult {
  text: string;
  json?: unknown;                       // present when `schema` was given and the text parsed
  toolCalls: ToolCall[];                // { id, name, args (parsed object) }
  finish: 'stop' | 'length' | 'tool_calls' | 'refusal' | 'error' | 'other';
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  provider: string; model: string; ms: number;
  warnings: Warning[];                  // see §6 — each one a lesson from Jarvis
}
```

The **model ref** is `provider:model`, split on the first colon, so model ids that contain colons
(`qwen3:8b`) survive. Providers are registered once:

```ts
const llm = createLlm({
  providers: {
    anthropic: anthropic({ apiKey }),
    openrouter: openrouter({ apiKey, appName: 'Jarvis', appUrl }),
    vllm: openaiCompatible({ baseUrl: 'http://gpu-box:8000/v1' }),
    ollama: ollama({ baseUrl: 'http://127.0.0.1:11434', numCtx: 32768 }),
  },
  onCall: (e) => log.info(e),           // { provider, model, label, ms, usage, finish, warnings, error? }
});
const r = await llm.complete({ model: 'openrouter:moonshotai/kimi-k2.7-code', ... });
```

## 6. What each provider must keep (the lessons, as tests)

| lesson (where Jarvis learned it) | provider(s) | behaviour | `warnings` |
|---|---|---|---|
| OpenRouter treats `response_format` as a soft preference and silently routes to an upstream that ignores it (6 of 43 author calls) | openrouter | always send `provider: { require_parameters: true }` with a schema | — |
| A strict schema can be refused (4xx naming schema / response_format / require_parameters / "no endpoints") | openrouter, openai-compatible | retry ONCE in `json_object` mode with the schema written into the system prompt; any other 4xx/5xx is an error | `schema_relaxed` |
| A reasoning model's answer can land in `reasoning` with `content` empty | openrouter, openai-compatible | fall back to the reasoning text | `reasoning_fallback` |
| Truncation at max tokens | all | `finish: 'length'` | `truncated` |
| A reply with no text at all is a budget or provider problem, not a choice | all | name it | `empty` |
| Some providers fence JSON in ```json despite the ask | all | fence-tolerant `extractJson` | — |
| Anthropic: `output_config.format` takes `{type, schema}` only (a `name` is rejected); 64K max output needs streaming | anthropic | stream → `finalMessage()`; no `name` sent | — |
| Ollama's OpenAI shim pins context at 4096 | ollama | native `/api/chat` with `options.num_ctx` | — |
| Qwen3 on Ollama spends the budget thinking unless told not to | ollama | `think: false` unless `thinking: 'adaptive'` | — |
| A cancel must abort the HTTP request, not just the next step | all | `signal` goes to `fetch` / the SDK | — |
| A 2m11s decision call had no timeout (Jarvis, 2026-09-27) | all | `timeoutMs` default 120 s; `LlmError('timeout')` | — |

**Errors:** `LlmError` has a `kind` of `auth`, `rate_limit`, `schema_rejected`, `bad_request`,
`server`, `timeout`, `aborted`, `network` or `parse`. It carries `status`, `provider` and `model`,
plus a detail cut to 300 characters. A secret is never put in a message.

## 7. System One

```ts
type SystemOneQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] };       // CLM; ordered levels

const jevTarget = jev({ apiKey, model: 'jev-latest' });               // https://openrouter.ai/api/v1/systemone
const clmTarget = clm({ url: 'http://127.0.0.1:8700/v1/systemone' }); // model clm-latest, no key
const r = await askSystemOne(clmTarget, state, { pattern: q }, { timeoutMs, signal });
// r: { answers, costUsd?, ms } — answers[k] = { choice | noul | score, confidence, probabilities }
```

- **The OpenRouter key goes to OpenRouter only.** `clm()` and any custom target never receive it.
  This is tested.
- **`confidence`** means the same thing on both servers: the top probability minus the mean of
  the rest (checked against CLM's `schema.py` and a logged Jev answer). The floor stays the
  caller's choice.
- `certainty` and `isYes` move here from Jarvis.

## 8. Testing

| tier | what |
|---|---|
| **Unit** | Each provider against a stubbed `fetch`, or an injected fake Anthropic SDK: the exact request body (schema, `require_parameters`, `think:false`, no `name` on Anthropic's format, tools), and every §6 row as its own test. Also error mapping, timeout, abort, and model-ref parsing (`ollama:qwen3:8b`). System One: request shape, key isolation, answer passthrough. |
| **Contract** | One table of requests (JSON with a schema, plain text, a tool call) through all four providers' fakes, asserting the same normalised `CompletionResult`. This keeps them from drifting apart. |
| **Live** (opt-in, `LIVE=1`) | Ollama on this Mac (`qwen3:4b`), free. The OpenAI-compatible provider against Ollama's `/v1`, which stands in for vLLM, since vLLM does not run on this Mac. OpenRouter and Jev: one call each, under $0.001. Anthropic: one small call. Keys are read from the environment and never printed. CLM, when the pilot's server is up. |

There is no E2E tier: this is a library with no client. Jarvis's own E2E covers it once Jarvis
switches over (§10).

## 9. Acceptance criteria

- [ ] `pnpm typecheck && pnpm test && pnpm lint` green on a clean clone.
- [ ] Every row of §6 has a unit test that fails without its behaviour.
- [ ] The contract table passes for all four providers.
- [ ] Live: Ollama structured JSON and a tool call; OpenAI-compatible against Ollama `/v1`;
      OpenRouter JSON with a schema; Anthropic JSON with a schema; Jev one choice question.
- [ ] A System One call to a non-OpenRouter target never carries the OpenRouter key.
- [ ] README: install, the four providers, System One, and the `onCall` hook.
- [ ] Private repo `Codewiz2898/llm-providers`: `main` holds only the scaffold, and the library
      arrives as a PR from a feature branch, for you to merge.

## 10. Build order

0. Scaffold and toolchain: package.json, tsconfig, biome, vitest; an empty test green. Initial
   commit on `main`.
1. `types`, `errors`, `json` (with `extractJson` tests).
2. `openaiCompatible`, which is the base for step 3, then `openrouter`.
3. `ollama`.
4. `anthropic`.
5. `createLlm`: registry, model refs, timeout, `onCall`.
6. `systemOne`.
7. Contract tests, live smoke, README.
8. Commits split by concern on `feat/initial-library`; create the private GitHub repo, push, open
   the PR.

**Phase 2, Jarvis on the library** (its own change, later). The Anthropic, OpenRouter and Ollama
clients become ~30-line adapters mapping `decide`, `authorFreeform` and the rest onto
`llm.complete` with Jarvis's schemas. `reportAiCall` becomes the `onCall` hook. `jev.ts` becomes
`askSystemOne`, and `JEV_URL` picks the target. Jarvis's existing tests and E2E are the safety net.

## 11. Seams

- **`warnings`** is an open list, so a new lesson is a new warning, not a new return type.
- **`onCall`** is where Jarvis's spans, metrics and cost ledger attach. The library never needs
  OpenTelemetry.
- **Model refs** allow a routing layer (Phase 3 fallbacks) to be a wrapper around `complete`.
- **`openaiCompatible`** takes `extraBody` and `headers`, which a provider-specific quirk can use
  without a fork (Together, Groq, a vLLM `guided_json`).

## 12. Risks

- **Two sources of truth during the gap.** Jarvis keeps its clients until Phase 2, so a fix in one
  may not reach the other. The §6 table is the checklist both follow until the switch.
- **vLLM is tested only through Ollama's OpenAI-compatible endpoint** on this Mac. vLLM's own
  handling of `response_format: json_schema` needs one live check on a GPU box before anything
  depends on it.
