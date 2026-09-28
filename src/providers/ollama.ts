/**
 * Ollama, over its NATIVE `/api/chat` — not the OpenAI-compatible `/v1` shim, which pins the context
 * window at 4096 and ignores `num_ctx` (measured on 0.32.5 in Jarvis, LLD 50). A 16K-token reply
 * cannot fit a 4K window, so the shim is unusable for real work, not merely suboptimal.
 *
 * What it keeps (DESIGN §6):
 *   - `think: false` unless adaptive thinking is asked for — Qwen3 otherwise spends the output
 *     budget thinking. Safe to send to a model with no thinking support (200, not 400);
 *   - the schema goes RAW into `format` and decoding is grammar-constrained locally, so a schema
 *     cannot be refused and there is no relaxed retry;
 *   - ONE context window per provider instance: a `num_ctx` that changes between calls makes
 *     Ollama reload the model;
 *   - in-band failures arrive as a bare `error` string on a 200.
 */
import { LlmError, errorFromStatus } from '../errors.js';
import { extractJson } from '../json.js';
import type { Message, Provider, ToolCall, Warning } from '../types.js';

export interface OllamaOptions {
  /** Default `http://127.0.0.1:11434`. */
  baseUrl?: string;
  /**
   * The context window, fixed for this instance (see above). Default 16384 — large enough for a
   * long system prompt plus a full structured reply; each doubling costs KV-cache memory.
   */
  numCtx?: number;
  /** How long Ollama keeps the model loaded after a call, e.g. `30m`. Ollama's default otherwise. */
  keepAlive?: string;
  fetch?: typeof fetch;
}

interface OllamaResponse {
  error?: string;
  done_reason?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function: { name: string; arguments: unknown } }[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaMessages(
  system: string | undefined,
  messages: readonly Message[],
): Record<string, unknown>[] {
  const names = new Map<string, string>();
  const out: Record<string, unknown>[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) names.set(c.id, c.name);
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
      });
    } else if (m.role === 'tool') {
      // Ollama matches a tool result by the tool's NAME; it has no call ids.
      const name = m.toolCallId ? names.get(m.toolCallId) : undefined;
      out.push({ role: 'tool', content: m.content, ...(name ? { tool_name: name } : {}) });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function ollama(o: OllamaOptions = {}): Provider {
  const id = 'ollama';
  const url = `${(o.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`;
  const numCtx = o.numCtx ?? 16384;
  const doFetch = o.fetch ?? fetch;
  return {
    id,
    async complete(model, req) {
      const res = await doFetch(url, {
        method: 'POST',
        ...(req.signal ? { signal: req.signal } : {}),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: req.thinking === 'adaptive',
          ...(req.schema ? { format: req.schema.schema } : {}),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          ...(o.keepAlive ? { keep_alive: o.keepAlive } : {}),
          options: {
            num_ctx: numCtx,
            num_predict: req.maxTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
          messages: toOllamaMessages(req.system, req.messages),
        }),
      });
      if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''), id, model);
      const json = (await res.json()) as OllamaResponse;
      if (json.error) throw new LlmError({ kind: 'server', provider: id, model, detail: json.error });

      const warnings: Warning[] = [];
      const content = json.message?.content ?? '';
      const thinking = json.message?.thinking ?? '';
      let text = content;
      if (!content.trim() && thinking.trim()) {
        text = thinking;
        warnings.push('reasoning_fallback');
      }
      // Ollama returns arguments as an object and has no call ids; ids are made up so a caller can
      // pair results with calls the same way as on every other provider.
      const toolCalls: ToolCall[] = (json.message?.tool_calls ?? []).map((c, i) => {
        const raw = c.function.arguments;
        const args = typeof raw === 'string' ? extractJson(raw) : raw;
        const ok = Boolean(args) && typeof args === 'object' && !Array.isArray(args);
        if (!ok) warnings.push('tool_args_unparsed');
        return { id: `call_${i}`, name: c.function.name, args: ok ? (args as Record<string, unknown>) : {} };
      });
      const finish = json.done_reason === 'length' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop';
      if (finish === 'length') warnings.push('truncated');
      if (!text.trim() && !toolCalls.length) warnings.push('empty');
      const parsed = req.schema && text.trim() ? extractJson(text) : undefined;
      if (req.schema && text.trim() && parsed === undefined) warnings.push('json_unparsed');
      return {
        text,
        ...(parsed !== undefined ? { json: parsed } : {}),
        toolCalls,
        finish,
        usage: {
          ...(json.prompt_eval_count !== undefined ? { inputTokens: json.prompt_eval_count } : {}),
          ...(json.eval_count !== undefined ? { outputTokens: json.eval_count } : {}),
        },
        warnings: [...new Set(warnings)],
      };
    },
  };
}
