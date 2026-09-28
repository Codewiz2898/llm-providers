import { describe, expect, it } from 'vitest';
import type { LlmError } from '../../src/errors.js';
import { askSystemOne, certainty, clm, isYes, jev } from '../../src/systemOne/index.js';
import { scriptedFetch } from '../support/fetch.js';

const Q = {
  pattern: {
    type: 'choice' as const,
    instructions: 'Which card?',
    criteria: { list: 'A list', none: 'Nothing fits' },
  },
};
const REPLY = {
  answers: {
    pattern: { type: 'choice', choice: 'list', confidence: 0.9, probabilities: { list: 0.95, none: 0.05 } },
  },
  usage: { cost: 0.00003 },
};

describe('System One targets', () => {
  it('Jev goes to OpenRouter with the OpenRouter key', async () => {
    const { fetch, sent } = scriptedFetch([{ body: REPLY }]);
    const r = await askSystemOne(jev({ apiKey: 'or-key' }), { user_asked: 'x' }, Q, { fetch });
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(sent[0]?.headers.authorization).toBe('Bearer or-key');
    expect(sent[0]?.body).toEqual({ model: 'jev-latest', state: { user_asked: 'x' }, questions: Q });
    expect(r.answers.pattern?.choice).toBe('list');
    expect(r.costUsd).toBe(0.00003);
  });

  it('CLM never receives a key it was not given — the OpenRouter key stays with OpenRouter', async () => {
    const { fetch, sent } = scriptedFetch([{ body: REPLY }, { body: REPLY }]);
    await askSystemOne(clm(), { user_asked: 'x' }, Q, { fetch });
    expect(sent[0]?.url).toBe('http://127.0.0.1:8700/v1/systemone');
    expect(sent[0]?.headers).not.toHaveProperty('authorization');
    expect(sent[0]?.body.model).toBe('clm-latest');
    // CLM's OWN key, when the server set one.
    await askSystemOne(clm({ apiKey: 'clm-own-key' }), {}, Q, { fetch });
    expect(sent[1]?.headers.authorization).toBe('Bearer clm-own-key');
  });

  it('throws typed errors: an HTTP failure by status, a reply with no answers as parse, a slow server as timeout', async () => {
    const http = scriptedFetch([{ status: 422, body: { detail: 'model not found' } }]);
    expect(((await askSystemOne(clm(), {}, Q, { fetch: http.fetch }).catch((e) => e)) as LlmError).kind).toBe(
      'bad_request',
    );
    const empty = scriptedFetch([{ body: {} }]);
    expect(
      ((await askSystemOne(clm(), {}, Q, { fetch: empty.fetch }).catch((e) => e)) as LlmError).kind,
    ).toBe('parse');
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError'))),
      )) as typeof fetch;
    expect(
      ((await askSystemOne(clm(), {}, Q, { fetch: hang, timeoutMs: 20 }).catch((e) => e)) as LlmError).kind,
    ).toBe('timeout');
  });
});

describe('certainty', () => {
  it('is confidence for a choice, and distance from a coin flip for a noul', () => {
    expect(certainty({ type: 'choice', choice: 'a', confidence: 0.8 })).toBe(0.8);
    expect(certainty({ type: 'noul', noul: 0.9 })).toBeCloseTo(0.8);
    expect(certainty({ type: 'noul', noul: 0.5 })).toBe(0);
    expect(isYes({ type: 'noul', noul: 0.51 })).toBe(true);
    expect(isYes({ type: 'noul', noul: 0.2 })).toBe(false);
  });
});
