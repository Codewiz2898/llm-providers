/**
 * The gateway's OpenTelemetry (docs/GATEWAY.md §5): one span, one set of metric points and one log
 * record per call, every one labelled with the calling app.
 *
 * Loaded only when a config has `telemetry` (the CLI imports it lazily), and reachable from code as
 * `llm-providers/telemetry` — importing the library itself never loads the SDK.
 *
 * `createTelemetry` takes the three providers, so tests hand it in-memory exporters; `startTelemetry`
 * builds the real OTLP/HTTP ones.
 */
import {
  type Attributes,
  type Meter,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  type Tracer,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { type Logger, SeverityNumber } from '@opentelemetry/api-logs';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import type { TelemetryConfig } from './config.js';
import type { CallRecord, Captured, ServiceTelemetry } from './http.js';

/** Seconds. A two-minute decision is normal for Jarvis, so the top buckets are wide on purpose. */
export const CALL_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 90, 120, 180, 300];
/** Seconds. System One answers in ~400 ms; anything past a few seconds is a problem to see. */
export const SYSTEMONE_BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10, 30];
export const DEFAULT_PROMPT_MAX_CHARS = 65_536;

/** A label for a call that carried none — never an empty label value. */
const NO_LABEL = 'none';

const headerGetter: TextMapGetter<Record<string, string | string[] | undefined>> = {
  keys: (c) => Object.keys(c),
  get: (c, k) => c[k.toLowerCase()],
};

export function createTelemetry(o: {
  tracer: Tracer;
  meter: Meter;
  logger: Logger;
  promptMaxChars?: number;
}): ServiceTelemetry {
  const m = o.meter;
  const calls = m.createCounter('llm_calls_total', { description: 'Model calls through the gateway.' });
  const duration = m.createHistogram('llm_call_duration_seconds', {
    description: 'Wall time of one model call, as the gateway saw it.',
    unit: 's',
    advice: { explicitBucketBoundaries: CALL_BUCKETS },
  });
  const tokens = m.createCounter('llm_tokens_total', {
    description: 'Tokens, by direction: input, output, cache_read, cache_write.',
  });
  const cost = m.createCounter('llm_cost_usd_total', {
    description: 'Spend in US dollars, where the provider reports it (OpenRouter does).',
  });
  const warnings = m.createCounter('llm_warnings_total', {
    description: 'Named anomalies: truncated, reasoning_fallback, schema_relaxed, empty, …',
  });
  const inflight = m.createUpDownCounter('llm_inflight', { description: 'Calls in progress, per app.' });
  const s1calls = m.createCounter('systemone_calls_total', {
    description: 'System One questions (Jev, CLM).',
  });
  const s1duration = m.createHistogram('systemone_duration_seconds', {
    description: 'Wall time of one System One round trip.',
    unit: 's',
    advice: { explicitBucketBoundaries: SYSTEMONE_BUCKETS },
  });
  const s1cost = m.createCounter('systemone_cost_usd_total', {
    description: 'System One spend in US dollars.',
  });

  const propagator = new W3CTraceContextPropagator();
  const max = o.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;
  const cut = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length <= max ? s : `${s.slice(0, max)}…[${s.length - max} more chars]`;
  };
  const capturedAttributes = (c: Captured): Attributes => {
    const out: Attributes = {};
    const put = (key: string, v: unknown) => {
      if (v !== undefined) out[key] = cut(v);
    };
    put('prompt.system', c.system);
    put('prompt.messages', c.messages);
    put('prompt.tools', c.tools);
    put('response.text', c.reply);
    put('response.tool_calls', c.toolCalls);
    put('systemone.state', c.state);
    put('systemone.questions', c.questions);
    put('systemone.answers', c.answers);
    return out;
  };

  return {
    async span(name, headers, run) {
      const parent = propagator.extract(ROOT_CONTEXT, headers as Record<string, string>, headerGetter);
      const span = o.tracer.startSpan(name, { kind: SpanKind.SERVER }, parent);
      try {
        // Active, so an instrumented fetch (the upstream call) becomes this span's child.
        return await context.with(trace.setSpan(parent, span), () => run(span));
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.end();
      }
    },

    record(r: CallRecord, rawSpan: unknown, captured?: Captured) {
      const span = rawSpan as Span | undefined;
      const outcome = r.ok ? 'ok' : (r.error?.kind ?? 'server');
      const kind = r.label ?? NO_LABEL;
      const u = r.usage ?? {};
      let labels: Attributes;
      if (r.type === 'complete') {
        labels = { app: r.app, provider: r.provider, model: r.model, kind, outcome };
        calls.add(1, labels);
        duration.record(r.ms / 1000, labels);
        const byDirection: [string, number | undefined][] = [
          ['input', u.inputTokens],
          ['output', u.outputTokens],
          ['cache_read', u.cacheReadTokens],
          ['cache_write', u.cacheWriteTokens],
        ];
        for (const [direction, n] of byDirection) if (n) tokens.add(n, { ...labels, direction });
        if (u.costUsd) cost.add(u.costUsd, labels);
        for (const w of r.warnings ?? []) warnings.add(1, { ...labels, warning: w });
      } else {
        labels = { app: r.app, target: r.provider, kind, outcome };
        s1calls.add(1, labels);
        s1duration.record(r.ms / 1000, labels);
        if (u.costUsd) s1cost.add(u.costUsd, labels);
      }

      // The span: GenAI semantic-convention names where they exist, ours where they do not.
      span?.setAttributes({
        'app.id': r.app,
        'llm.kind': kind,
        'llm.outcome': outcome,
        'gen_ai.system': r.provider,
        'gen_ai.request.model': r.model,
        ...(u.inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': u.inputTokens } : {}),
        ...(u.outputTokens !== undefined ? { 'gen_ai.usage.output_tokens': u.outputTokens } : {}),
        ...(r.finish ? { 'gen_ai.response.finish_reasons': [r.finish] } : {}),
        ...(u.costUsd !== undefined ? { 'llm.cost_usd': u.costUsd } : {}),
        ...(r.warnings?.length ? { 'llm.warnings': r.warnings } : {}),
        ...(r.ok ? {} : { 'error.type': outcome }),
      });
      if (!r.ok) span?.setStatus({ code: SpanStatusCode.ERROR, message: r.error?.message ?? outcome });

      // The log record: everything above, the trace it belongs to, and text only on opt-in.
      o.logger.emit({
        severityNumber: r.ok ? SeverityNumber.INFO : SeverityNumber.WARN,
        severityText: r.ok ? 'INFO' : 'WARN',
        body:
          r.type === 'complete'
            ? `llm call ${r.app} ${r.provider}:${r.model} ${outcome} ${r.ms}ms`
            : `system-one call ${r.app} ${r.provider} ${outcome} ${r.ms}ms`,
        attributes: {
          ...labels,
          type: r.type,
          ms: r.ms,
          ...(r.finish ? { finish: r.finish } : {}),
          ...(u.inputTokens !== undefined ? { input_tokens: u.inputTokens } : {}),
          ...(u.outputTokens !== undefined ? { output_tokens: u.outputTokens } : {}),
          ...(u.costUsd !== undefined ? { cost_usd: u.costUsd } : {}),
          // A plain string, so a Loki query can group by it (an array lands as its JSON text).
          ...(r.warnings?.length ? { warnings: r.warnings.join(',') } : {}),
          ...(r.error ? { error: r.error.message } : {}),
          captured: Boolean(captured),
          ...(captured ? capturedAttributes(captured) : {}),
        },
        ...(span ? { context: trace.setSpan(ROOT_CONTEXT, span) } : {}),
      });
    },

    inflight(app, delta) {
      inflight.add(delta, { app });
    },
  };
}

/** Real exporters, OTLP/HTTP to `otlpEndpoint`. `shutdown` flushes whatever is still buffered. */
export async function startTelemetry(
  c: TelemetryConfig,
  version: string,
  /** Tests only: where spans go instead of OTLP, to read them back without decoding protobuf. */
  overrides: { spanExporter?: SpanExporter } = {},
): Promise<ServiceTelemetry & { forceFlush(): Promise<void>; shutdown(): Promise<void> }> {
  const ep = c.otlpEndpoint.replace(/\/+$/, '');
  const resource = resourceFromAttributes({
    'service.name': c.serviceName ?? 'llm-gateway',
    'service.version': version,
  });
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(overrides.spanExporter ?? new OTLPTraceExporter({ url: `${ep}/v1/traces` })),
    ],
  });
  // Global: the async context manager (so a span survives an `await`) and the W3C propagator.
  tracerProvider.register();
  // The upstream call — OpenRouter, Anthropic, Ollama, Jev — as a child span of the gateway's.
  const unregister = registerInstrumentations({
    tracerProvider,
    instrumentations: [new UndiciInstrumentation()],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${ep}/v1/metrics` }),
        exportIntervalMillis: c.exportIntervalMs ?? 10_000,
      }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${ep}/v1/logs` }) })],
  });
  const t = createTelemetry({
    tracer: tracerProvider.getTracer('llm-providers', version),
    meter: meterProvider.getMeter('llm-providers', version),
    logger: loggerProvider.getLogger('llm-providers', version),
    ...(c.promptMaxChars ? { promptMaxChars: c.promptMaxChars } : {}),
  });
  return {
    ...t,
    async forceFlush() {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider.forceFlush(),
      ]);
    },
    async shutdown() {
      unregister();
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
      // Release the globals `register()` took, so a later start in the same process registers anew.
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
