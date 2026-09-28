/**
 * A scripted `fetch`: answers in order, and keeps every request so a test can read exactly what was
 * sent. No network, ever.
 */
export interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

export function scriptedFetch(replies: { status?: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      signal: init?.signal ?? null,
    });
    const next = queue.shift() ?? { status: 500, body: { error: 'no scripted reply left' } };
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, sent };
}

/** An OpenAI-shaped chat completion reply. */
export function chatReply(o: {
  content?: string | null;
  reasoning?: string;
  reasoningContent?: string;
  finish?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  usage?: Record<string, number>;
}) {
  return {
    choices: [
      {
        finish_reason: o.finish ?? 'stop',
        message: {
          content: o.content ?? null,
          ...(o.reasoning !== undefined ? { reasoning: o.reasoning } : {}),
          ...(o.reasoningContent !== undefined ? { reasoning_content: o.reasoningContent } : {}),
          ...(o.toolCalls
            ? {
                tool_calls: o.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    ...(o.usage ? { usage: o.usage } : {}),
  };
}
