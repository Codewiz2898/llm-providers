/**
 * Anthropic, through the official SDK.
 *
 * What it keeps (DESIGN §6):
 *   - STREAMING, accumulated to the final message: at large max_tokens the SDK refuses a
 *     non-streaming request ("Streaming is required for operations that may take longer than 10
 *     minutes" — every Jarvis turn died on arrival at 64K). Callers still get one whole reply;
 *   - structured output is `output_config.format = { type: 'json_schema', schema }` — a `name` there
 *     is rejected ("Extra inputs are not permitted"), so the schema's name is never sent;
 *   - the reply's own content comes back as `raw`, because with thinking on, the thinking blocks
 *     must precede a tool result when the conversation continues.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LlmError, errorFromStatus } from '../errors.js';
import { extractJson } from '../json.js';
import type { Finish, Message, Provider, ToolCall, ToolChoice, Warning } from '../types.js';

/** The slice of the SDK this provider uses — so a test can hand it a fake. */
export interface AnthropicLike {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): { finalMessage(): Promise<Anthropic.Message> };
  };
}

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  /** A pre-built client (or a test fake). Otherwise one is made from `apiKey`. */
  client?: AnthropicLike;
}

const ID = 'anthropic';

function toolChoice(c: ToolChoice): Anthropic.ToolChoice {
  if (c === 'auto') return { type: 'auto' };
  if (c === 'required') return { type: 'any' };
  if (c === 'none') return { type: 'none' };
  return { type: 'tool', name: c.name };
}

/** Anthropic alternates user/assistant, and tool results travel as USER content — so consecutive
 * tool results merge into one user turn. */
export function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const last = out[out.length - 1];
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === 'tool_result')
      )
        last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant' && m.raw?.provider === ID) {
      out.push({ role: 'assistant', content: m.raw.content as Anthropic.ContentBlockParam[] });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
        ],
      });
    } else out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
}

function finishOf(r: Anthropic.StopReason | null): Finish {
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  if (r === 'max_tokens') return 'length';
  if (r === 'tool_use') return 'tool_calls';
  if (r === 'refusal') return 'refusal';
  return 'other';
}

export function anthropic(o: AnthropicOptions = {}): Provider {
  let client = o.client;
  const sdk = (): AnthropicLike => {
    client ??= new Anthropic({
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    });
    return client;
  };
  return {
    id: ID,
    async complete(model, req) {
      const outputConfig: Anthropic.OutputConfig = {
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.schema
          ? { format: { type: 'json_schema', schema: req.schema.schema as Record<string, unknown> } }
          : {}),
      };
      const body: Anthropic.MessageStreamParams = {
        model,
        max_tokens: req.maxTokens,
        messages: toAnthropicMessages(req.messages),
        ...(req.system
          ? {
              system: req.cacheSystem
                ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
                : req.system,
            }
          : {}),
        ...(req.thinking === 'adaptive' ? { thinking: { type: 'adaptive' } } : {}),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        ...(req.toolChoice && req.tools?.length ? { tool_choice: toolChoice(req.toolChoice) } : {}),
      };
      let res: Anthropic.Message;
      try {
        res = await sdk()
          .messages.stream(body, req.signal ? { signal: req.signal } : undefined)
          .finalMessage();
      } catch (e) {
        // A user abort and a dropped connection are the client's to classify (it knows which signal
        // fired); an HTTP failure is classified here, by status.
        if (e instanceof Anthropic.APIUserAbortError) throw e;
        if (e instanceof Anthropic.APIConnectionError)
          throw new LlmError({ kind: 'network', provider: ID, model, detail: e.message, cause: e });
        if (e instanceof Anthropic.APIError && typeof e.status === 'number')
          throw errorFromStatus(e.status, e.message, ID, model);
        throw e;
      }

      const warnings: Warning[] = [];
      const content = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const thinking = res.content
        .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('\n');
      let text = content;
      if (!content.trim() && thinking.trim() && !req.tools?.length) {
        text = thinking;
        warnings.push('reasoning_fallback');
      }
      const toolCalls: ToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => {
          const ok = Boolean(b.input) && typeof b.input === 'object' && !Array.isArray(b.input);
          if (!ok) warnings.push('tool_args_unparsed');
          return { id: b.id, name: b.name, args: ok ? (b.input as Record<string, unknown>) : {} };
        });
      const finish = finishOf(res.stop_reason);
      if (finish === 'length') warnings.push('truncated');
      if (!text.trim() && !toolCalls.length) warnings.push('empty');
      const parsed = req.schema && text.trim() ? extractJson(text) : undefined;
      if (req.schema && text.trim() && parsed === undefined) warnings.push('json_unparsed');
      const u = res.usage;
      return {
        text,
        ...(parsed !== undefined ? { json: parsed } : {}),
        toolCalls,
        finish,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
        },
        warnings: [...new Set(warnings)],
        raw: res.content,
      };
    },
  };
}
