# The gateway — one llm-providers service for every app

> Status: **approved 2026-09-29; building.** Steps 2 (app identity, per-request attribution) and
> 3 (telemetry, Python `traceparent`) are built and tested; the library is 0.3.0. Phase 3 of llm-providers (DESIGN §10), after the service and its clients
> (SERVICE.md). It stacks on #3 (`connectLlm`).

## 1. Decided (2026-09-29)

| question | answer |
|---|---|
| Where does the one service run? | **This Mac, always on** — a launchd agent, loopback only. It can move to a server later without any app changing more than a URL. |
| Provider keys and per-app spend? | **One key set; the gateway attributes.** Every app calls with its own app token; the gateway tags every call with the app, so per-app spend comes from the gateway itself. |
| Where does observability live? | **The Grafana stack** (the `grafana/otel-lgtm` image already running for Jarvis). The gateway exports OpenTelemetry; one LLM dashboard for every app. |
| Prompts and responses? | **Metadata always; text only on opt-in**, per app or per call. |

## 2. Shape

```
 jarvis-server (TS)      sports-follow (Python)      notebooks / scripts
   connectLlm              llm_providers.Client         either client
   token: jarvis           token: sports-follow         token: scripts
        \                        |                        /
         \______________ HTTP + traceparent _____________/
                                 |
                    llm-gateway  127.0.0.1:8787   (launchd, always on)
                    one config · one keys file · app identity · OTel
                                 |
        OpenRouter · Anthropic · Ollama · Jev · CLM · any OpenAI-compatible server
                                 |
                          OTLP (127.0.0.1:4318)
                                 v
          Grafana LGTM   — metrics (Prometheus) · traces (Tempo) · logs (Loki)
          :3001           dashboards: "LLM gateway" (all apps) + each app's own
```

Each app also sends its OWN telemetry to the same collector, so in Tempo a Jarvis turn's trace
continues into the gateway's span and on into the upstream call — one trace, two processes.

## 3. Where things live

| what | where | why |
|---|---|---|
| The gateway's code | **llm-providers** (this repo) | It is the service, grown: app identity and telemetry are features of `serve`. |
| Shared infrastructure | **a new private repo, `platform`** | The Grafana stack serves every app, not just LLM calls, so it cannot stay inside Jarvis. It holds: the compose file for LGTM, every Grafana dashboard, the gateway's config, the launchd agent, and a `gateway` script. |
| Keys and app tokens | `~/.config/llm-providers/keys.env` (mode 600) | Never in a repo. The central file already exists. |
| An app | its own repo | Only a URL and its token (`LLM_PROVIDERS_URL`, `LLM_PROVIDERS_TOKEN`) plus a client version. No provider config, no keys. |

**The gateway runs its own install, not an app's `node_modules`.** It is installed from a pinned
llm-providers ref into `~/.local/share/llm-gateway/`. Bumping Jarvis's client pin never changes the
running gateway, and upgrading the gateway never touches an app. The HTTP contract (`/v1`) is
what they share, and it only grows backward-compatibly.

## 4. App identity

The config gains an `apps` section. A token is named by environment variable, never written in the
file — the same rule as provider keys:

```json
{
  "providers": {
    "openrouter": { "type": "openrouter" },
    "anthropic":  { "type": "anthropic" },
    "ollama":     { "type": "ollama", "numCtx": 32768 }
  },
  "systemOne": {
    "jev": { "type": "jev" },
    "clm": { "type": "clm", "url": "http://127.0.0.1:8700/v1/systemone" }
  },
  "apps": {
    "jarvis":        { "tokenEnv": "JARVIS_GATEWAY_TOKEN", "title": "Jarvis" },
    "sports-follow": { "tokenEnv": "SPORTS_FOLLOW_GATEWAY_TOKEN", "title": "Sports Follow" },
    "scripts":       { "tokenEnv": "SCRIPTS_GATEWAY_TOKEN", "capturePrompts": true }
  },
  "telemetry": { "otlpEndpoint": "http://127.0.0.1:4318", "promptMaxChars": 65536 }
}
```

- **Every request carries `Authorization: Bearer <app token>`.** The gateway resolves it to the
  app, and every metric, span and log line carries `app`. An unknown token is `401` (a new
  `unauthorized` error kind). No `apps` section keeps today's behaviour, so nothing breaks
  mid-migration.
- **Tokenless calls on loopback** are accepted as app `anonymous` unless the config turns that
  off, so a quick notebook still works — and still shows up, labelled as what it is.
- **One provider key set** (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). OpenRouter still sees
  which app called: the gateway sends the app's `title` as OpenRouter's app-attribution header on
  each request, so OpenRouter's own activity page splits by app too. That is one library change:
  the OpenRouter provider's app name becomes per-request.
- **`/health` stays open** (names only, no secrets); everything else needs a token.

## 5. Observability

The gateway initialises the OpenTelemetry Node SDK when `telemetry.otlpEndpoint` is set, with
`service.name = llm-gateway`. The dependency belongs to the server entry only: code that imports
the library for `createLlm` pays nothing.

**Metrics** — labels `app`, `provider`, `model`, `kind` (the request's `label`), `outcome`
(`ok` or an error kind):

| metric | type | notes |
|---|---|---|
| `llm_calls_total` | counter | |
| `llm_call_duration_seconds` | histogram | buckets to 300 s — a 2-minute decision is normal for Jarvis |
| `llm_tokens_total` | counter | `direction` = input, output, cache_read, cache_write |
| `llm_cost_usd_total` | counter | where the provider reports cost (OpenRouter does; Anthropic does not — see §9) |
| `llm_warnings_total` | counter | `warning` = truncated, reasoning_fallback, schema_relaxed, empty, … |
| `llm_inflight` | up-down counter | per app |
| `systemone_calls_total`, `systemone_duration_seconds`, `systemone_cost_usd_total` | | `target` instead of provider/model |

**Traces.** One span per call (`llm.complete`, `llm.systemone`) with the GenAI semantic-convention
attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, …) plus
`app.id` and `llm.kind`. The incoming `traceparent` is honoured, so the span is a child of the
caller's. Jarvis's auto-instrumented `fetch` already sends it; the Python client adds it when the
caller has OpenTelemetry, and does nothing when it does not.

**Logs.** One structured record per call to Loki — the metric labels plus tokens, cost, finish,
warnings, error message and `trace_id` — so a Grafana panel can jump from a slow call to its
trace. The stderr line stays, for `gateway logs` without Grafana.

**Prompt text, opt-in only.** When the app has `capturePrompts: true`, or a request sets
`capture: true`, the call's log record also carries the system prompt, the messages and the reply,
each cut to `promptMaxChars`. Never on a span (Tempo is not for payloads), never a key, and never
by default. Captured records carry `captured=true` so a Loki retention rule can keep them short.

**The dashboard** ("LLM gateway", provisioned from `platform`): calls and errors by app; p50/p95
latency by model and kind; tokens and cost per app per day; warnings; System One; the slowest calls
this hour with links to their traces and logs.

**Jarvis keeps its app-level metrics** (prompt size, decision parse failures, turn outcomes). They
mean something only to Jarvis. The transport numbers move to the gateway, where every app gets
them for free.

## 6. Running it

```bash
cd ~/repos/platform
./gateway install v0.3.0      # npm-installs llm-providers@v0.3.0 into ~/.local/share/llm-gateway
./gateway start               # loads the launchd agent: RunAtLoad, KeepAlive
./gateway status              # launchd state + /health
./gateway logs                # tail ~/Library/Logs/llm-gateway.log
./gateway restart             # after a config or keys change
docker compose up -d          # Grafana LGTM, now in platform — http://127.0.0.1:3001
```

The agent runs
`node --env-file=~/.config/llm-providers/keys.env ~/.local/share/llm-gateway/…/cli.js serve --config ~/repos/platform/llm-gateway/gateway.json`.

**New app checklist:** add it under `apps` with a `tokenEnv`; put a fresh random token in
`keys.env` (`./gateway new-app sports-follow` does both); `./gateway restart`; give the app
`LLM_PROVIDERS_TOKEN`. The dashboard needs no change — `app` is a label.

## 7. What changes where

| repo | change |
|---|---|
| **llm-providers** | `apps` config and per-app tokens (`unauthorized` kind); per-request OpenRouter attribution; OpenTelemetry metrics, spans and log records on the server; `traceparent` in the Python client; opt-in prompt capture; `telemetry` config. Version 0.3.0. |
| **platform** (new) | compose file with LGTM (moved from Jarvis; ports bound to 127.0.0.1), Grafana dashboards (LLM gateway + Jarvis overview, moved), `llm-gateway/gateway.json`, launchd plist, the `gateway` script, `keys.env.example`. |
| **Jarvis** | Loses `pnpm llm`, `llm-providers.json` and the LGTM service in its compose file. Gains `LLM_PROVIDERS_TOKEN` (its app token). Its dashboard moves to `platform`. `OTEL_EXPORTER_OTLP_ENDPOINT` is unchanged — the collector is the same one. |
| **sports-follow** | Starts with a URL, a token and a client. |

**Keys file after the move:** `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` (the one set — the
`JARVIS_…` names from today's interim change go), plus one `…_GATEWAY_TOKEN` per app.

## 8. Security

- Loopback only. Moving off this Mac means a TLS front and nothing else — tokens already exist.
- **The LGTM ports move to 127.0.0.1.** Today's compose publishes Grafana (3001) and the OTLP
  receivers (4317/4318) on every interface, so anyone on the same Wi-Fi can read the dashboards and
  push telemetry. That is tolerable for metrics and not for captured prompts.
- Keys and tokens only in `keys.env` (600), read only by the gateway. Tokens are compared in
  constant time and never logged.
- Prompt capture is off unless an app or a call asks; captured records are marked and short-lived.

## 9. Scope

**Deferred, with where they would plug in:**

| deferred | seam |
|---|---|
| Per-app daily budgets on actual cost | `apps.<id>.budgetUsdDaily`; the gateway already sums `llm_cost_usd_total` per app. Would replace Jarvis's estimate-based ledger. |
| Anthropic cost (Anthropic reports tokens, not dollars) | a price table in config → `llm_cost_usd_total` for providers that do not report it |
| Per-app model allowlists and rate limits | `apps.<id>.models`, `apps.<id>.rpm` |
| Hosting off this Mac | a TLS front; `--host` already refuses to start without tokens |
| Response caching | a gateway concern, keyed by request hash — only if a real app needs it |

## 10. Testing

| tier | what |
|---|---|
| **llm-providers unit** | token → app; unknown token 401; `anonymous` on loopback and its off switch; no `apps` = today's behaviour. Metrics and spans against an in-memory OTel exporter: every label, the histogram buckets, the span's parent from an incoming `traceparent`. Prompt capture on and off; a key never appears in any record. OpenRouter's per-request attribution header. |
| **Python** | `traceparent` sent when OpenTelemetry is active, nothing when it is not; the token on every call. |
| **platform smoke** | `gateway status`; one call as each app token; then ask Prometheus for `llm_calls_total{app=…}` and Tempo for the trace. |
| **Jarvis** | Unchanged suites (they never reach a model). Live: one turn → the dashboard shows `app=jarvis`, and the turn's trace in Tempo contains the gateway span. |
| **Second app** | A few lines of Python as `sports-follow` → its own line on the dashboard. That is the proof the ecosystem works. |

## 11. Acceptance

- [ ] The gateway starts at login and restarts on crash; `gateway status` says so.
- [ ] Jarvis and a second app call it with their own tokens; an unknown token is refused.
- [ ] Grafana's "LLM gateway" dashboard shows calls, latency, tokens, cost and errors per app.
- [ ] A Jarvis turn's trace contains the gateway span and the upstream call.
- [ ] Prompt text appears in Loki only for an opted-in app or call; no key appears anywhere.
- [ ] No app holds a provider key; Jarvis holds only its gateway token.
- [ ] Grafana and OTLP are reachable on 127.0.0.1 only.

## 12. Build order (gates are yours)

0. **Prereqs:** Docker running; Node 20; the central keys file (exists).
1. **This doc → your review.**
2. **llm-providers:** app identity + per-request OpenRouter attribution. PR.
3. **llm-providers:** telemetry (metrics, spans, logs, prompt capture) + Python `traceparent`. PR;
   tag `v0.3.0`.
4. **platform** (new private repo — creating it is yours to approve): compose moved and
   loopback-bound, dashboards, gateway config, launchd agent, `gateway` script.
5. **Jarvis:** point at the gateway with its token; remove its own service script, config and the
   LGTM service. PR.
6. **Verify live:** a Jarvis turn and a `sports-follow` call, both on the dashboard, one trace
   end to end.

## 13. Risks

- **One process for every app's AI.** If the gateway is down, every app's model calls fail. launchd
  restarts it, each app's startup line says so loudly (Jarvis's already does), and the failure is
  `network`, never silent.
- **Label cardinality.** `model` is whatever an app asks for. Fine for a handful of apps; if it
  ever grows, the gateway can bucket models it has not seen before.
- **Docker for observability.** Without Docker there are no dashboards — but the gateway keeps
  working and logging to stderr; telemetry is never on the request path.
