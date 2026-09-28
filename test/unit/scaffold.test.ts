import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/index.js';

describe('scaffold', () => {
  it('builds and runs a test', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
