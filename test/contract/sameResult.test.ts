import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLlm } from '../../src/client.js';
import { anthropic } from '../../src/providers/anthropic.js';
import { ollama } from '../../src/providers/ollama.js';
import { openaiCompatible } from '../../src/providers/openaiCompatible.js';
import { openrouter } from '../../src/providers/openrouter.js';
import type { CompletionRequest, Provider } from '../../src/types.js';
import { chatReply, scriptedFetch } from '../support/fetch.js';

/**
 * THE CONTRACT: one request, four providers, one result. Each provider's fake answers in its OWN
 * wire format; what comes out of `complete` must be identical. This is what stops four
 * implementations drifting apart as each gets its own fixes.
 */
type Case = 'json' | 'text' | 'tool';
const SCHEMA = { name: 'decision', schema: { type: 'object', properties: { action: { type: 'string' } } } };
const TOOL = {
  name: 'search',
  description: 'Search products',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

const REQUESTS: Record<Case, Omit<CompletionRequest, 'model'>> = {
  json: { messages: [{ role: 'user', content: 'decide' }], maxTokens: 100, schema: SCHEMA },
  text: { messages: [{ role: 'user', content: 'say hi' }], maxTokens: 100 },
  tool: {
    messages: [{ role: 'user', content: 'find pepsi' }],
    maxTokens: 100,
    tools: [TOOL],
    toolChoice: 'auto',
  },
};
const WANT = {
  json: { text: '{"action":"act"}', json: { action: 'act' }, toolCalls: [], finish: 'stop', warnings: [] },
  text: { text: 'hi', toolCalls: [], finish: 'stop', warnings: [] },
  tool: {
    text: '',
    toolCalls: [{ id: 'call_0', name: 'search', args: { q: 'pepsi' } }],
    finish: 'tool_calls',
    warnings: [],
  },
};

/** Each provider's native reply for each case. */
const openAiShaped = (c: Case) =>
  c === 'tool'
    ? chatReply({
        content: null,
        finish: 'tool_calls',
        toolCalls: [{ id: 'call_0', name: 'search', arguments: '{"q":"pepsi"}' }],
      })
    : chatReply({ content: c === 'json' ? '{"action":"act"}' : 'hi' });
const ollamaShaped = (c: Case) =>
  c === 'tool'
    ? {
        message: { content: '', tool_calls: [{ function: { name: 'search', arguments: { q: 'pepsi' } } }] },
        done_reason: 'stop',
      }
    : { message: { content: c === 'json' ? '{"action":"act"}' : 'hi' }, done_reason: 'stop' };
const anthropicShaped = (c: Case): Anthropic.Message =>
  ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'm',
    stop_sequence: null,
    stop_reason: c === 'tool' ? 'tool_use' : 'end_turn',
    content:
      c === 'tool'
        ? [{ type: 'tool_use', id: 'call_0', name: 'search', input: { q: 'pepsi' } }]
        : [{ type: 'text', text: c === 'json' ? '{"action":"act"}' : 'hi', citations: null }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  }) as unknown as Anthropic.Message;

const PROVIDERS: Record<string, (c: Case) => Provider> = {
  'openai-compatible': (c) =>
    openaiCompatible({ baseUrl: 'http://x/v1', fetch: scriptedFetch([{ body: openAiShaped(c) }]).fetch }),
  openrouter: (c) => openrouter({ apiKey: 'k', fetch: scriptedFetch([{ body: openAiShaped(c) }]).fetch }),
  ollama: (c) => ollama({ fetch: scriptedFetch([{ body: ollamaShaped(c) }]).fetch }),
  anthropic: (c) =>
    anthropic({ client: { messages: { stream: () => ({ finalMessage: async () => anthropicShaped(c) }) } } }),
};

describe('the same request gives the same result from every provider', () => {
  for (const c of ['json', 'text', 'tool'] as const) {
    for (const [name, make] of Object.entries(PROVIDERS)) {
      it(`${c} — ${name}`, async () => {
        const r = await createLlm({ providers: { p: make(c) } }).complete({ model: 'p:m', ...REQUESTS[c] });
        const { text, json, toolCalls, finish, warnings } = r;
        expect({ text, ...(json !== undefined ? { json } : {}), toolCalls, finish, warnings }).toEqual(
          WANT[c],
        );
        expect(r.message.role).toBe('assistant');
      });
    }
  }
});
