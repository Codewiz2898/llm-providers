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

/**
 * An app that calls the gateway (docs/GATEWAY.md §4). Its token is named by variable, like a
 * provider key, never written here. Every call it makes is labelled with its id.
 */
export interface AppConfig {
  tokenEnv: string;
  /** Shown to providers that attribute calls (OpenRouter's `X-Title`). Default: the id. */
  title?: string;
  /** Sent as OpenRouter's referer. */
  url?: string;
  /** Record prompt and reply text for this app's calls (telemetry, opt-in). */
  capturePrompts?: boolean;
}

export interface ServiceConfig {
  providers: Record<string, ProviderConfig>;
  systemOne: Record<string, SystemOneConfig>;
  /** Callers with their own tokens. Absent: no app identity — the service as before. */
  apps?: Record<string, AppConfig>;
  /** With `apps`: accept a call with NO token, on loopback only, as app `anonymous`. Default true. */
  allowAnonymous?: boolean;
}

/** An app, made real: its token resolved from the environment. */
export interface App {
  id: string;
  token: string;
  title: string;
  url?: string;
  capturePrompts: boolean;
}

export interface Built {
  providers: Record<string, Provider>;
  systemOne: Record<string, SystemOneTarget>;
  /** Left out because their key's environment variable is unset — named, never valued. */
  skipped?: { name: string; reason: string }[];
  /** Present only when the config names apps. */
  apps?: Record<string, App>;
  allowAnonymous?: boolean;
}

/** The label for a call that carried no app token. */
export const ANONYMOUS = 'anonymous';
/** Long enough that it cannot be guessed; `openssl rand -hex 24` gives 48. */
export const MIN_APP_TOKEN_LENGTH = 16;
const APP_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A provider whose key is not in the environment: left out, not fatal (Jarvis doc 67 §5). */
class MissingKey extends Error {}

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
  const apps = raw.apps;
  if (apps !== undefined) {
    if (!isRecord(apps)) throw new ConfigError('"apps" must be an object of app id → settings');
    for (const [id, a] of Object.entries(apps)) {
      if (!APP_ID.test(id) || id === ANONYMOUS)
        throw new ConfigError(
          `apps.${id}: an app id is lowercase letters, digits, - and _ (and not "${ANONYMOUS}") — it becomes a metric label`,
        );
      if (!isRecord(a)) throw new ConfigError(`apps.${id}: settings must be an object`);
      if ('token' in a || 'apiKey' in a || 'key' in a)
        throw new ConfigError(
          `apps.${id}: tokens never go in the config file — put it in the environment and name the variable with "tokenEnv"`,
        );
      if (typeof a.tokenEnv !== 'string' || !a.tokenEnv)
        throw new ConfigError(`apps.${id}: "tokenEnv" names the variable that holds this app's token`);
      for (const f of ['title', 'url'] as const)
        if (a[f] !== undefined && typeof a[f] !== 'string')
          throw new ConfigError(`apps.${id}: "${f}" must be a string`);
      if (a.capturePrompts !== undefined && typeof a.capturePrompts !== 'boolean')
        throw new ConfigError(`apps.${id}: "capturePrompts" must be true or false`);
    }
  }
  if (raw.allowAnonymous !== undefined && typeof raw.allowAnonymous !== 'boolean')
    throw new ConfigError('"allowAnonymous" must be true or false');
  return {
    providers: check('providers', PROVIDER_TYPES),
    systemOne: check('systemOne', SYSTEM_ONE_TYPES),
    ...(apps !== undefined ? { apps: apps as Record<string, AppConfig> } : {}),
    ...(raw.allowAnonymous !== undefined ? { allowAnonymous: raw.allowAnonymous as boolean } : {}),
  };
}

/**
 * The config made real. A provider whose key variable is unset is LEFT OUT and reported in
 * `skipped` by the variable's NAME — so one config serves a machine that has only some keys, and
 * an absent Anthropic key just means no `anthropic` in /health.
 */
export function buildConfig(c: ServiceConfig, env: Env): Built {
  const key = (
    where: string,
    type: string,
    apiKeyEnv: string | undefined,
    required: boolean,
  ): string | undefined => {
    const name = apiKeyEnv ?? DEFAULT_KEY_ENV[type];
    const value = name ? env[name] : undefined;
    if (required && !value) throw new MissingKey(`${where}: ${name ?? '(no key variable named)'} is not set`);
    return value || undefined;
  };
  const skipped: { name: string; reason: string }[] = [];
  const guarded = (name: string, make: () => void) => {
    try {
      make();
    } catch (e) {
      if (!(e instanceof MissingKey)) throw e;
      skipped.push({ name, reason: e.message });
    }
  };
  const providers: Record<string, Provider> = {};
  for (const [name, p] of Object.entries(c.providers))
    guarded(name, () => {
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
    });
  const systemOne: Record<string, SystemOneTarget> = {};
  for (const [name, s] of Object.entries(c.systemOne))
    guarded(name, () => {
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
    });
  let apps: Record<string, App> | undefined;
  if (c.apps) {
    apps = {};
    const seen = new Map<string, string>();
    for (const [id, a] of Object.entries(c.apps))
      guarded(id, () => {
        const token = env[a.tokenEnv];
        if (!token) throw new MissingKey(`apps.${id}: ${a.tokenEnv} is not set`);
        if (token.length < MIN_APP_TOKEN_LENGTH)
          throw new ConfigError(
            `apps.${id}: ${a.tokenEnv} is shorter than ${MIN_APP_TOKEN_LENGTH} characters — use a random one (openssl rand -hex 24)`,
          );
        const other = seen.get(token);
        if (other)
          throw new ConfigError(
            `apps.${id}: shares its token with apps.${other} — every app needs its own, or calls cannot be told apart`,
          );
        seen.set(token, id);
        (apps as Record<string, App>)[id] = {
          id,
          token,
          title: a.title ?? id,
          ...(a.url ? { url: a.url } : {}),
          capturePrompts: a.capturePrompts ?? false,
        };
      });
  }
  return {
    providers,
    systemOne,
    ...(skipped.length ? { skipped } : {}),
    ...(apps ? { apps, allowAnonymous: c.allowAnonymous ?? true } : {}),
  };
}
