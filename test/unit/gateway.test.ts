import { afterEach, describe, expect, it } from 'vitest';
import type { LlmError } from '../../src/errors.js';
import { openrouter } from '../../src/providers/openrouter.js';
import { connectLlm } from '../../src/remote.js';
import {
  ANONYMOUS,
  type Built,
  ConfigError,
  MIN_APP_TOKEN_LENGTH,
  buildConfig,
  parseConfig,
} from '../../src/server/config.js';
import { type CallRecord, createService, startService } from '../../src/server/http.js';
import type { Provider, ProviderRequest } from '../../src/types.js';

/**
 * docs/GATEWAY.md §4 — one service, many apps. Every call is labelled with the app whose token it
 * carried; the app, not the body, decides what a provider is told about who is calling; a token
 * that matches no app is refused, never quietly treated as anonymous.
 */
const JARVIS = 'jarvis-token-0123456789abcdef';
const SPORTS = 'sports-token-0123456789abcdef';

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

function recordingProvider() {
  const seen: ProviderRequest[] = [];
  const p: Provider = {
    id: 'fake',
    async complete(_model, req) {
      seen.push(req);
      return {
        text: 'ok',
        toolCalls: [],
        finish: 'stop',
        usage: { inputTokens: 3, outputTokens: 1 },
        warnings: [],
      };
    },
  };
  return { p, seen };
}

const APPS = {
  jarvis: { tokenEnv: 'JARVIS_TOKEN', title: 'Jarvis', url: 'https://example.test/jarvis' },
  'sports-follow': { tokenEnv: 'SPORTS_TOKEN' },
};

/** A gateway config with two apps, and `p` as provider "p". */
function built(p: Provider, extra: Record<string, unknown> = {}): Built {
  const b = buildConfig(parseConfig({ providers: {}, apps: APPS, ...extra }), {
    JARVIS_TOKEN: JARVIS,
    SPORTS_TOKEN: SPORTS,
  });
  return { ...b, providers: { p } };
}

async function gateway(p: Provider, extra: Record<string, unknown> = {}, host?: string) {
  const records: CallRecord[] = [];
  const logs: string[] = [];
  const b = built(p, extra);
  if (host) {
    // Listen on loopback while TELLING the service it is somewhere else — how the off-loopback
    // rules are tested without binding every interface.
    const server = createService(b, { host, log: (l) => logs.push(l), onRecord: (r) => records.push(r) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    running.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
    return { url: `http://127.0.0.1:${port}`, records, logs };
  }
  const svc = await startService(b, { port: 0, log: (l) => logs.push(l), onRecord: (r) => records.push(r) });
  running.push(svc);
  return { url: svc.url, records, logs };
}

const ASK = {
  model: 'p:m',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 10,
  label: 'decision',
};

describe('app identity', () => {
  it('labels each call with the app whose token it carried', async () => {
    const { p } = recordingProvider();
    const g = await gateway(p);
    await connectLlm({ url: g.url, token: JARVIS }).complete(ASK);
    await connectLlm({ url: g.url, token: SPORTS }).complete(ASK);
    expect(g.records.map((r) => r.app)).toEqual(['jarvis', 'sports-follow']);
    expect(g.records[0]).toMatchObject({
      type: 'complete',
      provider: 'p',
      model: 'm',
      label: 'decision',
      ok: true,
      finish: 'stop',
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    expect(g.logs[0]).toContain('app=jarvis provider=p model=m label=decision');
  });

  it('a token that matches no app is refused as `unauthorized` — never treated as anonymous', async () => {
    const { p, seen } = recordingProvider();
    const g = await gateway(p);
    const e = (await connectLlm({ url: g.url, token: 'not-a-real-token-at-all' })
      .complete(ASK)
      .catch((x) => x)) as LlmError;
    expect(e.kind).toBe('unauthorized');
    expect(seen).toHaveLength(0);
    expect(g.records).toHaveLength(0);
  });

  it('no token on loopback is app `anonymous` — a notebook still works, and still shows up', async () => {
    const { p, seen } = recordingProvider();
    const g = await gateway(p);
    await connectLlm({ url: g.url }).complete(ASK);
    expect(g.records[0]?.app).toBe(ANONYMOUS);
    expect(seen[0]?.attribution).toBeUndefined(); // the provider's own default applies
  });

  it('`allowAnonymous: false` refuses a tokenless call', async () => {
    const { p } = recordingProvider();
    const g = await gateway(p, { allowAnonymous: false });
    const e = (await connectLlm({ url: g.url })
      .complete(ASK)
      .catch((x) => x)) as LlmError;
    expect(e.kind).toBe('unauthorized');
    expect(e.message).toContain('needs an app token');
  });

  it('off loopback, a tokenless call is refused even when anonymous is allowed', async () => {
    const { p } = recordingProvider();
    const g = await gateway(p, {}, '0.0.0.0');
    expect(
      (
        (await connectLlm({ url: g.url })
          .complete(ASK)
          .catch((x) => x)) as LlmError
      ).kind,
    ).toBe('unauthorized');
    await connectLlm({ url: g.url, token: JARVIS }).complete(ASK); // an app token still works
    expect(g.records[0]?.app).toBe('jarvis');
  });

  it('/health is open, and names the apps — no token needed to ask what is there', async () => {
    const { p } = recordingProvider();
    const g = await gateway(p);
    const h = await connectLlm({ url: g.url }).health();
    expect(h.apps).toEqual(['jarvis', 'sports-follow']);
    expect(h.providers).toEqual(['p']);
  });

  it('a failed call is recorded too, with its kind', async () => {
    const p: Provider = {
      id: 'fake',
      async complete() {
        throw new Error('boom');
      },
    };
    const g = await gateway(p);
    await connectLlm({ url: g.url, token: JARVIS })
      .complete(ASK)
      .catch(() => {});
    expect(g.records[0]).toMatchObject({
      app: 'jarvis',
      provider: 'p',
      ok: false,
      error: { kind: 'network' },
    });
  });

  it('System One calls carry the app and the label too', async () => {
    const answer = new (await import('node:http')).Server((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ answers: {}, usage: { cost: 0.00003 } }));
    });
    await new Promise<void>((resolve) => answer.listen(0, '127.0.0.1', resolve));
    running.push({ close: () => new Promise((resolve) => answer.close(() => resolve())) });
    const port = (answer.address() as { port: number }).port;
    const records: CallRecord[] = [];
    const svc = await startService(
      {
        ...built(recordingProvider().p),
        systemOne: { jev: { url: `http://127.0.0.1:${port}`, model: 'jev-latest' } },
      },
      { port: 0, log: () => {}, onRecord: (r) => records.push(r) },
    );
    running.push(svc);
    await connectLlm({ url: svc.url, token: JARVIS }).systemOne(
      'jev',
      {},
      {},
      { label: 'blueprint: which shape' },
    );
    expect(records[0]).toMatchObject({
      type: 'systemone',
      app: 'jarvis',
      provider: 'jev',
      model: 'jev-latest',
      label: 'blueprint: which shape',
      ok: true,
      usage: { costUsd: 0.00003 },
    });
  });
});

describe('attribution comes from the app, not the body', () => {
  it('the provider is told the calling app’s title and url', async () => {
    const { p, seen } = recordingProvider();
    const g = await gateway(p);
    await connectLlm({ url: g.url, token: JARVIS }).complete(ASK);
    await connectLlm({ url: g.url, token: SPORTS }).complete(ASK);
    expect(seen[0]?.attribution).toEqual({ title: 'Jarvis', url: 'https://example.test/jarvis' });
    expect(seen[1]?.attribution).toEqual({ title: 'sports-follow' }); // no title: the id
  });

  it('an app cannot label its calls as another’s', async () => {
    const { p, seen } = recordingProvider();
    const g = await gateway(p);
    await connectLlm({ url: g.url, token: SPORTS }).complete({ ...ASK, attribution: { title: 'Jarvis' } });
    expect(seen[0]?.attribution).toEqual({ title: 'sports-follow' });
  });

  it('OpenRouter sends a call’s attribution as its headers, over the construction-time app name', async () => {
    const sent: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
      );
    }) as typeof fetch;
    const or = openrouter({
      apiKey: 'k',
      appName: 'Default',
      appUrl: 'https://default.test',
      fetch: fetchFn,
    });
    await or.complete('m', { messages: [{ role: 'user', content: 'x' }], maxTokens: 5 });
    await or.complete('m', {
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 5,
      attribution: { title: 'Jarvis', url: 'https://example.test/jarvis' },
    });
    expect(sent[0]).toMatchObject({ 'x-title': 'Default', 'http-referer': 'https://default.test' });
    expect(sent[1]).toMatchObject({ 'x-title': 'Jarvis', 'http-referer': 'https://example.test/jarvis' });
  });
});

describe('the apps config', () => {
  const env = { A: 'a'.repeat(MIN_APP_TOKEN_LENGTH), B: 'b'.repeat(MIN_APP_TOKEN_LENGTH) };

  it('refuses a token written into the file, and names the variable to use instead', () => {
    expect(() => parseConfig({ providers: {}, apps: { jarvis: { token: 'x' } } })).toThrow(/tokenEnv/);
  });

  it('an app id must be a safe metric label, and not "anonymous"', () => {
    expect(() => parseConfig({ providers: {}, apps: { 'Jarvis App': { tokenEnv: 'A' } } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ providers: {}, apps: { anonymous: { tokenEnv: 'A' } } })).toThrow(ConfigError);
  });

  it('an app whose token is unset is skipped by NAME, like a provider without its key', () => {
    const b = buildConfig(
      parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'A' }, sports: { tokenEnv: 'NOPE' } } }),
      env,
    );
    expect(Object.keys(b.apps ?? {})).toEqual(['jarvis']);
    expect(b.skipped).toEqual([{ name: 'sports', reason: 'apps.sports: NOPE is not set' }]);
  });

  it('refuses a short token, and two apps sharing one — calls must be told apart', () => {
    expect(() =>
      buildConfig(parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'S' } } }), { S: 'short' }),
    ).toThrow(/shorter than/);
    expect(() =>
      buildConfig(
        parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'A' }, other: { tokenEnv: 'A' } } }),
        env,
      ),
    ).toThrow(/shares its token/);
  });

  it('a token never appears in an error message', () => {
    try {
      buildConfig(parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'S' } } }), {
        S: 'secret-but-short',
      });
    } catch (e) {
      expect(String(e)).not.toContain('secret-but-short');
    }
  });

  it('no apps section is the service as before — no app identity', () => {
    const b = buildConfig(parseConfig({ providers: {} }), {});
    expect(b.apps).toBeUndefined();
  });

  it('a gateway with apps refuses the shared LLM_PROVIDERS_TOKEN — one or the other', () => {
    const b = buildConfig(parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'A' } } }), env);
    expect(() => createService(b, { token: 'shared-token-0123456789' })).toThrow(/its own token/);
  });
});
