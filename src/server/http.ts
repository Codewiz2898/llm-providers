/**
 * The library over HTTP, so a Python program — or anything else — calls the SAME implementation
 * (docs/SERVICE.md). The wire is the library's own contract: a CompletionRequest in, a
 * CompletionResult out, with nothing renamed.
 *
 * What it keeps:
 *   - a CANCEL CROSSES THE BOUNDARY: when the HTTP client goes away, the upstream call is aborted,
 *     so a Python timeout stops the model call rather than leaving it running and billing;
 *   - it binds to loopback, and will not listen anywhere else without a token;
 *   - one log line per call — never a body, never a key.
 */
import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type CallEvent, createLlm } from '../client.js';
import { LlmError, type LlmErrorKind } from '../errors.js';
import { askSystemOne } from '../systemOne/index.js';
import type { CompletionRequest } from '../types.js';
import { type Built, ConfigError } from './config.js';

export const DEFAULT_PORT = 8787;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

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
};

export interface ServiceOptions {
  host?: string;
  port?: number;
  /** Bearer token every request must carry. Required to listen on anything but loopback. */
  token?: string;
  maxBodyBytes?: number;
  /** One line per call. Default: stderr. */
  log?: (line: string) => void;
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

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
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
  const llm = createLlm({
    providers: built.providers,
    onCall: (e: CallEvent) =>
      log(
        `llm-providers call ${fmt({ provider: e.provider, model: e.model, label: e.label, ms: e.ms, ok: e.ok, finish: e.finish, warnings: e.warnings, error: e.error?.kind })}`,
      ),
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (o.token && !authorized(req.headers.authorization, o.token)) {
      return send(res, 401, errorBody('auth', 'missing or wrong bearer token'));
    }
    const path = new URL(req.url ?? '/', 'http://service').pathname;
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, providers: llm.providers, systemOne: Object.keys(built.systemOne) });
    }
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
      const r = await llm.complete({ ...(body as unknown as CompletionRequest), signal: ac.signal });
      return send(res, 200, r);
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
    const started = Date.now();
    try {
      const r = await askSystemOne(target, body.state, body.questions as never, {
        signal: ac.signal,
        ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      });
      log(
        `llm-providers system-one ${fmt({ target: name, model: target.model, ms: Date.now() - started, ok: true })}`,
      );
      return send(res, 200, r);
    } catch (e) {
      log(
        `llm-providers system-one ${fmt({ target: name, model: target.model, ms: Date.now() - started, ok: false, error: e instanceof LlmError ? e.kind : 'server' })}`,
      );
      throw e;
    }
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
  if (!LOOPBACK.has(host) && !o.token) {
    throw new ConfigError(
      `refusing to listen on ${host} without a token — set LLM_PROVIDERS_TOKEN, or keep the default 127.0.0.1`,
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
