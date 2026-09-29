import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallEvent } from '../../src/client.js';
import { LlmError } from '../../src/errors.js';
import { connectLlm } from '../../src/remote.js';
import { type RunningService, startService } from '../../src/server/http.js';
import type { Provider, ProviderResult } from '../../src/types.js';

/**
 * connectLlm against a REAL service in this process: TypeScript on both sides of a socket. This
 * is the boundary Jarvis will cross on every model call (Jarvis doc 67).
 */
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

function provider(
  s: { reply?: ProviderResult; throws?: unknown; hang?: boolean; onAbort?: () => void } = {},
): Provider {
  return {
    id: 'fake',
    async complete(_m, req) {
      if (s.throws) throw s.throws;
      if (s.hang)
        await new Promise((_, reject) =>
          req.signal?.addEventListener('abort', () => {
            s.onAbort?.();
            reject(new DOMException('aborted', 'AbortError'));
          }),
        );
      return (
        s.reply ?? {
          text: '{"a":1}',
          json: { a: 1 },
          toolCalls: [],
          finish: 'stop',
          usage: { inputTokens: 5, costUsd: 0.001 },
          warnings: ['schema_relaxed'],
        }
      );
    },
  };
}
async function service(providers: Record<string, Provider>, token?: string, systemOne = {}) {
  const svc: RunningService = await startService(
    { providers, systemOne },
    { port: 0, log: () => {}, ...(token ? { token } : {}) },
  );
  open.push(svc);
  return svc;
}
const ASK = {
  model: 'openrouter:moonshotai/kimi-k2.7-code',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 50,
};

describe('connectLlm', () => {
  it('passes the model ref through and returns the service’s result as-is', async () => {
    const svc = await service({ openrouter: provider() });
    const llm = connectLlm({ url: svc.url });
    const r = await llm.complete({ ...ASK, label: 'decision' });
    expect(r).toMatchObject({
      text: '{"a":1}',
      json: { a: 1 },
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.7-code',
      warnings: ['schema_relaxed'],
      message: { role: 'assistant' },
    });
  });

  it('fires onCall locally, from the result — metrics do not depend on the service’s logs', async () => {
    const svc = await service({ openrouter: provider() });
    const events: CallEvent[] = [];
    await connectLlm({ url: svc.url, onCall: (e) => events.push(e) }).complete({ ...ASK, label: 'author' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.7-code',
      label: 'author',
      ok: true,
      usage: { inputTokens: 5, costUsd: 0.001 },
      warnings: ['schema_relaxed'],
    });
  });

  it('rebuilds the service’s error with the same kind, provider, model, status — and no doubled prefix', async () => {
    const upstream = new LlmError({
      kind: 'rate_limit',
      provider: 'openrouter',
      model: 'm',
      status: 429,
      detail: 'slow down',
    });
    const svc = await service({ openrouter: provider({ throws: upstream }) });
    const events: CallEvent[] = [];
    const err = (await connectLlm({ url: svc.url, onCall: (e) => events.push(e) })
      .complete(ASK)
      .catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({
      kind: 'rate_limit',
      provider: 'openrouter',
      model: 'm',
      status: 429,
      detail: 'slow down',
    });
    expect(err.message).toBe('openrouter m: rate_limit (HTTP 429) — slow down');
    expect(events[0]).toMatchObject({ ok: false, error: { kind: 'rate_limit' } });
  });

  it('an unknown provider is the service’s bad_request', async () => {
    const svc = await service({ openrouter: provider() });
    const err = (await connectLlm({ url: svc.url })
      .complete({ ...ASK, model: 'anthropic:claude' })
      .catch((e) => e)) as LlmError;
    expect(err.kind).toBe('bad_request');
    expect(err.message).toContain('registered: openrouter');
  });

  it('a service that is not running is `network`, naming the URL and the command', async () => {
    const err = (await connectLlm({ url: 'http://127.0.0.1:1' })
      .complete(ASK)
      .catch((e) => e)) as LlmError;
    expect(err.kind).toBe('network');
    expect(err.message).toContain('http://127.0.0.1:1');
    expect(err.message).toContain('llm-providers serve');
  });

  it('aborting the call closes the connection, and the service aborts the upstream call', async () => {
    let fired!: () => void;
    const upstreamAborted = new Promise<void>((r) => {
      fired = r;
    });
    const svc = await service({ openrouter: provider({ hang: true, onAbort: () => fired() }) });
    const ac = new AbortController();
    const pending = connectLlm({ url: svc.url })
      .complete({ ...ASK, signal: ac.signal })
      .catch((e) => e);
    setTimeout(() => ac.abort(), 50);
    expect(((await pending) as LlmError).kind).toBe('aborted');
    await upstreamAborted;
  });

  it('the SERVICE reports a timeout within the call’s own limit; only a hung service trips the HTTP timeout', async () => {
    const svc = await service({ openrouter: provider({ hang: true }) });
    const byService = (await connectLlm({ url: svc.url })
      .complete({ ...ASK, timeoutMs: 30 })
      .catch((e) => e)) as LlmError;
    expect(byService).toMatchObject({ kind: 'timeout', provider: 'openrouter' });

    const hung: Server = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', () => r()));
    open.push({
      close: () =>
        new Promise<void>((r) => {
          hung.closeAllConnections();
          hung.close(() => r());
        }),
    });
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
    const byClient = (await connectLlm({ url, slackMs: 20 })
      .complete({ ...ASK, timeoutMs: 20 })
      .catch((e) => e)) as LlmError;
    expect(byClient.kind).toBe('timeout');
    expect(byClient.message).toContain('no reply from the llm-providers service');
  });

  it('sends the token; health lists what is served; System One goes to the named target', async () => {
    const clmStub: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { d: { type: 'choice', choice: 'billing', confidence: 0.98 } } }));
    });
    await new Promise<void>((r) => clmStub.listen(0, '127.0.0.1', () => r()));
    open.push({ close: () => new Promise<void>((r) => clmStub.close(() => r())) });
    const clmUrl = `http://127.0.0.1:${(clmStub.address() as AddressInfo).port}/v1/systemone`;
    const svc = await service({ openrouter: provider() }, 'tok-1', {
      clm: { url: clmUrl, model: 'clm-latest' },
    });

    const anon = (await connectLlm({ url: svc.url })
      .complete(ASK)
      .catch((e) => e)) as LlmError;
    expect(anon.kind).toBe('unauthorized');
    const llm = connectLlm({ url: svc.url, token: 'tok-1' });
    expect(await llm.health()).toEqual({ ok: true, providers: ['openrouter'], systemOne: ['clm'] });
    expect(llm.providers).toEqual(['openrouter']);
    const r = await llm.systemOne('clm', 'charged twice', {
      d: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'b', technical: 't' } },
    });
    expect(r.answers.d?.choice).toBe('billing');
    const unknown = (await llm.systemOne('jev', 'x', {}).catch((e) => e)) as LlmError;
    expect(unknown.kind).toBe('bad_request');
  });
});
