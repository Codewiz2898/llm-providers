import { describe, expect, it } from 'vitest';
import { createLlm } from '../../src/client.js';
import { anthropic } from '../../src/providers/anthropic.js';
import { ollama } from '../../src/providers/ollama.js';
import { openaiCompatible } from '../../src/providers/openaiCompatible.js';
import { openrouter } from '../../src/providers/openrouter.js';
import { askSystemOne, clm, jev } from '../../src/systemOne/index.js';
import type { CompletionRequest } from '../../src/types.js';
import { LIVE, liveKey } from '../support/env.js';

/**
 * LIVE smoke — opt-in (`LIVE=1 pnpm test:live`), a few cents at most. Each provider answers one
 * structured-JSON request for real; Ollama also makes a tool call. A provider whose key or server
 * is missing is skipped, never failed.
 *
 *   LLM_ENV_FILE=<dotenv with OPENROUTER_API_KEY, ANTHROPIC_API_KEY>
 *   LIVE_OLLAMA_MODEL (qwen3:4b) · LIVE_V1_MODEL (qwen2.5:0.5b) · LIVE_OPENROUTER_MODEL ·
 *   LIVE_ANTHROPIC_MODEL · CLM_URL
 */
const SCHEMA = {
  name: 'verdict',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string', enum: ['yes', 'no'] } },
    required: ['answer'],
    additionalProperties: false,
  },
};
const JSON_ASK: Omit<CompletionRequest, 'model'> = {
  system: 'Answer the question.',
  messages: [{ role: 'user', content: 'Is water wet? Reply as JSON.' }],
  maxTokens: 400,
  schema: SCHEMA,
  timeoutMs: 90_000,
};
const expectVerdict = (json: unknown) =>
  expect(['yes', 'no']).toContain((json as { answer?: string })?.answer);

const OLLAMA_MODEL = process.env.LIVE_OLLAMA_MODEL ?? 'qwen3:4b';
const orKey = liveKey('OPENROUTER_API_KEY');
const anKey = liveKey('ANTHROPIC_API_KEY');

describe.skipIf(!LIVE)('live', () => {
  const llm = createLlm({
    providers: {
      ollama: ollama({ numCtx: 8192 }),
      // Ollama's OpenAI-compatible endpoint stands in for a vLLM here: same wire, runs on a Mac.
      local: openaiCompatible({ id: 'ollama-v1', baseUrl: 'http://127.0.0.1:11434/v1' }),
      ...(orKey ? { openrouter: openrouter({ apiKey: orKey, appName: 'llm-providers live test' }) } : {}),
      ...(anKey ? { anthropic: anthropic({ apiKey: anKey }) } : {}),
    },
  });

  it('ollama: structured JSON', async () => {
    const r = await llm.complete({ model: `ollama:${OLLAMA_MODEL}`, ...JSON_ASK });
    expectVerdict(r.json);
  }, 120_000);

  it('ollama: a tool call', async () => {
    const r = await llm.complete({
      model: `ollama:${OLLAMA_MODEL}`,
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
      maxTokens: 300,
      timeoutMs: 90_000,
    });
    expect(r.toolCalls[0]?.name).toBe('get_weather');
    expect(String(r.toolCalls[0]?.args.city).toLowerCase()).toContain('paris');
  }, 120_000);

  // A NON-thinking model: Ollama's /v1 has no reliable thinking switch, and the point here is the
  // wire — the reasoning fallback is covered by the unit tests.
  it('openai-compatible (Ollama /v1 standing in for vLLM): structured JSON', async () => {
    const r = await llm.complete({
      model: `local:${process.env.LIVE_V1_MODEL ?? 'qwen2.5:0.5b'}`,
      ...JSON_ASK,
    });
    expectVerdict(r.json);
  }, 120_000);

  it.skipIf(!orKey)(
    'openrouter: structured JSON, with cost',
    async () => {
      const r = await llm.complete({
        model: `openrouter:${process.env.LIVE_OPENROUTER_MODEL ?? 'moonshotai/kimi-k2.7-code'}`,
        ...JSON_ASK,
        maxTokens: 2000,
      });
      expectVerdict(r.json);
      expect(r.usage.costUsd).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!anKey)(
    'anthropic: structured JSON',
    async () => {
      const r = await llm.complete({
        model: `anthropic:${process.env.LIVE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5'}`,
        ...JSON_ASK,
      });
      expectVerdict(r.json);
    },
    120_000,
  );

  it.skipIf(!orKey)(
    'system one: Jev answers a choice question',
    async () => {
      const r = await askSystemOne(
        jev({ apiKey: orKey as string }),
        { user_asked: 'toss a coin' },
        {
          kind: {
            type: 'choice',
            instructions: 'What kind of thing is being asked for?',
            criteria: { chance: 'a random result', fact: 'a fact to look up' },
          },
        },
      );
      expect(r.answers.kind?.choice).toBe('chance');
    },
    60_000,
  );

  it.skipIf(!process.env.CLM_URL)(
    'system one: CLM answers a choice question',
    async () => {
      const r = await askSystemOne(
        clm({ url: process.env.CLM_URL as string }),
        'Customer: my invoice was charged twice',
        {
          department: {
            type: 'choice',
            instructions: 'Which team?',
            criteria: { billing: 'Charges, invoices, refunds', technical: 'Bugs and outages' },
          },
        },
      );
      expect(r.answers.department?.choice).toBe('billing');
    },
    60_000,
  );
});
