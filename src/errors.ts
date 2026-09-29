/**
 * One error type for every provider, with a closed `kind` — because each kind calls for a different
 * response (retry later, fix the key, relax the schema, give up), and a caller should not have to
 * parse four vendors' messages to tell them apart.
 */
export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'schema_rejected'
  | 'bad_request'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'parse'
  /** The SERVICE refused the caller's app token (docs/GATEWAY.md §4) — distinct from `auth`, which is
   * a provider refusing the service's key. One is the app's configuration, the other the gateway's. */
  | 'unauthorized'
  /** The gateway does not let this app use this provider — Anthropic unless enabled (GATEWAY.md §4). */
  | 'forbidden'
  /** The app has spent its daily budget; calls resume at local midnight. Not a `rate_limit`: retrying
   * sooner cannot help. */
  | 'budget_exceeded';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: string;
  readonly model: string;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(o: {
    kind: LlmErrorKind;
    provider: string;
    model: string;
    status?: number;
    detail?: string;
    cause?: unknown;
  }) {
    const detail = o.detail === undefined ? undefined : redact(o.detail).slice(0, 300);
    super(
      `${o.provider} ${o.model}: ${o.kind}${o.status ? ` (HTTP ${o.status})` : ''}${detail ? ` — ${detail}` : ''}`,
      {
        cause: o.cause,
      },
    );
    this.name = 'LlmError';
    this.kind = o.kind;
    this.provider = o.provider;
    this.model = o.model;
    this.status = o.status;
    this.detail = detail;
  }
}

/** An HTTP failure, classified by status. A schema refusal is its own kind (DESIGN §6). */
export function errorFromStatus(
  status: number,
  detail: string,
  provider: string,
  model: string,
  schemaRejected = false,
): LlmError {
  const kind: LlmErrorKind = schemaRejected
    ? 'schema_rejected'
    : status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'server'
          : 'bad_request';
  return new LlmError({ kind, provider, model, status, detail });
}

/**
 * Error text comes back from servers that echo requests; a key must never ride along into a log.
 * Covers bearer tokens and the common key shapes (sk-…, sk-or-…, sk-ant-…).
 */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}
