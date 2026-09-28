/**
 * The one contract every provider speaks (docs/DESIGN.md §5). A caller writes a request once and
 * picks who serves it with the model ref; what comes back has the same shape from all of them.
 */

export type Role = 'user' | 'assistant' | 'tool';

/** A tool the model asked to run. `args` is already parsed; a reply whose arguments were not JSON
 * arrives as `{}` with the `tool_args_unparsed` warning. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** On an assistant message: the calls it made, so the conversation can continue after them. */
  toolCalls?: ToolCall[];
  /** On a tool message: which call this is the result of. */
  toolCallId?: string;
  /**
   * On an assistant message taken from `CompletionResult.message`: the provider's own content, sent
   * back verbatim when the conversation continues with the SAME provider. Anthropic needs it — with
   * thinking on, the thinking blocks must precede a tool result or the next call is refused.
   */
  raw?: { provider: string; content: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: object;
}

export type ToolChoice = 'auto' | 'required' | 'none' | { name: string };

/** Structured output: the reply must be a JSON document matching `schema`. */
export interface OutputSchema {
  name: string;
  schema: object;
}

export interface CompletionRequest {
  /** `provider:model` — split on the FIRST colon, so `ollama:qwen3:8b` keeps its tag. */
  model: string;
  system?: string;
  messages: Message[];
  maxTokens: number;
  schema?: OutputSchema;
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /** `off` also tells Ollama `think: false`; `adaptive` turns on Anthropic's adaptive thinking. */
  thinking?: 'off' | 'adaptive';
  /** Anthropic `output_config.effort`; ignored where a provider has no such setting. */
  effort?: 'low' | 'medium' | 'high';
  /** Anthropic prompt caching on the system prompt — worth it once the prompt is large and reused. */
  cacheSystem?: boolean;
  temperature?: number;
  /** Default 120 000. Combined with `signal`; the error says which of the two fired. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** What the call is FOR ("decision", "author") — echoed to `onCall`, never sent anywhere. */
  label?: string;
}

/** What a provider receives: the model already split off the ref, the timeout already folded into
 * `signal`. Providers never see the ref or the timeout — the client owns both. */
export type ProviderRequest = Omit<CompletionRequest, 'model' | 'timeoutMs' | 'label'>;

export type Finish = 'stop' | 'length' | 'tool_calls' | 'refusal' | 'other';

/**
 * Each warning is a lesson one of Jarvis's clients learned the hard way (DESIGN §6). An open list:
 * a new lesson is a new member, never a new return type.
 */
export type Warning =
  /** The strict schema was refused; the reply came from json_object mode with the schema in the prompt. */
  | 'schema_relaxed'
  /** `content` was empty and the answer was read out of the reasoning text. */
  | 'reasoning_fallback'
  /** The reply stopped at max tokens. */
  | 'truncated'
  /** No text at all — a budget or provider problem, not the model choosing silence. */
  | 'empty'
  /** A schema was asked for and the text did not parse as JSON. */
  | 'json_unparsed'
  /** A tool call's arguments were not valid JSON. */
  | 'tool_args_unparsed';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache reads and writes, where the provider reports them (Anthropic). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** When the provider reports it (OpenRouter does). */
  costUsd?: number;
}

export interface CompletionResult {
  text: string;
  /** Present when a schema was given and the text parsed. */
  json?: unknown;
  toolCalls: ToolCall[];
  /** The assistant turn to append when continuing — after tool calls, say. Carries `raw` where the
   * provider needs its own content back. */
  message: Message;
  finish: Finish;
  usage: Usage;
  provider: string;
  model: string;
  ms: number;
  warnings: Warning[];
}

/** One provider. `complete` may throw `LlmError`; anything else it throws the client maps. */
export interface Provider {
  readonly id: string;
  complete(model: string, req: ProviderRequest): Promise<ProviderResult>;
}

/** What a provider returns; the client adds who answered, how long it took, and `message`. */
export type ProviderResult = Omit<CompletionResult, 'provider' | 'model' | 'ms' | 'message'> & {
  /** The provider's own reply content, when continuing needs it back (see `Message.raw`). */
  raw?: unknown;
};
