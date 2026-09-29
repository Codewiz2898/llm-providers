import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../src/errors.js';
import { buildConfig, parseConfig } from '../../src/server/config.js';
import { startService } from '../../src/server/http.js';
import { CALL_BUCKETS, createTelemetry } from '../../src/server/telemetry.js';
import type { Provider, ProviderResult } from '../../src/types.js';

/**
 * docs/GATEWAY.md §5 — what one call leaves behind: metric points labelled by app, a span that is
 * the caller's child, and one log record that carries prompt text only on opt-in. In-memory
 * exporters stand in for the collector; the OTLP wire itself is telemetryOtlp.test.ts.
 */
const JARVIS = 'jarvis-token-0123456789abcdef';
const NOTEBOOK = 'scripts-token-0123456789abcdef';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

async function gatewayWithTelemetry(
  reply: () => Promise<ProviderResult> | ProviderResult,
  promptMaxChars = 40,
) {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const logs = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logs })],
  });
  const telemetry = createTelemetry({
    tracer: tracerProvider.getTracer('t'),
    meter: meterProvider.getMeter('t'),
    logger: loggerProvider.getLogger('t'),
    promptMaxChars,
  });
  const p: Provider = { id: 'fake', complete: async () => reply() };
  const built = buildConfig(
    parseConfig({
      providers: {},
      apps: { jarvis: { tokenEnv: 'J' }, scripts: { tokenEnv: 'S', capturePrompts: true } },
    }),
    { J: JARVIS, S: NOTEBOOK },
  );
  const svc = await startService({ ...built, providers: { p } }, { port: 0, log: () => {}, telemetry });
  running.push(svc);

  const call = (token: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fetch(`${svc.url}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({
        model: 'p:m',
        system: 'You are a careful assistant who answers briefly.',
        messages: [{ role: 'user', content: 'what is the capital of France?' }],
        maxTokens: 10,
        label: 'decision',
        ...extra,
      }),
    });

  const metric = async (name: string) => {
    await reader.forceFlush();
    const all =
      metricExporter
        .getMetrics()
        .at(-1)
        ?.scopeMetrics.flatMap((s) => s.metrics) ?? [];
    return all.find((m) => m.descriptor.name === name);
  };
  return { call, spans, logs, metric };
}

const OK: ProviderResult = {
  text: 'Paris.',
  toolCalls: [],
  finish: 'stop',
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.0021 },
  warnings: ['reasoning_fallback'],
};

const parentOf = (s: unknown) =>
  (s as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId ??
  (s as { parentSpanId?: string }).parentSpanId;

describe('metrics', () => {
  it('counts the call, its time, tokens, cost and warnings — every point labelled with the app', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    expect((await g.call(JARVIS)).status).toBe(200);
    const labels = { app: 'jarvis', provider: 'p', model: 'm', kind: 'decision', outcome: 'ok' };

    const calls = await g.metric('llm_calls_total');
    expect(calls?.dataPoints).toEqual([expect.objectContaining({ attributes: labels, value: 1 })]);

    const tokens = await g.metric('llm_tokens_total');
    expect(tokens?.dataPoints.map((d) => [d.attributes.direction, d.value])).toEqual([
      ['input', 12],
      ['output', 3],
    ]);
    expect((await g.metric('llm_cost_usd_total'))?.dataPoints[0]?.value).toBeCloseTo(0.0021);
    expect((await g.metric('llm_warnings_total'))?.dataPoints[0]?.attributes).toMatchObject({
      ...labels,
      warning: 'reasoning_fallback',
    });

    const duration = await g.metric('llm_call_duration_seconds');
    const point = duration?.dataPoints[0]?.value as { count: number; buckets: { boundaries: number[] } };
    expect(point.count).toBe(1);
    // A two-minute decision must land in a real bucket, not in +Inf.
    expect(point.buckets.boundaries).toEqual(CALL_BUCKETS);
    expect(CALL_BUCKETS.at(-1)).toBeGreaterThanOrEqual(300);
  });

  it('a failed call is counted with its kind as the outcome', async () => {
    const g = await gatewayWithTelemetry(() => {
      throw new LlmError({ kind: 'rate_limit', provider: 'fake', model: 'm', status: 429 });
    });
    expect((await g.call(JARVIS)).status).toBe(429);
    expect((await g.metric('llm_calls_total'))?.dataPoints[0]?.attributes).toMatchObject({
      app: 'jarvis',
      outcome: 'rate_limit',
    });
  });

  it('nothing is left in flight once a call is done', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(JARVIS);
    await g.call(JARVIS);
    expect((await g.metric('llm_inflight'))?.dataPoints[0]).toMatchObject({
      attributes: { app: 'jarvis' },
      value: 0,
    });
  });
});

describe('the span', () => {
  it('is the CALLER’s child when it sends a traceparent — one trace across both processes', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(JARVIS, {}, { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01` });
    const [span] = g.spans.getFinishedSpans();
    expect(span?.name).toBe('llm.complete');
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(parentOf(span)).toBe(PARENT_SPAN);
    expect(span?.attributes).toMatchObject({
      'app.id': 'jarvis',
      'llm.kind': 'decision',
      'gen_ai.system': 'p',
      'gen_ai.request.model': 'm',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 3,
      'llm.cost_usd': 0.0021,
    });
  });

  it('without a traceparent, it starts its own trace', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(JARVIS);
    const [span] = g.spans.getFinishedSpans();
    expect(parentOf(span)).toBeUndefined();
    expect(span?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a failed call is an error span naming its kind', async () => {
    const g = await gatewayWithTelemetry(() => {
      throw new LlmError({ kind: 'timeout', provider: 'fake', model: 'm' });
    });
    await g.call(JARVIS);
    const [span] = g.spans.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('timeout');
  });
});

describe('the log record', () => {
  it('carries the call’s facts and its trace — and no prompt text by default', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(JARVIS);
    const [log] = g.logs.getFinishedLogRecords();
    const [span] = g.spans.getFinishedSpans();
    expect(log?.attributes).toMatchObject({
      app: 'jarvis',
      provider: 'p',
      model: 'm',
      kind: 'decision',
      outcome: 'ok',
      input_tokens: 12,
      output_tokens: 3,
      captured: false,
    });
    expect(log?.spanContext?.traceId).toBe(span?.spanContext().traceId);
    expect(JSON.stringify(log?.attributes)).not.toContain('capital of France');
    expect(JSON.stringify(log?.attributes)).not.toContain('Paris');
  });

  it('an app that opted in gets its prompt and reply recorded, each cut to promptMaxChars', async () => {
    const g = await gatewayWithTelemetry(() => OK, 40);
    await g.call(NOTEBOOK);
    const a = g.logs.getFinishedLogRecords()[0]?.attributes ?? {};
    expect(a.captured).toBe(true);
    expect(a['response.text']).toBe('Paris.');
    expect(String(a['prompt.system'])).toMatch(
      /^You are a careful assistant who answers …\[\d+ more chars\]$/,
    );
    const messages = String(a['prompt.messages']);
    expect(messages.startsWith('[{"role":"user","content":"what is th')).toBe(true);
    expect(messages).toMatch(/…\[\d+ more chars\]$/);
    expect(messages.indexOf('…')).toBe(40); // cut at exactly promptMaxChars
  });

  it('a single call can opt in, on an app that did not', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(JARVIS, { capture: true });
    await g.call(JARVIS);
    const [first, second] = g.logs.getFinishedLogRecords();
    expect(first?.attributes.captured).toBe(true);
    expect(second?.attributes.captured).toBe(false);
  });

  it('never records a token — not in a log record, not on a span', async () => {
    const g = await gatewayWithTelemetry(() => OK);
    await g.call(NOTEBOOK);
    const everything = JSON.stringify([
      g.logs.getFinishedLogRecords().map((l) => l.attributes),
      g.spans.getFinishedSpans().map((s) => s.attributes),
    ]);
    expect(everything).not.toContain(NOTEBOOK);
    expect(everything).not.toContain(JARVIS);
  });
});
