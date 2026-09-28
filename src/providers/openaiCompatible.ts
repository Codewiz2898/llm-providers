/**
 * Any server that speaks `/v1/chat/completions`: a local vLLM, LM Studio, llama.cpp's server,
 * Together, Groq — and OpenRouter, which is this plus three quirks (./openrouter.ts).
 *
 * The lessons it keeps (DESIGN §6), each with a test:
 *   - a refused strict schema is retried ONCE in json_object mode with the schema in the prompt;
 *   - a reasoning model's answer can arrive in `reasoning` / `reasoning_content` with `content`
 *     empty — read it from there rather than losing the turn;
 *   - truncation and a reply with no text at all are named, never silent.
 */
import { LlmError, errorFromStatus } from '../errors.js';
import { extractJson, schemaInstruction } from '../json.js';
import type { Finish, Message, Provider, ProviderRequest, ToolCall, ToolChoice, Warning } from '../types.js';

export interface OpenAiCompatibleOptions {
  /** How this provider names itself in errors. Default `openai-compatible`. */
  id?: string;
  /** Up to and including `/v1`, e.g. `http://gpu-box:8000/v1`. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Merged into every request body — for a server's own knobs (vLLM `guided_json`, etc.). */
  extraBody?: Record<string, unknown>;
  /** OpenRouter only: refuse routes that cannot honour the schema or tools, instead of ignoring them. */
  requireParameters?: boolean;
  /**
   * Body fields sent when a call asks for `thinking: 'off'`. The OpenAI wire has no standard switch,
   * and a hybrid reasoning model (Qwen3) left alone spends the whole budget thinking — measured on
   * Ollama's /v1: 400 tokens of reasoning, no answer. Each server has its own: for vLLM serving
   * Qwen3, `{ chat_template_kwargs: { enable_thinking: false } }`.
   */
  thinkingOffBody?: Record<string, unknown>;
  fetch?: typeof fetch;
}

type WireMessage = Record<string, unknown>;
interface ChatResponse {
  error?: { message?: string };
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      refusal?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/** A 4xx naming the schema, `response_format`, or OpenRouter's `require_parameters` / "no endpoints"
 * refusal is the "this route cannot do strict" signal — the one error worth one relaxed retry. */
const SCHEMA_REFUSAL = /response_format|json_schema|schema|require_parameters|no endpoints/i;

export function toWireMessages(system: string | undefined, messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    else if (m.role === 'assistant' && m.toolCalls?.length)
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toolChoice(c: ToolChoice): unknown {
  return typeof c === 'string' ? c : { type: 'function', function: { name: c.name } };
}

function finishOf(reason: string | null | undefined, hasCalls: boolean): Finish {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || (hasCalls && !reason)) return 'tool_calls';
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'stop') return hasCalls ? 'tool_calls' : 'stop';
  return reason ? 'other' : 'stop';
}

export function openaiCompatible(o: OpenAiCompatibleOptions): Provider {
  const id = o.id ?? 'openai-compatible';
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = o.fetch ?? fetch;

  async function post(model: string, req: ProviderRequest, relaxed: boolean): Promise<Response> {
    const system =
      relaxed && req.schema
        ? `${req.system ? `${req.system}\n\n` : ''}${schemaInstruction(req.schema.schema)}`
        : req.system;
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens,
      messages: toWireMessages(system, req.messages),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.toolChoice && req.tools?.length ? { tool_choice: toolChoice(req.toolChoice) } : {}),
      ...(req.schema
        ? {
            response_format: relaxed
              ? { type: 'json_object' }
              : {
                  type: 'json_schema',
                  json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
                },
          }
        : {}),
      // Without this, OpenRouter treats response_format as a SOFT preference and may route to an
      // upstream that ignores it, returning 200 with unconstrained text (6 of 43 Jarvis author
      // calls). With it, an unsupported route is a loud 4xx the relaxed retry handles.
      ...(o.requireParameters && (req.schema || req.tools?.length)
        ? { provider: { require_parameters: true } }
        : {}),
      ...o.extraBody,
      ...(req.thinking === 'off' ? o.thinkingOffBody : {}),
    };
    return doFetch(url, {
      method: 'POST',
      ...(req.signal ? { signal: req.signal } : {}),
      headers: {
        'content-type': 'application/json',
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
        ...o.headers,
      },
      body: JSON.stringify(body),
    });
  }

  return {
    id,
    async complete(model, req) {
      const warnings: Warning[] = [];
      let res = await post(model, req, false);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const refused =
          Boolean(req.schema) && res.status >= 400 && res.status < 500 && SCHEMA_REFUSAL.test(detail);
        if (!refused) throw errorFromStatus(res.status, detail, id, model);
        warnings.push('schema_relaxed');
        res = await post(model, req, true);
        if (!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''), id, model, true);
      }
      const json = (await res.json()) as ChatResponse;
      // Some routers answer 200 with the upstream's failure in the body.
      if (json.error?.message)
        throw new LlmError({ kind: 'server', provider: id, model, detail: json.error.message });
      const choice = json.choices?.[0];
      const msg = choice?.message;
      const content = msg?.content ?? '';
      const reasoning = msg?.reasoning ?? msg?.reasoning_content ?? '';
      let text = content;
      if (!content.trim() && reasoning.trim()) {
        text = reasoning;
        warnings.push('reasoning_fallback');
      }
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => {
        const args = extractJson(c.function.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) warnings.push('tool_args_unparsed');
        return {
          id: c.id,
          name: c.function.name,
          args:
            args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        };
      });
      const finish = msg?.refusal ? 'refusal' : finishOf(choice?.finish_reason, toolCalls.length > 0);
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
          ...(json.usage?.prompt_tokens !== undefined ? { inputTokens: json.usage.prompt_tokens } : {}),
          ...(json.usage?.completion_tokens !== undefined
            ? { outputTokens: json.usage.completion_tokens }
            : {}),
          ...(json.usage?.cost !== undefined ? { costUsd: json.usage.cost } : {}),
        },
        warnings: [...new Set(warnings)],
      };
    },
  };
}
