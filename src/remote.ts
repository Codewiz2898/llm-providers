/**
 * An `Llm` whose calls go to a running `llm-providers serve` — the TypeScript twin of the Python
 * client. The caller holds no model keys; the service does.
 *
 *   const llm = connectLlm({ url: 'http://127.0.0.1:8787', onCall });
 *   await llm.complete({ model: 'openrouter:moonshotai/kimi-k2.7-code', ... });  // refs pass through
 *   await llm.systemOne('jev', state, questions);
 *
 * What it keeps:
 *   - errors come back as LlmError with the service's kind, provider, model and status;
 *   - aborting `signal` closes the connection, and the service then aborts the upstream call;
 *   - the HTTP timeout is the request's own timeout plus slack, so the SERVICE reports a timeout
 *     precisely and this only catches a service that has hung;
 *   - `onCall` fires HERE, from the returned result — a caller's metrics never depend on the
 *     service's logs.
 */
import { type CallEvent, DEFAULT_TIMEOUT_MS, type Llm } from './client.js';
import { LlmError, type LlmErrorKind } from './errors.js';
import type { SystemOneQuestion, SystemOneResult } from './systemOne/index.js';
import type { CompletionRequest, CompletionResult } from './types.js';

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8787';

export interface ConnectOptions {
  /** Default `http://127.0.0.1:8787`. */
  url?: string;
  /** The service's LLM_PROVIDERS_TOKEN, when it set one. */
  token?: string;
  onCall?: (e: CallEvent) => void;
  /** A request without `timeoutMs` gets the service's default; this mirrors it for the HTTP timeout. */
  timeoutMs?: number;
  /** Added to a call's timeout to make the HTTP timeout. Default 10 s. */
  slackMs?: number;
  fetch?: typeof fetch;
}

export interface ServiceHealth {
  ok: boolean;
  providers: string[];
  systemOne: string[];
}

export interface RemoteLlm extends Llm {
  readonly url: string;
  systemOne(
    target: string,
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SystemOneResult>;
  /** What the service serves. Also refreshes `providers`. */
  health(): Promise<ServiceHealth>;
}

const KINDS = new Set<LlmErrorKind>([
  'auth',
  'rate_limit',
  'schema_rejected',
  'bad_request',
  'server',
  'timeout',
  'aborted',
  'network',
  'parse',
]);

export function connectLlm(o: ConnectOptions = {}): RemoteLlm {
  const url = (o.url ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const slack = o.slackMs ?? 10_000;
  const providers: string[] = [];

  /** One request to the service; every failure becomes an LlmError of the right kind. */
  async function call(
    path: string,
    body: unknown,
    who: { provider: string; model: string },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs + slack);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: combined,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      if (signal?.aborted) throw new LlmError({ kind: 'aborted', ...who, cause: e });
      if (timeout.aborted) {
        throw new LlmError({
          kind: 'timeout',
          ...who,
          detail: `no reply from the llm-providers service at ${url}`,
          cause: e,
        });
      }
      throw new LlmError({
        kind: 'network',
        ...who,
        detail: `llm-providers service unreachable at ${url} — start it with \`llm-providers serve\``,
        cause: e,
      });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new LlmError({
        kind: 'parse',
        ...who,
        status: res.status,
        detail: 'service reply was not JSON',
        cause: e,
      });
    }
    if (!res.ok) {
      const err = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
      const kind = KINDS.has(err.kind as LlmErrorKind) ? (err.kind as LlmErrorKind) : 'server';
      throw new LlmError({
        kind,
        provider: typeof err.provider === 'string' ? err.provider : who.provider,
        model: typeof err.model === 'string' ? err.model : who.model,
        ...(typeof err.status === 'number' ? { status: err.status } : {}),
        detail: String(err.detail ?? err.message ?? `HTTP ${res.status}`),
      });
    }
    return json;
  }

  const emit = (e: CallEvent) => {
    try {
      o.onCall?.(e);
    } catch {
      // A broken logger must never cost the call.
    }
  };

  return {
    url,
    providers,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const { signal, ...wire } = req;
      const i = req.model.indexOf(':');
      const who = {
        provider: i > 0 ? req.model.slice(0, i) : 'service',
        model: i > 0 ? req.model.slice(i + 1) : req.model,
      };
      const started = Date.now();
      try {
        const r = (await call(
          '/v1/complete',
          wire,
          who,
          signal,
          req.timeoutMs ?? o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )) as CompletionResult;
        emit({
          provider: r.provider,
          model: r.model,
          ...(req.label ? { label: req.label } : {}),
          ms: Date.now() - started,
          ok: true,
          finish: r.finish,
          usage: r.usage,
          warnings: r.warnings,
        });
        return r;
      } catch (e) {
        const err = e as LlmError;
        emit({
          ...who,
          ...(req.label ? { label: req.label } : {}),
          ms: Date.now() - started,
          ok: false,
          error: { kind: err.kind, message: err.message },
        });
        throw e;
      }
    },
    async systemOne(target, state, questions, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      return (await call(
        '/v1/systemone',
        { target, state, questions, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
        { provider: `system-one:${target}`, model: target },
        opts.signal,
        timeoutMs,
      )) as SystemOneResult;
    },
    async health() {
      const h = (await call(
        '/health',
        undefined,
        { provider: 'service', model: '' },
        undefined,
        5_000,
      )) as ServiceHealth;
      providers.splice(0, providers.length, ...h.providers);
      return h;
    },
  };
}
