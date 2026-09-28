import { readFileSync } from 'node:fs';

/**
 * Keys for the live tests, read from `LLM_ENV_FILE` (a dotenv file) or the environment. A tiny
 * KEY=VALUE reader on purpose: it never echoes a value, and a malformed line — a bare value with no
 * name — is skipped, not executed. (Sourcing a .env in a shell once printed a key via
 * "command not found: <value>".)
 */
export function liveKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const file = process.env.LLM_ENV_FILE;
  if (!file) return undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] === name) return m[2]?.replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

export const LIVE = process.env.LIVE === '1';
