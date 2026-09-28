import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/errors.js';
import { openaiCompatible } from '../../src/providers/openaiCompatible.js';
import { openrouter } from '../../src/providers/openrouter.js';
import type { ProviderRequest } from '../../src/types.js';
import { chatReply, scriptedFetch } from '../support/fetch.js';

const SCHEMA = {
  name: 'decision',
  schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
const ask = (extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'You decide.',
  messages: [{ role: 'user', content: 'order a pepsi' }],
  maxTokens: 512,
  ...extra,
});

describe('openaiCompatible — the request', () => {
  it('sends a strict json_schema, the system prompt first, and no key when none is configured', async () => {
    const { fetch, sent } = scriptedFetch([{ body: chatReply({ content: '{"action":"act"}' }) }]);
    const vllm = openaiCompatible({ id: 'vllm', baseUrl: 'http://gpu:8000/v1/', fetch });
    const r = await vllm.complete('qwen3-8b', ask({ schema: SCHEMA }));
    expect(sent[0]?.url).toBe('http://gpu:8000/v1/chat/completions');
    expect(sent[0]?.headers).not.toHaveProperty('authorization');
    expect(sent[0]?.body).toMatchObject({
      model: 'qwen3-8b',
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'You decide.' },
        { role: 'user', content: 'order a pepsi' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'decision', strict: true, schema: SCHEMA.schema },
      },
    });
    // require_parameters is OpenRouter's, never a plain server's.
    expect(sent[0]?.body).not.toHaveProperty('provider');
    expect(r.json).toEqual({ action: 'act' });
    expect(r.warnings).toEqual([]);
  });

  it('maps tools, the tool choice, and a conversation that continues after a tool call', async () => {
    const { fetch, sent } = scriptedFetch([{ body: chatReply({ content: 'done' }) }]);
    const p = openaiCompatible({ baseUrl: 'http://x/v1', fetch });
    await p.complete(
      'm',
      ask({
        tools: [{ name: 'search', description: 'Search products', parameters: { type: 'object' } }],
        toolChoice: { name: 'search' },
        messages: [
          { role: 'user', content: 'find pepsi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', args: { q: 'pepsi' } }] },
          { role: 'tool', toolCallId: 'c1', content: '[{"name":"Pepsi 750ml"}]' },
        ],
      }),
    );
    expect(sent[0]?.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'Search products', parameters: { type: 'object' } },
      },
    ]);
    expect(sent[0]?.body.tool_choice).toEqual({ type: 'function', function: { name: 'search' } });
    expect((sent[0]?.body.messages as unknown[]).slice(2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"pepsi"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[{"name":"Pepsi 750ml"}]' },
    ]);
  });
});

describe('openaiCompatible — the lessons (DESIGN §6)', () => {
  it('a refused strict schema is retried ONCE in json_object mode, with the schema in the prompt', async () => {
    const { fetch, sent } = scriptedFetch([
      { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } },
      { body: chatReply({ content: '{"action":"noop"}' }) },
    ]);
    const r = await openaiCompatible({ baseUrl: 'http://x/v1', fetch }).complete(
      'm',
      ask({ schema: SCHEMA }),
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.response_format).toEqual({ type: 'json_object' });
    expect(String((sent[1]?.body.messages as { content: string }[])[0]?.content)).toContain(
      '"required":["action"]',
    );
    expect(r.json).toEqual({ action: 'noop' });
    expect(r.warnings).toContain('schema_relaxed');
  });

  it('any OTHER 4xx is an error, not a retry', async () => {
    const { fetch, sent } = scriptedFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    const err = await openaiCompatible({ baseUrl: 'http://x/v1', fetch })
      .complete('m', ask({ schema: SCHEMA }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('auth');
    expect(sent).toHaveLength(1);
  });

  it('reads a reasoning model’s answer out of `reasoning` or `reasoning_content` when `content` is empty', async () => {
    for (const reply of [
      chatReply({ content: '', reasoning: 'thinking… final {"action":"act"}' }),
      chatReply({ content: null, reasoningContent: 'hmm {"action":"act"}' }),
    ]) {
      const { fetch } = scriptedFetch([{ body: reply }]);
      const r = await openaiCompatible({ baseUrl: 'http://x/v1', fetch }).complete(
        'm',
        ask({ schema: SCHEMA }),
      );
      expect(r.json).toEqual({ action: 'act' });
      expect(r.warnings).toContain('reasoning_fallback');
    }
  });

  it('names truncation, an empty reply, and text that is not the JSON asked for', async () => {
    const { fetch } = scriptedFetch([
      { body: chatReply({ content: '{"action":"a', finish: 'length' }) },
      { body: chatReply({ content: '' }) },
    ]);
    const p = openaiCompatible({ baseUrl: 'http://x/v1', fetch });
    const cut = await p.complete('m', ask({ schema: SCHEMA }));
    expect(cut.finish).toBe('length');
    expect(cut.warnings).toEqual(expect.arrayContaining(['truncated', 'json_unparsed']));
    const none = await p.complete('m', ask());
    expect(none.warnings).toContain('empty');
  });

  it('parses tool-call arguments, and flags ones that are not JSON', async () => {
    const { fetch } = scriptedFetch([
      {
        body: chatReply({
          content: null,
          finish: 'tool_calls',
          toolCalls: [
            { id: 'a', name: 'search', arguments: '{"q":"pepsi"}' },
            { id: 'b', name: 'search', arguments: 'not json' },
          ],
        }),
      },
    ]);
    const r = await openaiCompatible({ baseUrl: 'http://x/v1', fetch }).complete('m', ask());
    expect(r.finish).toBe('tool_calls');
    expect(r.toolCalls).toEqual([
      { id: 'a', name: 'search', args: { q: 'pepsi' } },
      { id: 'b', name: 'search', args: {} },
    ]);
    expect(r.warnings).toContain('tool_args_unparsed');
    expect(r.warnings).not.toContain('empty');
  });

  it('a 200 carrying an upstream error in its body is an error', async () => {
    const { fetch } = scriptedFetch([{ body: { error: { message: 'upstream overloaded' } } }]);
    const err = await openaiCompatible({ baseUrl: 'http://x/v1', fetch })
      .complete('m', ask())
      .catch((e) => e);
    expect((err as LlmError).kind).toBe('server');
  });

  it('sends the server’s own thinking-off fields only when a call asks for thinking off', async () => {
    const { fetch, sent } = scriptedFetch([
      { body: chatReply({ content: 'a' }) },
      { body: chatReply({ content: 'b' }) },
    ]);
    const vllm = openaiCompatible({
      baseUrl: 'http://gpu/v1',
      thinkingOffBody: { chat_template_kwargs: { enable_thinking: false } },
      fetch,
    });
    await vllm.complete('qwen3-8b', ask({ thinking: 'off' }));
    await vllm.complete('qwen3-8b', ask());
    expect(sent[0]?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent[1]?.body).not.toHaveProperty('chat_template_kwargs');
  });

  it('passes the abort signal to fetch, so a cancel stops the HTTP request itself', async () => {
    const { fetch, sent } = scriptedFetch([{ body: chatReply({ content: 'x' }) }]);
    const ac = new AbortController();
    await openaiCompatible({ baseUrl: 'http://x/v1', fetch }).complete('m', ask({ signal: ac.signal }));
    expect(sent[0]?.signal).toBe(ac.signal);
  });
});

describe('openrouter', () => {
  it('requires parameters with a schema, attributes the app, asks for cost, and reports it', async () => {
    const { fetch, sent } = scriptedFetch([
      {
        body: chatReply({
          content: '{"action":"act"}',
          usage: { prompt_tokens: 100, completion_tokens: 9, cost: 0.00042 },
        }),
      },
    ]);
    const r = await openrouter({
      apiKey: 'or-key',
      appName: 'Jarvis',
      appUrl: 'https://example.com',
      fetch,
    }).complete('moonshotai/kimi-k2.7-code', ask({ schema: SCHEMA }));
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0]?.headers).toMatchObject({
      authorization: 'Bearer or-key',
      'x-title': 'Jarvis',
      'http-referer': 'https://example.com',
    });
    expect(sent[0]?.body).toMatchObject({ provider: { require_parameters: true }, usage: { include: true } });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 9, costUsd: 0.00042 });
  });

  it('treats "no endpoints … require_parameters" as a schema refusal, not a dead call', async () => {
    const { fetch, sent } = scriptedFetch([
      {
        status: 404,
        body: { error: { message: 'No endpoints found matching your data policy (require_parameters)' } },
      },
      { body: chatReply({ content: '{"action":"act"}' }) },
    ]);
    const r = await openrouter({ apiKey: 'k', fetch }).complete('m', ask({ schema: SCHEMA }));
    expect(sent).toHaveLength(2);
    expect(r.warnings).toContain('schema_relaxed');
  });

  it('sends no require_parameters on a plain text call', async () => {
    const { fetch, sent } = scriptedFetch([{ body: chatReply({ content: 'hi' }) }]);
    await openrouter({ apiKey: 'k', fetch }).complete('m', ask());
    expect(sent[0]?.body).not.toHaveProperty('provider');
  });
});
