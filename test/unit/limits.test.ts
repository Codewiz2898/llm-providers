import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmError } from '../../src/errors.js';
import { connectLlm } from '../../src/remote.js';
import { createSpendLedger } from '../../src/server/budget.js';
import { type Built, ConfigError, buildConfig, parseConfig } from '../../src/server/config.js';
import { type CallRecord, startService } from '../../src/server/http.js';
import type { Provider, ProviderRequest } from '../../src/types.js';

/**
 * docs/GATEWAY.md §4 — what a gateway lets an app do: Anthropic only when switched on, and then
 * only for apps that opt in; and no more than an app's daily budget.
 */
const JARVIS = 'jarvis-token-0123456789abcdef';
const SPORTS = 'sports-token-0123456789abcdef';
const ENV = {
  JARVIS_TOKEN: JARVIS,
  SPORTS_TOKEN: SPORTS,
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  OPENROUTER_API_KEY: 'sk-or-test-key',
};

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

/** Answers every call, costing `costUsd` when given. */
function fake(costUsd?: number) {
  const seen: ProviderRequest[] = [];
  const p: Provider = {
    id: 'fake',
    async complete(_model, req) {
      seen.push(req);
      return {
        text: 'ok',
        toolCalls: [],
        finish: 'stop',
        usage: { inputTokens: 3, outputTokens: 1, ...(costUsd !== undefined ? { costUsd } : {}) },
        warnings: [],
      };
    },
  };
  return { p, seen };
}

/** A config made real, with each built provider swapped for the fake of the same name. */
function built(config: Record<string, unknown>, fakes: Record<string, Provider>): Built {
  const b = buildConfig(parseConfig({ providers: {}, ...config }), ENV);
  for (const name of Object.keys(b.providers)) if (fakes[name]) b.providers[name] = fakes[name];
  return b;
}

async function serve(b: Built, spendFile?: string) {
  const records: CallRecord[] = [];
  const svc = await startService(b, {
    port: 0,
    log: () => {},
    onRecord: (r) => records.push(r),
    ...(spendFile ? { spendFile } : {}),
  });
  running.push(svc);
  return { url: svc.url, records, close: () => svc.close() };
}

const ask = (model: string) => ({
  model,
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 10,
});
const fail = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: LlmError) => e,
  );

describe('Anthropic is off unless switched on', () => {
  it('an anthropic entry without "enabled": true is left out before its key is read, and says why', () => {
    const b = buildConfig(parseConfig({ providers: { anthropic: { type: 'anthropic' } } }), ENV);
    expect(b.providers).toEqual({});
    expect(b.disabled).toEqual(['anthropic']);
    expect(b.skipped).toEqual([
      {
        name: 'anthropic',
        reason: 'providers.anthropic: Anthropic is off unless its entry has "enabled": true',
      },
    ]);
  });

  it('"enabled" belongs to an anthropic provider only — false on anything else would be ignored', () => {
    expect(() => parseConfig({ providers: { or: { type: 'openrouter', enabled: false } } })).toThrow(
      /remove its entry/,
    );
    expect(() => parseConfig({ providers: { a: { type: 'anthropic', enabled: 'yes' } } })).toThrow(
      ConfigError,
    );
  });

  it('a call to an Anthropic provider left off is `forbidden` (403), naming the switch — not "unknown"', async () => {
    const s = await serve(built({ providers: { anthropic: { type: 'anthropic' } } }, {}));
    const res = await fetch(`${s.url}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask('anthropic:claude-x')),
    });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: { kind: string; message: string } };
    expect(error.kind).toBe('forbidden');
    expect(error.message).toContain('"enabled": true');
  });

  it('switched on, a service WITHOUT apps serves it to any caller', async () => {
    const { p } = fake();
    const s = await serve(
      built({ providers: { anthropic: { type: 'anthropic', enabled: true } } }, { anthropic: p }),
    );
    expect((await connectLlm({ url: s.url }).complete(ask('anthropic:claude-x'))).text).toBe('ok');
  });

  it('on a gateway, only apps with "anthropic": true may call it — the others are `forbidden`', async () => {
    const claude = fake();
    const or = fake();
    const s = await serve(
      built(
        {
          providers: { claude: { type: 'anthropic', enabled: true }, or: { type: 'openrouter' } },
          apps: {
            jarvis: { tokenEnv: 'JARVIS_TOKEN', anthropic: true },
            'sports-follow': { tokenEnv: 'SPORTS_TOKEN' },
          },
        },
        { claude: claude.p, or: or.p },
      ),
    );
    const sports = connectLlm({ url: s.url, token: SPORTS });

    expect((await connectLlm({ url: s.url, token: JARVIS }).complete(ask('claude:claude-x'))).text).toBe(
      'ok',
    );
    const refused = await fail(sports.complete(ask('claude:claude-x')));
    expect(refused?.kind).toBe('forbidden');
    expect(refused?.message).toContain('apps.sports-follow.anthropic');
    const anonymous = await fail(connectLlm({ url: s.url }).complete(ask('claude:claude-x')));
    expect(anonymous?.kind).toBe('forbidden');
    // Only Anthropic is gated: the same app's other calls go through.
    expect((await sports.complete(ask('or:some/model'))).text).toBe('ok');

    expect(claude.seen).toHaveLength(1);
    // A refusal is a call record, so it shows on the dashboard under its kind.
    expect(s.records.filter((r) => !r.ok).map((r) => [r.app, r.provider, r.error?.kind])).toEqual([
      ['sports-follow', 'claude', 'forbidden'],
      ['anonymous', 'claude', 'forbidden'],
    ]);
  });

  it('refuses a non-boolean app "anthropic"', () => {
    expect(() =>
      parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'JARVIS_TOKEN', anthropic: 'yes' } } }),
    ).toThrow(/"anthropic" must be true or false/);
  });
});

describe('daily budgets', () => {
  const APPS = {
    jarvis: { tokenEnv: 'JARVIS_TOKEN', budgetUsdDaily: 1 },
    'sports-follow': { tokenEnv: 'SPORTS_TOKEN' },
  };

  it('refuses an app once its spend reaches its budget — 429 `budget_exceeded`, Retry-After to midnight', async () => {
    const { p, seen } = fake(0.4);
    const b = built({ apps: APPS }, {});
    b.providers = { p };
    const g = await serve(b);
    const jarvis = connectLlm({ url: g.url, token: JARVIS });

    for (let i = 0; i < 3; i++) await jarvis.complete(ask('p:m')); // $0.40, $0.80, $1.20
    const e = await fail(jarvis.complete(ask('p:m')));
    expect(e?.kind).toBe('budget_exceeded');
    expect(e?.message).toContain('has spent $1.2 of its $1 daily budget');
    expect(seen).toHaveLength(3); // the refused call never reached the provider

    const res = await fetch(`${g.url}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${JARVIS}` },
      body: JSON.stringify(ask('p:m')),
    });
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 3600);

    // An app without a budget is untouched by another's.
    await connectLlm({ url: g.url, token: SPORTS }).complete(ask('p:m'));
    expect(g.records.at(-1)).toMatchObject({ app: 'sports-follow', ok: true });
    expect(g.records.filter((r) => r.error?.kind === 'budget_exceeded')).toHaveLength(2);
  });

  it('System One spend counts, and a spent app’s questions are refused too', async () => {
    const jev = new Server((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ answers: {}, usage: { cost: 0.6 } }));
    });
    await new Promise<void>((resolve) => jev.listen(0, '127.0.0.1', resolve));
    running.push({ close: () => new Promise((resolve) => jev.close(() => resolve())) });
    const b = built({ apps: APPS }, {});
    b.systemOne = {
      jev: { url: `http://127.0.0.1:${(jev.address() as { port: number }).port}`, model: 'jev-latest' },
    };
    const g = await serve(b);
    const jarvis = connectLlm({ url: g.url, token: JARVIS });
    await jarvis.systemOne('jev', {}, {});
    await jarvis.systemOne('jev', {}, {}); // $1.20
    expect((await fail(jarvis.systemOne('jev', {}, {})))?.kind).toBe('budget_exceeded');
  });

  it('a restart does not hand an app a fresh budget — today’s spend is kept in the spend file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'llm-spend-')), 'state', 'spend.json');
    const b = built({ apps: APPS }, {});
    b.providers = { p: fake(1.5).p };
    const first = await serve(b, file);
    await connectLlm({ url: first.url, token: JARVIS }).complete(ask('p:m'));
    await first.close();

    const second = await serve(b, file);
    expect((await fail(connectLlm({ url: second.url, token: JARVIS }).complete(ask('p:m'))))?.kind).toBe(
      'budget_exceeded',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a budget that is not a positive number', () => {
    for (const budgetUsdDaily of [0, -1, '5', Number.POSITIVE_INFINITY])
      expect(() =>
        parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'A', budgetUsdDaily } } }),
      ).toThrow(/positive number/);
  });
});

describe('the spend ledger', () => {
  it('starts again at local midnight', () => {
    let now = new Date(2026, 8, 29, 23, 59, 30);
    const l = createSpendLedger({ now: () => now });
    l.add('jarvis', 2);
    expect(l.spent('jarvis')).toBe(2);
    expect(l.secondsToReset()).toBe(30);
    now = new Date(2026, 8, 30, 0, 0, 1);
    expect(l.spent('jarvis')).toBe(0);
  });

  it('reads today’s file, ignores yesterday’s, and warns about — but survives — a broken one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-spend-'));
    const file = join(dir, 'spend.json');
    const now = () => new Date(2026, 8, 29, 12);
    writeFileSync(file, JSON.stringify({ day: '2026-09-29', usd: { jarvis: 0.75 } }));
    expect(createSpendLedger({ file, now }).spent('jarvis')).toBe(0.75);

    writeFileSync(file, JSON.stringify({ day: '2026-09-28', usd: { jarvis: 0.75 } }));
    expect(createSpendLedger({ file, now }).spent('jarvis')).toBe(0);

    const warnings: string[] = [];
    writeFileSync(file, '{not json');
    const l = createSpendLedger({ file, now, warn: (w) => warnings.push(w) });
    expect(l.spent('jarvis')).toBe(0);
    expect(warnings[0]).toContain('unreadable');
    l.add('jarvis', 0.25);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ day: '2026-09-29', usd: { jarvis: 0.25 } });

    // No file yet is the normal first run — nothing to warn about.
    const quiet: string[] = [];
    createSpendLedger({ file: join(dir, 'none.json'), now, warn: (w) => quiet.push(w) });
    expect(quiet).toEqual([]);
  });
});
