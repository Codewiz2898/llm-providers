/**
 * OpenRouter: the OpenAI-compatible core plus its three quirks —
 *   - `provider.require_parameters` whenever a schema or tools are sent (see openaiCompatible.ts);
 *   - attribution headers, which make the OpenRouter dashboard readable per app;
 *   - `usage.include`, so each reply carries its cost in dollars.
 */
import type { Provider } from '../types.js';
import { openaiCompatible } from './openaiCompatible.js';

export interface OpenRouterOptions {
  apiKey: string;
  /** Shown on the OpenRouter dashboard (`X-Title`). */
  appName?: string;
  /** Sent as `HTTP-Referer`. */
  appUrl?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function openrouter(o: OpenRouterOptions): Provider {
  return openaiCompatible({
    id: 'openrouter',
    baseUrl: o.baseUrl ?? OPENROUTER_BASE_URL,
    apiKey: o.apiKey,
    headers: {
      ...(o.appUrl ? { 'http-referer': o.appUrl } : {}),
      ...(o.appName ? { 'x-title': o.appName } : {}),
    },
    extraBody: { usage: { include: true } },
    requireParameters: true,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}
