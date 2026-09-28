import { describe, expect, it } from 'vitest';
import { LlmError, errorFromStatus, redact } from '../../src/errors.js';

describe('LlmError', () => {
  it('classifies by status, with a schema refusal as its own kind', () => {
    expect(errorFromStatus(401, '', 'p', 'm').kind).toBe('auth');
    expect(errorFromStatus(429, '', 'p', 'm').kind).toBe('rate_limit');
    expect(errorFromStatus(503, '', 'p', 'm').kind).toBe('server');
    expect(errorFromStatus(400, '', 'p', 'm').kind).toBe('bad_request');
    expect(errorFromStatus(400, '', 'p', 'm', true).kind).toBe('schema_rejected');
  });

  it('never carries a key in its message, and cuts the detail to 300 characters', () => {
    const e = new LlmError({
      kind: 'auth',
      provider: 'openrouter',
      model: 'x',
      status: 401,
      detail: `bad key sk-or-v1-abcdef1234567890 / Authorization: Bearer abc.def-123 ${'x'.repeat(500)}`,
    });
    expect(e.message).not.toContain('abcdef1234567890');
    expect(e.message).not.toContain('abc.def-123');
    expect(e.detail?.length).toBeLessThanOrEqual(300);
    expect(redact('sk-ant-api03-zzzzzzzzzz')).toBe('sk-***');
  });
});
