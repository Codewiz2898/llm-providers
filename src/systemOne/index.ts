/**
 * SYSTEM ONE — a model that does not generate. It reads a state and answers typed questions with a
 * probability distribution over the options it was given, so an answer outside them cannot happen.
 *
 * Two servers speak this wire format today:
 *   - Jev (TypeSafe), billed through OpenRouter's `/api/v1/systemone`;
 *   - CLM (Contrastive-LM, Apache 2.0), self-hosted with `clm-serve` at `/v1/systemone`.
 *
 * The OpenRouter key goes to OpenRouter ONLY. `clm()` and any other target carry their own key or
 * none — a self-hosted server has no business receiving it.
 */
import { LlmError, errorFromStatus } from '../errors.js';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Keys are the options; values describe them to the model. */
  criteria: Record<string, string>;
}
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}
/** Ordered levels, lowest first. Served by CLM. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}
export type SystemOneQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneAnswer {
  type: string;
  /** `choice`: always one of the criteria keys. */
  choice?: string;
  /** `noul`: P(true). */
  noul?: number;
  /** `score`: the chosen level's index. */
  score?: number;
  /** Top probability minus the mean of the rest — the same definition on Jev and CLM. */
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface SystemOneTarget {
  url: string;
  model: string;
  apiKey?: string;
}

export const OPENROUTER_SYSTEMONE_URL = 'https://openrouter.ai/api/v1/systemone';

/** Jev on OpenRouter. */
export function jev(o: { apiKey: string; model?: string; url?: string }): SystemOneTarget {
  return { url: o.url ?? OPENROUTER_SYSTEMONE_URL, model: o.model ?? 'jev-latest', apiKey: o.apiKey };
}

/** A self-hosted CLM (`clm-serve`). `apiKey` is CLM's OWN key (`CLM_API_KEY`), if it set one. */
export function clm(o: { url?: string; model?: string; apiKey?: string } = {}): SystemOneTarget {
  return {
    url: o.url ?? 'http://127.0.0.1:8700/v1/systemone',
    model: o.model ?? 'clm-latest',
    ...(o.apiKey ? { apiKey: o.apiKey } : {}),
  };
}

export interface SystemOneResult {
  answers: Record<string, SystemOneAnswer>;
  costUsd?: number;
  ms: number;
}

/**
 * One round trip; several questions about one state cost ONE call. Throws `LlmError` — a caller that
 * must never lose a turn catches it and falls back, which is Jarvis's rule and belongs in Jarvis.
 */
export async function askSystemOne(
  target: SystemOneTarget,
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  opts: { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<SystemOneResult> {
  const provider = 'system-one';
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const started = Date.now();
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target.url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: target.model, state, questions }),
    });
  } catch (e) {
    const kind = opts.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
    throw new LlmError({
      kind,
      provider,
      model: target.model,
      detail: e instanceof Error ? e.message : String(e),
      cause: e,
    });
  }
  if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''), provider, target.model);
  const j = (await res.json()) as { answers?: Record<string, SystemOneAnswer>; usage?: { cost?: number } };
  if (!j.answers)
    throw new LlmError({ kind: 'parse', provider, model: target.model, detail: 'reply had no answers' });
  return {
    answers: j.answers,
    ...(j.usage?.cost !== undefined ? { costUsd: j.usage.cost } : {}),
    ms: Date.now() - started,
  };
}

/**
 * How sure an answer is, on one 0..1 scale for every question type. A `noul` carries no
 * `confidence` (verified on Jev's raw replies): for a binary the probability IS the certainty, so
 * the distance from a coin flip is the measure.
 */
export function certainty(a: SystemOneAnswer): number {
  if (a.noul !== undefined) return Math.abs(a.noul - 0.5) * 2;
  return a.confidence ?? 0;
}

export function isYes(a: SystemOneAnswer): boolean {
  return (a.noul ?? 0) >= 0.5;
}
