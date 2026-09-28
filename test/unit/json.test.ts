import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/json.js';

describe('extractJson', () => {
  it('reads plain JSON, and JSON in a ```json fence', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('takes the LAST object in a reasoning model’s prose — its scratch examples come first', () => {
    const text = 'Maybe {"action":"noop"} ... but no. Final: {"action":"act","tool":"get_addresses"}';
    expect(extractJson(text)).toEqual({ action: 'act', tool: 'get_addresses' });
  });

  it('is not fooled by braces inside strings', () => {
    expect(extractJson('so {"note":"a } brace","ok":true} done')).toEqual({ note: 'a } brace', ok: true });
  });

  it('returns undefined — never throws — when there is no JSON', () => {
    expect(extractJson('')).toBeUndefined();
    expect(extractJson('no json here {oops')).toBeUndefined();
  });
});
