/**
 * What the service serves, from a JSON file or from the environment (docs/SERVICE.md §3).
 *
 * KEYS ARE NEVER IN THE FILE. A provider names the environment variable that holds its key
 * (`apiKeyEnv`), and a file that writes a key inline is refused — a config file gets committed,
 * pasted and shared; an environment does not.
 */
import { anthropic } from '../providers/anthropic.js';
import { ollama } from '../providers/ollama.js';
import { openaiCompatible } from '../providers/openaiCompatible.js';
import { openrouter } from '../providers/openrouter.js';
import { type SystemOneTarget, clm, jev } from '../systemOne/index.js';
import type { Provider } from '../types.js';

export type ProviderConfig =
  | { type: 'anthropic'; apiKeyEnv?: string; baseURL?: string }
  | { type: 'openrouter'; apiKeyEnv?: string; appName?: string; appUrl?: string; baseUrl?: string }
  | {
      type: 'openai-compatible';
      baseUrl: string;
      apiKeyEnv?: string;
      headers?: Record<string, string>;
      extraBody?: Record<string, unknown>;
      thinkingOffBody?: Record<string, unknown>;
    }
  | { type: 'ollama'; baseUrl?: string; numCtx?: number; keepAlive?: string };

export type SystemOneConfig =
  | { type: 'jev'; apiKeyEnv?: string; model?: string; url?: string }
  | { type: 'clm'; url?: string; model?: string; apiKeyEnv?: string };

export interface ServiceConfig {
  providers: Record<string, ProviderConfig>;
  systemOne: Record<string, SystemOneConfig>;
}

export interface Built {
  providers: Record<string, Provider>;
  systemOne: Record<string, SystemOneTarget>;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** No file: serve whatever the environment has keys for, plus a local Ollama. */
export function configFromEnv(env: Env): ServiceConfig {
  const providers: Record<string, ProviderConfig> = {};
  const systemOne: Record<string, SystemOneConfig> = {};
  if (env.ANTHROPIC_API_KEY) providers.anthropic = { type: 'anthropic' };
  if (env.OPENROUTER_API_KEY) {
    providers.openrouter = { type: 'openrouter' };
    systemOne.jev = { type: 'jev' };
  }
  providers.ollama = { type: 'ollama', ...(env.OLLAMA_URL ? { baseUrl: env.OLLAMA_URL } : {}) };
  if (env.CLM_URL) systemOne.clm = { type: 'clm', url: env.CLM_URL };
  return { providers, systemOne };
}

const PROVIDER_TYPES = ['anthropic', 'openrouter', 'openai-compatible', 'ollama'];
const SYSTEM_ONE_TYPES = ['jev', 'clm'];
const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  jev: 'OPENROUTER_API_KEY',
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A parsed config file, checked. Every refusal names the entry and says what to write instead. */
export function parseConfig(raw: unknown): ServiceConfig {
  if (!isRecord(raw))
    throw new ConfigError('config must be a JSON object with "providers" and optional "systemOne"');
  const check = (section: 'providers' | 'systemOne', types: string[]) => {
    const entries = raw[section] ?? {};
    if (!isRecord(entries)) throw new ConfigError(`"${section}" must be an object of name → settings`);
    for (const [name, c] of Object.entries(entries)) {
      if (!isRecord(c) || typeof c.type !== 'string' || !types.includes(c.type))
        throw new ConfigError(`${section}.${name}: "type" must be one of ${types.join(', ')}`);
      if ('apiKey' in c || 'key' in c || 'token' in c)
        throw new ConfigError(
          `${section}.${name}: keys never go in the config file — put the key in the environment and name the variable with "apiKeyEnv"`,
        );
      if (c.type === 'openai-compatible' && typeof c.baseUrl !== 'string')
        throw new ConfigError(
          `${section}.${name}: an openai-compatible server needs "baseUrl" (up to and including /v1)`,
        );
    }
    return entries as Record<string, never>;
  };
  return { providers: check('providers', PROVIDER_TYPES), systemOne: check('systemOne', SYSTEM_ONE_TYPES) };
}

/** The config made real. A named key variable that is unset is an error naming the VARIABLE. */
export function buildConfig(c: ServiceConfig, env: Env): Built {
  const key = (
    where: string,
    type: string,
    apiKeyEnv: string | undefined,
    required: boolean,
  ): string | undefined => {
    const name = apiKeyEnv ?? DEFAULT_KEY_ENV[type];
    const value = name ? env[name] : undefined;
    if (required && !value)
      throw new ConfigError(`${where}: the environment variable ${name ?? '(none named)'} is not set`);
    return value || undefined;
  };
  const providers: Record<string, Provider> = {};
  for (const [name, p] of Object.entries(c.providers)) {
    const where = `providers.${name}`;
    if (p.type === 'anthropic') {
      const apiKey = key(where, p.type, p.apiKeyEnv, true);
      providers[name] = anthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      });
    } else if (p.type === 'openrouter') {
      providers[name] = openrouter({
        apiKey: key(where, p.type, p.apiKeyEnv, true) as string,
        ...(p.appName ? { appName: p.appName } : {}),
        ...(p.appUrl ? { appUrl: p.appUrl } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      });
    } else if (p.type === 'openai-compatible') {
      const apiKey = p.apiKeyEnv ? key(where, p.type, p.apiKeyEnv, true) : undefined;
      providers[name] = openaiCompatible({
        id: name,
        baseUrl: p.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.extraBody ? { extraBody: p.extraBody } : {}),
        ...(p.thinkingOffBody ? { thinkingOffBody: p.thinkingOffBody } : {}),
      });
    } else {
      providers[name] = ollama({
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(p.numCtx ? { numCtx: p.numCtx } : {}),
        ...(p.keepAlive ? { keepAlive: p.keepAlive } : {}),
      });
    }
  }
  const systemOne: Record<string, SystemOneTarget> = {};
  for (const [name, s] of Object.entries(c.systemOne)) {
    const where = `systemOne.${name}`;
    if (s.type === 'jev') {
      systemOne[name] = jev({
        apiKey: key(where, s.type, s.apiKeyEnv, true) as string,
        ...(s.model ? { model: s.model } : {}),
        ...(s.url ? { url: s.url } : {}),
      });
    } else {
      // CLM's OWN key, only when named — never the OpenRouter key by default.
      const apiKey = s.apiKeyEnv ? key(where, s.type, s.apiKeyEnv, true) : undefined;
      systemOne[name] = clm({
        ...(s.url ? { url: s.url } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
    }
  }
  return { providers, systemOne };
}
