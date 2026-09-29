/**
 * The library over HTTP, so a Python program — or anything else — calls the SAME implementation
 * (docs/SERVICE.md). The wire is the library's own contract: a CompletionRequest in, a
 * CompletionResult out, with nothing renamed.
 *
 * What it keeps:
 *   - a CANCEL CROSSES THE BOUNDARY: when the HTTP client goes away, the upstream call is aborted,
 *     so a Python timeout stops the model call rather than leaving it running and billing;
 *   - it binds to loopback, and will not listen anywhere else without a token;
 *   - one record per call — never a body, never a key — as a log line and to `onRecord`;
 *   - with `apps` (docs/GATEWAY.md §4), every call is labelled with the app whose token it carried,
 *     and the app — not the caller's body — decides the attribution a provider sees.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlm } from '../client.js';
import { LlmError, type LlmErrorKind } from '../errors.js';
import { askSystemOne } from '../systemOne/index.js';
import type { CompletionRequest, Finish, Usage, Warning } from '../types.js';
import { ANONYMOUS, type App, type Built, ConfigError } from './config.js';

export const DEFAULT_PORT = 8787;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

/** The upstream's failure is a 502 — the caller's request was fine, the model's side was not. */
export const STATUS_FOR_KIND: Record<LlmErrorKind, number> = {
  bad_request: 400,
  rate_limit: 429,
  timeout: 504,
  aborted: 499,
  auth: 502,
  schema_rejected: 502,
  server: 502,
  network: 502,
  parse: 502,
  unauthorized: 401,
};

export interface ServiceOptions {
  host?: string;
  port?: number;
  /**
   * One shared bearer token every request must carry — for a service WITHOUT `apps`. With apps,
   * each app has its own (config `apps.<id>.tokenEnv`), and this is refused.
   */
  token?: string;
  maxBodyBytes?: number;
  /** One line per call. Default: stderr. */
  log?: (line: string) => void;
  /** Every call, once, success or failure — what telemetry is built from. */
  onRecord?: (r: CallRecord) => void;
  /** Spans, metrics and log records (server/telemetry.ts). Absent: none, and no OTel loaded. */
  telemetry?: ServiceTelemetry;
}

/**
 * What the service needs from telemetry. Implemented by server/telemetry.ts and loaded only when a
 * config asks for it, so this file — and everything that imports the library — carries no
 * OpenTelemetry dependency at run time.
 */
export interface ServiceTelemetry {
  /** Runs one call as a span, a child of the caller's `traceparent` when it sent one. */
  span<T>(
    name: 'llm.complete' | 'llm.systemone',
    headers: IncomingHttpHeaders,
    run: (span: unknown) => Promise<T>,
  ): Promise<T>;
  /** Once per call: its metrics, the span's attributes and status, one log record. */
  record(r: CallRecord, span: unknown, captured?: Captured): void;
  /** Calls in progress, per app. */
  inflight(app: string, delta: 1 | -1): void;
}

/** A call's text, recorded only when its app or the call itself opted in (docs/GATEWAY.md §5). */
export interface Captured {
  system?: string;
  messages?: unknown;
  tools?: unknown;
  reply?: string;
  toolCalls?: unknown;
  state?: unknown;
  questions?: unknown;
  answers?: unknown;
}

/** One call through the service: who asked, what answered, how it went. Never a body, never a key. */
export interface CallRecord {
  type: 'complete' | 'systemone';
  /** The app whose token the call carried; `anonymous` without one. */
  app: string;
  /** `complete`: the provider; `systemone`: the target's name. */
  provider: string;
  model: string;
  label?: string;
  ms: number;
  ok: boolean;
  finish?: Finish;
  usage?: Usage;
  warnings?: Warning[];
  error?: { kind: LlmErrorKind; message: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

/** `detail` is the underlying reason alone, so a client rebuilding the LlmError does not prefix
 * "provider model: kind" twice; `message` is the whole sentence, for anything that just shows it. */
function errorBody(
  kind: LlmErrorKind,
  message: string,
  provider = 'service',
  model = '',
  status?: number,
  detail?: string,
) {
  return {
    error: {
      kind,
      message,
      provider,
      model,
      ...(status !== undefined ? { status } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
  };
}

const bearer = (header: string | undefined) => (header?.startsWith('Bearer ') ? header.slice(7) : undefined);

function same(given: string, want: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'bad_request', `request body over ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'request body is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'bad_request', 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

const fmt = (fields: Record<string, unknown>) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');

export function createService(built: Built, o: ServiceOptions = {}): Server {
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const max = o.maxBodyBytes ?? 10 * 1024 * 1024;
  const llm = createLlm({ providers: built.providers });
  const apps = built.apps ? Object.values(built.apps) : undefined;
  if (apps && o.token)
    throw new ConfigError(
      'a service with "apps" gives each app its own token (apps.<id>.tokenEnv) — unset LLM_PROVIDERS_TOKEN',
    );
  // Tokenless calls are only ever loopback, and only if the config allows them.
  const anonymousOk = Boolean(built.allowAnonymous ?? true) && LOOPBACK.has(o.host ?? '127.0.0.1');

  const record = (r: CallRecord, span?: unknown, captured?: Captured) => {
    const line =
      r.type === 'complete'
        ? `llm-providers call ${fmt({ app: r.app, provider: r.provider, model: r.model, label: r.label, ms: r.ms, ok: r.ok, finish: r.finish, warnings: r.warnings, error: r.error?.kind })}`
        : `llm-providers system-one ${fmt({ app: r.app, target: r.provider, model: r.model, label: r.label, ms: r.ms, ok: r.ok, error: r.error?.kind })}`;
    log(line);
    try {
      o.onRecord?.(r);
      o.telemetry?.record(r, span, captured);
    } catch {
      // Telemetry must never cost a call.
    }
  };

  /** Run one call inside its span, counted in flight — or just run it, without telemetry. */
  const traced = async <T>(
    name: 'llm.complete' | 'llm.systemone',
    req: IncomingMessage,
    appId: string,
    run: (span?: unknown) => Promise<T>,
  ): Promise<T> => {
    const t = o.telemetry;
    if (!t) return run();
    t.inflight(appId, 1);
    try {
      return await t.span(name, req.headers, run);
    } finally {
      t.inflight(appId, -1);
    }
  };

  /** Who is calling. Throws a 401 for a token that matches no app — never a fallback to anonymous. */
  function identify(req: IncomingMessage): App | undefined {
    const given = bearer(req.headers.authorization);
    if (apps) {
      if (given !== undefined) {
        // Every app is compared, so the time taken says nothing about which one nearly matched.
        let found: App | undefined;
        for (const a of apps) if (same(given, a.token)) found = a;
        if (found) return found;
        throw new HttpError(401, 'unauthorized', 'unknown app token');
      }
      if (anonymousOk) return undefined;
      throw new HttpError(
        401,
        'unauthorized',
        'this gateway needs an app token — send "Authorization: Bearer <token>" (apps.<id>.tokenEnv)',
      );
    }
    if (o.token && (given === undefined || !same(given, o.token)))
      throw new HttpError(401, 'unauthorized', 'missing or wrong bearer token');
    return undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://service').pathname;
    // Open: names only, no secrets — so `gateway status` and an app's startup line need no token.
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        ok: true,
        providers: llm.providers,
        systemOne: Object.keys(built.systemOne),
        ...(apps ? { apps: apps.map((a) => a.id) } : {}),
      });
    }
    const app = identify(req);
    const appId = app?.id ?? ANONYMOUS;
    if (req.method !== 'POST' || (path !== '/v1/complete' && path !== '/v1/systemone')) {
      return send(res, 404, errorBody('bad_request', `no route ${req.method} ${path}`));
    }
    const body = await readJson(req, max);
    // The client hanging up before the reply is a cancel: stop the model call too.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    if (path === '/v1/complete') {
      if (
        typeof body.model !== 'string' ||
        !Array.isArray(body.messages) ||
        typeof body.maxTokens !== 'number'
      ) {
        throw new HttpError(
          400,
          'bad_request',
          'a completion needs "model" (provider:model), "messages" and "maxTokens"',
        );
      }
      // The APP decides the attribution, never the body: one app must not label its calls as another's.
      const { attribution: _claimed, capture: askedCapture, ...asked } = body as unknown as CompletionRequest;
      const label = typeof asked.label === 'string' ? asked.label : undefined;
      // Prompt text is recorded only on opt-in — the app's, or this call's.
      const capture = Boolean(o.telemetry && (app?.capturePrompts || askedCapture === true));
      const prompt = (): Captured => ({
        ...(asked.system !== undefined ? { system: asked.system } : {}),
        messages: asked.messages,
        ...(asked.tools ? { tools: asked.tools } : {}),
      });
      return traced('llm.complete', req, appId, async (span) => {
        const started = Date.now();
        try {
          const r = await llm.complete({
            ...asked,
            ...(app ? { attribution: { title: app.title, ...(app.url ? { url: app.url } : {}) } } : {}),
            signal: ac.signal,
          });
          record(
            {
              type: 'complete',
              app: appId,
              provider: r.provider,
              model: r.model,
              ...(label ? { label } : {}),
              ms: r.ms,
              ok: true,
              finish: r.finish,
              usage: r.usage,
              warnings: r.warnings,
            },
            span,
            capture
              ? { ...prompt(), reply: r.text, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) }
              : undefined,
          );
          return send(res, 200, r);
        } catch (e) {
          const err = e instanceof LlmError ? e : undefined;
          record(
            {
              type: 'complete',
              app: appId,
              provider: err?.provider ?? '?',
              model: err?.model ?? String(asked.model),
              ...(label ? { label } : {}),
              ms: Date.now() - started,
              ok: false,
              error: { kind: err?.kind ?? 'server', message: e instanceof Error ? e.message : String(e) },
            },
            span,
            capture ? prompt() : undefined,
          );
          throw e;
        }
      });
    }

    const name = body.target;
    const target = typeof name === 'string' ? built.systemOne[name] : undefined;
    if (!target) {
      throw new HttpError(
        400,
        'bad_request',
        `no System One target "${String(name)}" — configured: ${Object.keys(built.systemOne).join(', ') || 'none'}`,
      );
    }
    if (!body.questions || typeof body.questions !== 'object')
      throw new HttpError(400, 'bad_request', 'a System One call needs "questions"');
    const label = typeof body.label === 'string' ? body.label : undefined;
    const capture = Boolean(o.telemetry && (app?.capturePrompts || body.capture === true));
    return traced('llm.systemone', req, appId, async (span) => {
      const started = Date.now();
      try {
        const r = await askSystemOne(target, body.state, body.questions as never, {
          signal: ac.signal,
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        });
        record(
          {
            type: 'systemone',
            app: appId,
            provider: String(name),
            model: target.model,
            ...(label ? { label } : {}),
            ms: Date.now() - started,
            ok: true,
            ...(r.costUsd !== undefined ? { usage: { costUsd: r.costUsd } } : {}),
          },
          span,
          capture ? { state: body.state, questions: body.questions, answers: r.answers } : undefined,
        );
        return send(res, 200, r);
      } catch (e) {
        record(
          {
            type: 'systemone',
            app: appId,
            provider: String(name),
            model: target.model,
            ...(label ? { label } : {}),
            ms: Date.now() - started,
            ok: false,
            error: {
              kind: e instanceof LlmError ? e.kind : 'server',
              message: e instanceof Error ? e.message : String(e),
            },
          },
          span,
          capture ? { state: body.state, questions: body.questions } : undefined,
        );
        throw e;
      }
    });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, errorBody(e.kind, e.message));
      if (e instanceof LlmError) {
        return send(
          res,
          STATUS_FOR_KIND[e.kind],
          errorBody(e.kind, e.message, e.provider, e.model, e.status, e.detail),
        );
      }
      send(res, 500, errorBody('server', e instanceof Error ? e.message : String(e)));
    });
  });
}

export interface RunningService {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Listen. Refuses a non-loopback host without a token — an open model proxy spends your keys. */
export async function startService(built: Built, o: ServiceOptions = {}): Promise<RunningService> {
  const host = o.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && !o.token && !built.apps) {
    throw new ConfigError(
      `refusing to listen on ${host} without tokens — configure "apps" (or set LLM_PROVIDERS_TOKEN), or keep the default 127.0.0.1`,
    );
  }
  const server = createService(built, o);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? DEFAULT_PORT, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
