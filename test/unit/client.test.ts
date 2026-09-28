import { describe, expect, it } from 'vitest';
import { type CallEvent, createLlm, parseModelRef } from '../../src/client.js';
import { LlmError } from '../../src/errors.js';
import type { Provider, ProviderRequest, ProviderResult } from '../../src/types.js';

const ok = (extra: Partial<ProviderResult> = {}): ProviderResult => ({
  text: 'hi',
  toolCalls: [],
  finish: 'stop',
  usage: { inputTokens: 3, outputTokens: 1 },
  warnings: [],
  ...extra,
});
/** A provider that answers `reply`, or waits until its signal aborts when `hang` is set. */
function fakeProvider(o: { id?: string; reply?: ProviderResult; hang?: boolean; throws?: unknown } = {}) {
  const seen: { model: string; req: ProviderRequest }[] = [];
  const p: Provider = {
    id: o.id ?? 'fake',
    async complete(model, req) {
      seen.push({ model, req });
      if (o.throws) throw o.throws;
      if (o.hang)
        await new Promise((_, reject) =>
          req.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      return o.reply ?? ok();
    },
  };
  return { p, seen };
}
const msgs = [{ role: 'user' as const, content: 'hi' }];

describe('model refs', () => {
  it('split on the FIRST colon, so a model tag survives', () => {
    expect(parseModelRef('ollama:qwen3:8b')).toEqual({ provider: 'ollama', model: 'qwen3:8b' });
    expect(parseModelRef('openrouter:moonshotai/kimi-k2.7-code')).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.7-code',
    });
  });

  it('refuse a ref without a provider, and an unregistered provider — naming what IS registered', async () => {
    expect(() => parseModelRef('gpt-4o')).toThrow(LlmError);
    const llm = createLlm({ providers: { ollama: fakeProvider().p } });
    const err = (await llm
      .complete({ model: 'vllm:qwen3-8b', messages: msgs, maxTokens: 10 })
      .catch((e) => e)) as LlmError;
    expect(err.kind).toBe('bad_request');
    expect(err.message).toContain('registered: ollama');
  });
});

describe('complete', () => {
  it('routes by ref, strips the ref/timeout/label from what the provider sees, and names who answered', async () => {
    const { p, seen } = fakeProvider();
    const llm = createLlm({ providers: { local: p } });
    const r = await llm.complete({
      model: 'local:qwen3:8b',
      messages: msgs,
      maxTokens: 10,
      label: 'decision',
      timeoutMs: 5000,
    });
    expect(seen[0]?.model).toBe('qwen3:8b');
    expect(seen[0]?.req).not.toHaveProperty('model');
    expect(seen[0]?.req).not.toHaveProperty('label');
    expect(seen[0]?.req.signal).toBeInstanceOf(AbortSignal);
    expect(r).toMatchObject({
      provider: 'local',
      model: 'qwen3:8b',
      text: 'hi',
      message: { role: 'assistant', content: 'hi' },
    });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('puts the provider’s raw content on the returned assistant message, tagged with the provider id', async () => {
    const raw = [{ type: 'thinking', thinking: 'x', signature: 's' }];
    const { p } = fakeProvider({
      id: 'anthropic',
      reply: ok({ toolCalls: [{ id: 't', name: 'n', args: {} }], raw }),
    });
    const r = await createLlm({ providers: { claude: p } }).complete({
      model: 'claude:opus',
      messages: msgs,
      maxTokens: 10,
    });
    expect(r.message).toEqual({
      role: 'assistant',
      content: 'hi',
      toolCalls: [{ id: 't', name: 'n', args: {} }],
      raw: { provider: 'anthropic', content: raw },
    });
    expect(r).not.toHaveProperty('raw');
  });

  it('a slow call becomes a TIMEOUT; a cancelled one ABORTED — never confused', async () => {
    const llm = createLlm({ providers: { slow: fakeProvider({ hang: true }).p } });
    const t = (await llm
      .complete({ model: 'slow:m', messages: msgs, maxTokens: 10, timeoutMs: 30 })
      .catch((e) => e)) as LlmError;
    expect(t.kind).toBe('timeout');
    const ac = new AbortController();
    const pending = llm
      .complete({ model: 'slow:m', messages: msgs, maxTokens: 10, signal: ac.signal, timeoutMs: 5000 })
      .catch((e) => e);
    ac.abort();
    expect(((await pending) as LlmError).kind).toBe('aborted');
  });

  it('names an error after the REGISTERED provider, and a refused connection as network', async () => {
    const inner = new LlmError({
      kind: 'rate_limit',
      provider: 'openai-compatible',
      model: 'm',
      status: 429,
    });
    const a = (await createLlm({ providers: { vllm: fakeProvider({ throws: inner }).p } })
      .complete({ model: 'vllm:m', messages: msgs, maxTokens: 10 })
      .catch((e) => e)) as LlmError;
    expect(a).toMatchObject({ kind: 'rate_limit', provider: 'vllm', status: 429 });
    const b = (await createLlm({
      providers: { vllm: fakeProvider({ throws: new TypeError('fetch failed') }).p },
    })
      .complete({ model: 'vllm:m', messages: msgs, maxTokens: 10 })
      .catch((e) => e)) as LlmError;
    expect(b.kind).toBe('network');
  });
});

describe('onCall', () => {
  it('reports every call once — success with usage and warnings, failure with its kind — and a throwing hook costs nothing', async () => {
    const events: CallEvent[] = [];
    const good = createLlm({
      providers: { p: fakeProvider({ reply: ok({ warnings: ['truncated'] }) }).p },
      onCall: (e) => events.push(e),
    });
    await good.complete({ model: 'p:m', messages: msgs, maxTokens: 10, label: 'author' });
    expect(events[0]).toMatchObject({
      provider: 'p',
      model: 'm',
      label: 'author',
      ok: true,
      warnings: ['truncated'],
      usage: { inputTokens: 3 },
    });
    const bad = createLlm({
      providers: {
        p: fakeProvider({ throws: new LlmError({ kind: 'auth', provider: 'p', model: 'm', status: 401 }) }).p,
      },
      onCall: (e) => events.push(e),
    });
    await bad.complete({ model: 'p:m', messages: msgs, maxTokens: 10 }).catch(() => {});
    expect(events[1]).toMatchObject({ ok: false, error: { kind: 'auth' } });
    const loud = createLlm({
      providers: { p: fakeProvider().p },
      onCall: () => {
        throw new Error('logger down');
      },
    });
    await expect(loud.complete({ model: 'p:m', messages: msgs, maxTokens: 10 })).resolves.toMatchObject({
      text: 'hi',
    });
  });
});
