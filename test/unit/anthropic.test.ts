import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { LlmError } from '../../src/errors.js';
import { type AnthropicLike, anthropic } from '../../src/providers/anthropic.js';
import type { ProviderRequest } from '../../src/types.js';

/** A fake SDK: keeps what it was sent, answers with the scripted message (or throws). */
function fakeSdk(reply: Partial<Anthropic.Message> | Error) {
  const sent: { body: Anthropic.MessageStreamParams; signal?: AbortSignal }[] = [];
  const client: AnthropicLike = {
    messages: {
      stream(body, options) {
        sent.push({ body, ...(options?.signal ? { signal: options.signal } : {}) });
        return {
          finalMessage: async () => {
            if (reply instanceof Error) throw reply;
            return {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-8',
              stop_reason: 'end_turn',
              stop_sequence: null,
              content: [],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: null,
                cache_creation_input_tokens: null,
              },
              ...reply,
            } as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client, sent };
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.ContentBlock;
const SCHEMA = { name: 'decision', schema: { type: 'object', properties: { action: { type: 'string' } } } };
const ask = (extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'You decide.',
  messages: [{ role: 'user', content: 'order a pepsi' }],
  maxTokens: 64000,
  ...extra,
});

describe('anthropic — the request', () => {
  it('streams, sends the schema WITHOUT a name, and maps effort, thinking and a cached system prompt', async () => {
    const { client, sent } = fakeSdk({ content: [text('{"action":"act"}')] });
    const r = await anthropic({ client }).complete(
      'claude-opus-4-8',
      ask({ schema: SCHEMA, effort: 'high', thinking: 'adaptive', cacheSystem: true }),
    );
    expect(sent[0]?.body).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA.schema } },
      system: [{ type: 'text', text: 'You decide.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'order a pepsi' }],
    });
    expect(JSON.stringify(sent[0]?.body.output_config)).not.toContain('"name"');
    expect(r.json).toEqual({ action: 'act' });
  });

  it('maps tools and tool choice, and merges consecutive tool results into one user turn', async () => {
    const { client, sent } = fakeSdk({ content: [text('done')] });
    await anthropic({ client }).complete(
      'm',
      ask({
        tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'required',
        messages: [
          { role: 'user', content: 'find two things' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'search', args: { q: 'a' } },
              { id: 't2', name: 'search', args: { q: 'b' } },
            ],
          },
          { role: 'tool', toolCallId: 't1', content: 'A' },
          { role: 'tool', toolCallId: 't2', content: 'B' },
        ],
      }),
    );
    const body = sent[0]?.body;
    expect(body?.tools).toEqual([
      { name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(body?.tool_choice).toEqual({ type: 'any' });
    expect(body?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
          { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'A' },
          { type: 'tool_result', tool_use_id: 't2', content: 'B' },
        ],
      },
    ]);
  });

  it('sends an assistant turn back verbatim from `raw` — thinking blocks and all', async () => {
    const raw = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'tool_use', id: 't1', name: 's', input: {} },
    ];
    const { client, sent } = fakeSdk({ content: [text('ok')] });
    await anthropic({ client }).complete(
      'm',
      ask({
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', raw: { provider: 'anthropic', content: raw } },
          { role: 'tool', toolCallId: 't1', content: 'result' },
        ],
      }),
    );
    expect(sent[0]?.body.messages[1]).toEqual({ role: 'assistant', content: raw });
  });
});

describe('anthropic — the reply', () => {
  it('returns tool calls, the stop reason, usage with cache reads, and its raw content', async () => {
    const content = [
      text('Searching.'),
      {
        type: 'tool_use',
        id: 't1',
        name: 'search',
        input: { q: 'pepsi' },
        caller: { type: 'direct' },
      } as unknown as Anthropic.ContentBlock,
    ];
    const { client } = fakeSdk({
      content,
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 900,
        output_tokens: 40,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: null,
      } as Anthropic.Usage,
    });
    const r = await anthropic({ client }).complete('m', ask());
    expect(r.finish).toBe('tool_calls');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'search', args: { q: 'pepsi' } }]);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 40, cacheReadTokens: 800 });
    expect(r.raw).toBe(content);
  });

  it('names truncation, an empty reply, and a refusal', async () => {
    const cut = await anthropic({
      client: fakeSdk({ content: [text('{"act')], stop_reason: 'max_tokens' }).client,
    }).complete('m', ask({ schema: SCHEMA }));
    expect(cut.finish).toBe('length');
    expect(cut.warnings).toEqual(expect.arrayContaining(['truncated', 'json_unparsed']));
    const none = await anthropic({ client: fakeSdk({ content: [] }).client }).complete('m', ask());
    expect(none.warnings).toContain('empty');
    const no = await anthropic({
      client: fakeSdk({ content: [text('I can’t help with that.')], stop_reason: 'refusal' }).client,
    }).complete('m', ask());
    expect(no.finish).toBe('refusal');
  });

  it('classifies HTTP failures by status, a dropped connection as network, and passes a user abort through', async () => {
    const http = new Anthropic.APIError(429, { type: 'error' }, 'rate limited', new Headers());
    expect(
      (
        (await anthropic({ client: fakeSdk(http).client })
          .complete('m', ask())
          .catch((e) => e)) as LlmError
      ).kind,
    ).toBe('rate_limit');
    const net = new Anthropic.APIConnectionError({ message: 'socket hang up' });
    expect(
      (
        (await anthropic({ client: fakeSdk(net).client })
          .complete('m', ask())
          .catch((e) => e)) as LlmError
      ).kind,
    ).toBe('network');
    const abort = new Anthropic.APIUserAbortError();
    expect(
      await anthropic({ client: fakeSdk(abort).client })
        .complete('m', ask())
        .catch((e) => e),
    ).toBe(abort);
  });

  it('hands the abort signal to the SDK', async () => {
    const { client, sent } = fakeSdk({ content: [text('x')] });
    const ac = new AbortController();
    await anthropic({ client }).complete('m', ask({ signal: ac.signal }));
    expect(sent[0]?.signal).toBe(ac.signal);
  });
});
