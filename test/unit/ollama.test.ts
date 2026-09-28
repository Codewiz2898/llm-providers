import { describe, expect, it } from 'vitest';
import type { LlmError } from '../../src/errors.js';
import { ollama } from '../../src/providers/ollama.js';
import type { ProviderRequest } from '../../src/types.js';
import { scriptedFetch } from '../support/fetch.js';

const SCHEMA = { name: 'decision', schema: { type: 'object', properties: { action: { type: 'string' } } } };
const ask = (extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'You decide.',
  messages: [{ role: 'user', content: 'order a pepsi' }],
  maxTokens: 800,
  ...extra,
});

describe('ollama — the request', () => {
  it('uses the native /api/chat with think:false, the RAW schema, and one fixed num_ctx', async () => {
    const { fetch, sent } = scriptedFetch([
      { body: { message: { content: '{"action":"act"}' }, done_reason: 'stop' } },
      { body: { message: { content: '{"action":"noop"}' }, done_reason: 'stop' } },
    ]);
    const p = ollama({ numCtx: 32768, fetch });
    const r = await p.complete('qwen3:8b', ask({ schema: SCHEMA }));
    await p.complete('qwen3:8b', ask({ maxTokens: 50 }));
    expect(sent[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(sent[0]?.body).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      think: false,
      format: SCHEMA.schema,
      options: { num_ctx: 32768, num_predict: 800 },
    });
    // A different budget never changes the window — that would reload the model.
    expect((sent[1]?.body.options as { num_ctx: number }).num_ctx).toBe(32768);
    expect(r.json).toEqual({ action: 'act' });
  });

  it('turns thinking on only when adaptive thinking is asked for', async () => {
    const { fetch, sent } = scriptedFetch([{ body: { message: { content: 'x' } } }]);
    await ollama({ fetch }).complete('qwen3:8b', ask({ thinking: 'adaptive' }));
    expect(sent[0]?.body.think).toBe(true);
  });

  it('names a tool result by the tool, since Ollama has no call ids', async () => {
    const { fetch, sent } = scriptedFetch([{ body: { message: { content: 'ok' } } }]);
    await ollama({ fetch }).complete(
      'm',
      ask({
        messages: [
          { role: 'user', content: 'find pepsi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_0', name: 'search', args: { q: 'pepsi' } }],
          },
          { role: 'tool', toolCallId: 'call_0', content: '[]' },
        ],
      }),
    );
    expect((sent[0]?.body.messages as unknown[]).slice(2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search', arguments: { q: 'pepsi' } } }],
      },
      { role: 'tool', content: '[]', tool_name: 'search' },
    ]);
  });
});

describe('ollama — the reply', () => {
  it('returns tool calls with made-up ids, arguments as given', async () => {
    const { fetch } = scriptedFetch([
      {
        body: {
          message: { content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'pepsi' } } }] },
        },
      },
    ]);
    const r = await ollama({ fetch }).complete(
      'm',
      ask({ tools: [{ name: 'search', description: 's', parameters: {} }] }),
    );
    expect(r.finish).toBe('tool_calls');
    expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'search', args: { q: 'pepsi' } }]);
    expect(r.warnings).toEqual([]);
  });

  it('names truncation and an empty reply; reads the thinking when content is empty', async () => {
    const { fetch } = scriptedFetch([
      { body: { message: { content: '{"act' }, done_reason: 'length', eval_count: 800 } },
      { body: { message: { content: '' } } },
      { body: { message: { content: '', thinking: 'so {"action":"act"}' } } },
    ]);
    const p = ollama({ fetch });
    const cut = await p.complete('m', ask({ schema: SCHEMA }));
    expect(cut.finish).toBe('length');
    expect(cut.warnings).toEqual(expect.arrayContaining(['truncated', 'json_unparsed']));
    expect(cut.usage.outputTokens).toBe(800);
    expect((await p.complete('m', ask())).warnings).toContain('empty');
    const thought = await p.complete('m', ask({ schema: SCHEMA }));
    expect(thought.json).toEqual({ action: 'act' });
    expect(thought.warnings).toContain('reasoning_fallback');
  });

  it('an in-band error on a 200 is an error; so is an HTTP failure', async () => {
    const { fetch } = scriptedFetch([
      { body: { error: 'model "nope" not found, try pulling it first' } },
      { status: 404, body: 'not found' },
    ]);
    const p = ollama({ fetch });
    expect(((await p.complete('nope', ask()).catch((e) => e)) as LlmError).kind).toBe('server');
    expect(((await p.complete('nope', ask()).catch((e) => e)) as LlmError).kind).toBe('bad_request');
  });
});
