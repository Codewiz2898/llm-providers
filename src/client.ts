/**
 * The front door: providers registered once, a model ref per call, one timeout rule, one hook.
 *
 *   const llm = createLlm({ providers: { openrouter: openrouter({ apiKey }) }, onCall: log });
 *   await llm.complete({ model: 'openrouter:moonshotai/kimi-k2.7-code', messages, maxTokens });
 *
 * The TIMEOUT is here, not in the providers, because only the client can tell a timeout from a
 * cancel: it made the timeout signal and received the caller's. A 2m11s decision call with no
 * timeout at all (Jarvis, 2026-09-27) is why there is a default.
 */
import { LlmError } from './errors.js';
import type {
  CompletionRequest,
  CompletionResult,
  Finish,
  Message,
  Provider,
  Usage,
  Warning,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 120_000;

/** What `onCall` receives — once per call, success or failure. Everything a log, a metric or a cost
 * ledger needs; the library itself logs nothing. */
export interface CallEvent {
  provider: string;
  model: string;
  label?: string;
  ms: number;
  ok: boolean;
  finish?: Finish;
  usage?: Usage;
  warnings?: Warning[];
  error?: { kind: LlmError['kind']; message: string };
}

export interface LlmOptions {
  providers: Record<string, Provider>;
  onCall?: (e: CallEvent) => void;
  /** Per-call default; a request's own `timeoutMs` wins. */
  timeoutMs?: number;
}

export interface Llm {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  readonly providers: readonly string[];
}

/** `provider:model`, split on the FIRST colon — `ollama:qwen3:8b` is provider `ollama`, model `qwen3:8b`. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) {
    throw new LlmError({
      kind: 'bad_request',
      provider: '?',
      model: ref,
      detail: `model must be "provider:model", e.g. "openrouter:moonshotai/kimi-k2.7-code" — got "${ref}"`,
    });
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function createLlm(o: LlmOptions): Llm {
  const names = Object.keys(o.providers);
  return {
    providers: names,
    async complete(req) {
      const { provider: key, model } = parseModelRef(req.model);
      const provider = o.providers[key];
      if (!provider) {
        throw new LlmError({
          kind: 'bad_request',
          provider: key,
          model,
          detail: `no provider "${key}" — registered: ${names.join(', ') || 'none'}`,
        });
      }
      const timeout = AbortSignal.timeout(req.timeoutMs ?? o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const { model: _ref, timeoutMs: _t, label, signal: _s, ...rest } = req;
      const started = Date.now();
      const emit = (e: Omit<CallEvent, 'provider' | 'model' | 'ms' | 'label'>) => {
        try {
          o.onCall?.({ provider: key, model, ...(label ? { label } : {}), ms: Date.now() - started, ...e });
        } catch {
          // A broken logger must never cost the call.
        }
      };
      try {
        if (req.signal?.aborted) throw new LlmError({ kind: 'aborted', provider: key, model });
        const r = await provider.complete(model, { ...rest, signal });
        const { raw, ...result } = r;
        const message: Message = {
          role: 'assistant',
          content: r.text,
          ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
          ...(raw !== undefined ? { raw: { provider: provider.id, content: raw } } : {}),
        };
        emit({ ok: true, finish: r.finish, usage: r.usage, warnings: r.warnings });
        return { ...result, message, provider: key, model, ms: Date.now() - started };
      } catch (e) {
        const err = classify(e, key, model, req.signal, timeout);
        emit({ ok: false, error: { kind: err.kind, message: err.message } });
        throw err;
      }
    },
  };
}

/** Whatever a provider threw, as an LlmError named after the REGISTERED provider. The signals decide
 * between a timeout and a cancel; nothing else can. */
function classify(
  e: unknown,
  key: string,
  model: string,
  user: AbortSignal | undefined,
  timeout: AbortSignal,
): LlmError {
  if (user?.aborted) return new LlmError({ kind: 'aborted', provider: key, model, cause: e });
  if (timeout.aborted) return new LlmError({ kind: 'timeout', provider: key, model, cause: e });
  if (e instanceof LlmError) {
    return e.provider === key
      ? e
      : new LlmError({
          kind: e.kind,
          provider: key,
          model,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
          cause: e,
        });
  }
  // fetch reports a refused connection or DNS failure as a TypeError.
  if (e instanceof TypeError)
    return new LlmError({ kind: 'network', provider: key, model, detail: e.message, cause: e });
  return new LlmError({
    kind: 'network',
    provider: key,
    model,
    detail: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}
