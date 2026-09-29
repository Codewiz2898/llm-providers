import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../src/errors.js';
import { ConfigError, buildConfig, configFromEnv, parseConfig } from '../../src/server/config.js';
import { type RunningService, startService } from '../../src/server/http.js';
import type { Provider, ProviderResult } from '../../src/types.js';

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

type Script = { reply?: ProviderResult; throws?: unknown; hang?: boolean; onAbort?: () => void };
function provider(s: Script = {}): Provider {
  return {
    id: 'fake',
    async complete(_model, req) {
      if (s.throws) throw s.throws;
      if (s.hang)
        await new Promise((_, reject) =>
          req.signal?.addEventListener('abort', () => {
            s.onAbort?.();
            reject(new DOMException('aborted', 'AbortError'));
          }),
        );
      return (
        s.reply ?? { text: '{"a":1}', json: { a: 1 }, toolCalls: [], finish: 'stop', usage: {}, warnings: [] }
      );
    },
  };
}
async function service(
  providers: Record<string, Provider>,
  o: Parameters<typeof startService>[1] = {},
  systemOne = {},
) {
  const logs: string[] = [];
  const svc: RunningService = await startService(
    { providers, systemOne },
    { port: 0, log: (l) => logs.push(l), ...o },
  );
  running.push(svc);
  return { svc, logs };
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
const ASK = { model: 'p:m', messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }], maxTokens: 50 };

describe('the service — routes', () => {
  it('lists what it serves, and answers a completion with the library’s own result', async () => {
    const { svc, logs } = await service(
      { p: provider() },
      {},
      { clm: { url: 'http://x', model: 'clm-latest' } },
    );
    expect(await (await fetch(`${svc.url}/health`)).json()).toEqual({
      ok: true,
      providers: ['p'],
      systemOne: ['clm'],
    });
    const res = await post(`${svc.url}/v1/complete`, { ...ASK, label: 'decision' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      text: '{"a":1}',
      json: { a: 1 },
      provider: 'p',
      model: 'm',
      message: { role: 'assistant' },
    });
    // One line per call — and never the prompt.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('provider=p model=m label=decision');
    expect(logs.join('\n')).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('refuses a malformed request, an unknown route, and an unknown provider — all as bad_request', async () => {
    const { svc } = await service({ p: provider() });
    const shapeless = await post(`${svc.url}/v1/complete`, { model: 'p:m' });
    expect(shapeless.status).toBe(400);
    expect(await shapeless.json()).toMatchObject({ error: { kind: 'bad_request' } });
    expect((await fetch(`${svc.url}/v1/nope`, { method: 'POST' })).status).toBe(404);
    expect((await post(`${svc.url}/v1/complete`, { ...ASK, model: 'vllm:m' })).status).toBe(400);
    expect((await fetch(`${svc.url}/v1/complete`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('refuses a body over the limit', async () => {
    const { svc } = await service({ p: provider() }, { maxBodyBytes: 100 });
    expect((await post(`${svc.url}/v1/complete`, { ...ASK, system: 'x'.repeat(500) })).status).toBe(413);
  });
});

describe('the service — errors keep their kind', () => {
  it('maps each kind to its status, with the kind in the body', async () => {
    const cases: [LlmError['kind'], number][] = [
      ['rate_limit', 429],
      ['auth', 502],
      ['schema_rejected', 502],
      ['server', 502],
    ];
    for (const [kind, status] of cases) {
      const { svc } = await service({
        p: provider({ throws: new LlmError({ kind, provider: 'p', model: 'm', status: 418 }) }),
      });
      const res = await post(`${svc.url}/v1/complete`, ASK);
      expect(res.status, kind).toBe(status);
      expect(await res.json()).toMatchObject({ error: { kind, provider: 'p', model: 'm', status: 418 } });
    }
  });

  it('a call past its timeout is a 504 timeout', async () => {
    const { svc } = await service({ p: provider({ hang: true }) });
    const res = await post(`${svc.url}/v1/complete`, { ...ASK, timeoutMs: 30 });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { kind: 'timeout' } });
  });

  it('a client that hangs up ABORTS the upstream call — a cancel crosses the boundary', async () => {
    let aborted!: () => void;
    const sawAbort = new Promise<void>((r) => {
      aborted = r;
    });
    const { svc, logs } = await service({ p: provider({ hang: true, onAbort: () => aborted() }) });
    const ac = new AbortController();
    const pending = post(`${svc.url}/v1/complete`, ASK, {}, ac.signal).catch(() => 'client gave up');
    setTimeout(() => ac.abort(), 50);
    expect(await pending).toBe('client gave up');
    await sawAbort; // the provider's signal fired
    await new Promise((r) => setTimeout(r, 20));
    expect(logs.join('\n')).toContain('error=aborted');
  });
});

describe('the service — who may call it', () => {
  it('with a token, a missing or wrong one gets 401 and the right one gets through', async () => {
    const { svc } = await service({ p: provider() }, { token: 'tok-123' });
    expect((await post(`${svc.url}/v1/complete`, ASK)).status).toBe(401);
    expect((await post(`${svc.url}/v1/complete`, ASK, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(`${svc.url}/v1/complete`, ASK, { authorization: 'Bearer tok-123' })).status).toBe(200);
  });

  it('refuses to listen off loopback without a token', async () => {
    await expect(
      startService({ providers: {}, systemOne: {} }, { host: '0.0.0.0', port: 0 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('the service — System One', () => {
  it('forwards to the named target and back; an unknown target is a 400', async () => {
    const seen: { auth?: string; body: unknown }[] = [];
    const clmStub: Server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        seen.push({
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          body: JSON.parse(data),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers: { d: { type: 'choice', choice: 'billing', confidence: 0.98 } } }));
      });
    });
    await new Promise<void>((r) => clmStub.listen(0, '127.0.0.1', () => r()));
    running.push({ close: () => new Promise<void>((r) => clmStub.close(() => r())) });
    const url = `http://127.0.0.1:${(clmStub.address() as AddressInfo).port}/v1/systemone`;
    const { svc } = await service({}, {}, { clm: { url, model: 'clm-latest' } });
    const q = {
      d: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'b', technical: 't' } },
    };
    const res = await post(`${svc.url}/v1/systemone`, {
      target: 'clm',
      state: 'charged twice',
      questions: q,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answers: { d: { choice: 'billing' } } });
    expect(seen[0]).toEqual({ body: { model: 'clm-latest', state: 'charged twice', questions: q } });
    expect((await post(`${svc.url}/v1/systemone`, { target: 'jev', state: 'x', questions: q })).status).toBe(
      400,
    );
  });
});

describe('config', () => {
  it('from the environment: what has a key, plus a local Ollama — and CLM only when CLM_URL is set', () => {
    expect(configFromEnv({ OPENROUTER_API_KEY: 'k' })).toEqual({
      providers: { openrouter: { type: 'openrouter' }, ollama: { type: 'ollama' } },
      systemOne: { jev: { type: 'jev' } },
    });
    expect(Object.keys(configFromEnv({ CLM_URL: 'http://c' }).systemOne)).toEqual(['clm']);
  });

  it('refuses a key written into the file, and names a missing variable without ever showing a value', () => {
    expect(() => parseConfig({ providers: { or: { type: 'openrouter', apiKey: 'sk-or-v1-real' } } })).toThrow(
      /apiKeyEnv/,
    );
    expect(() => parseConfig({ providers: { v: { type: 'openai-compatible' } } })).toThrow(/baseUrl/);
    // A provider whose key is unset is left out and named by its VARIABLE — not fatal.
    const built = buildConfig(
      parseConfig({
        providers: { or: { type: 'openrouter', apiKeyEnv: 'MY_OR_KEY' }, local: { type: 'ollama' } },
      }),
      {},
    );
    expect(Object.keys(built.providers)).toEqual(['local']);
    expect(built.skipped).toEqual([{ name: 'or', reason: 'providers.or: MY_OR_KEY is not set' }]);
  });

  it('never hands CLM the OpenRouter key', () => {
    const built = buildConfig(
      parseConfig({ systemOne: { jev: { type: 'jev' }, clm: { type: 'clm', url: 'http://c' } } }),
      { OPENROUTER_API_KEY: 'or-key' },
    );
    expect(built.systemOne.jev?.apiKey).toBe('or-key');
    expect(built.systemOne.clm).not.toHaveProperty('apiKey');
  });
});
