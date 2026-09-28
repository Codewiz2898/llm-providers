/**
 * llm-providers — one library for calling models, whoever serves them. See docs/DESIGN.md.
 */
export { createLlm, parseModelRef, DEFAULT_TIMEOUT_MS } from './client.js';
export type { CallEvent, Llm, LlmOptions } from './client.js';
export { LlmError, redact } from './errors.js';
export type { LlmErrorKind } from './errors.js';
export { extractJson } from './json.js';
export { anthropic } from './providers/anthropic.js';
export type { AnthropicOptions, AnthropicLike } from './providers/anthropic.js';
export { ollama } from './providers/ollama.js';
export type { OllamaOptions } from './providers/ollama.js';
export { openaiCompatible } from './providers/openaiCompatible.js';
export type { OpenAiCompatibleOptions } from './providers/openaiCompatible.js';
export { openrouter, OPENROUTER_BASE_URL } from './providers/openrouter.js';
export type { OpenRouterOptions } from './providers/openrouter.js';
export {
  askSystemOne,
  certainty,
  clm,
  isYes,
  jev,
  OPENROUTER_SYSTEMONE_URL,
} from './systemOne/index.js';
export type {
  ChoiceQuestion,
  NoulQuestion,
  ScoreQuestion,
  SystemOneAnswer,
  SystemOneQuestion,
  SystemOneResult,
  SystemOneTarget,
} from './systemOne/index.js';
export { buildConfig, ConfigError, configFromEnv, parseConfig } from './server/config.js';
export type { Built, ProviderConfig, ServiceConfig, SystemOneConfig } from './server/config.js';
export { createService, DEFAULT_PORT, STATUS_FOR_KIND, startService } from './server/http.js';
export type { RunningService, ServiceOptions } from './server/http.js';
export type * from './types.js';

export const VERSION = '0.1.0';
