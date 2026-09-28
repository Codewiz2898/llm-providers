/**
 * Pull the JSON value out of a model's reply, however it chose to wrap it.
 *
 * `JSON.parse(text)` threw away good answers in Jarvis. Captured live from a reasoning model
 * (kimi-k2.7-code via OpenRouter): 6 kB of chain-of-thought with a complete, correct decision
 * object at the END — the parse failed and the turn became a silent noop, five times in one session.
 *
 * So: the whole string, then a fenced block, then the LAST balanced object. Last, not first: a
 * reasoning model quotes example objects mid-thought and commits to its answer at the end.
 *
 * Returns `undefined` when nothing parses — "no JSON here" and "JSON of the wrong shape" need
 * opposite fixes, so this never throws and never validates.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const unfenced = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim()
    : trimmed;
  for (const candidate of [unfenced, trimmed]) {
    const v = tryParse(candidate);
    if (v !== undefined) return v;
  }
  const fenced = unfenced.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const v = tryParse(fenced.trim());
    if (v !== undefined) return v;
  }
  const spans = objectSpans(unfenced);
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (!span) continue;
    const v = tryParse(unfenced.slice(span[0], span[1]));
    if (v !== undefined) return v;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Balanced `{…}` spans, respecting strings and escapes so a brace inside a quoted value cannot end
 * the object. In the order they close. */
function objectSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push([start, i + 1]);
        start = -1;
      } else if (depth < 0) {
        depth = 0; // a stray closer in prose — resynchronise rather than give up
      }
    }
  }
  return spans;
}

/** A JSON Schema written into a prompt, for providers that were refused the strict form. */
export function schemaInstruction(schema: object): string {
  return `Reply with ONLY a JSON object matching this schema (no prose, no code fence):\n${JSON.stringify(schema)}`;
}
