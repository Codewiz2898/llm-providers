import { type IncomingMessage, type Server, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';
import { openaiCompatible } from '../../src/providers/openaiCompatible.js';
import { buildConfig, parseConfig } from '../../src/server/config.js';
import { startService } from '../../src/server/http.js';
import { startTelemetry } from '../../src/server/telemetry.js';

/**
 * The REAL exporters (docs/GATEWAY.md §5): OTLP/HTTP to the configured endpoint, and the upstream
 * model call as a child of the gateway's span. A local HTTP server stands in for the collector and
 * another for the model; nothing leaves this machine.
 */
const TOKEN = 'jarvis-token-0123456789abcdef';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN = '00f067aa0ba902b7';

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

async function listen(handler: (req: IncomingMessage, body: string) => [number, unknown]) {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const [status, reply] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in model: an OpenAI-compatible chat endpoint that always says "ok". */
const model = () =>
  listen(() => [
    200,
    {
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    },
  ]);

async function gateway(otlpEndpoint: string, upstream: string, spanExporter?: InMemorySpanExporter) {
  const telemetry = await startTelemetry(
    { otlpEndpoint, exportIntervalMs: 60_000 },
    '0.0.0-test',
    spanExporter ? { spanExporter } : {},
  );
  const built = buildConfig(parseConfig({ providers: {}, apps: { jarvis: { tokenEnv: 'J' } } }), {
    J: TOKEN,
  });
  const svc = await startService(
    { ...built, providers: { stub: openaiCompatible({ id: 'stub', baseUrl: `${upstream}/v1` }) } },
    { port: 0, log: () => {}, telemetry },
  );
  running.push(svc);
  // node:http, not fetch: this process's fetch is instrumented now (the gateway is in-process), and
  // it would add a SECOND traceparent to the caller's — which no real caller sends.
  const call = () =>
    new Promise<{ status: number }>((resolve, reject) => {
      const body = JSON.stringify({
        model: 'stub:m',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 5,
      });
      const r = request(
        `${svc.url}/v1/complete`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${TOKEN}`,
            traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01`,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  return { call, telemetry };
}

const parentOf = (s: unknown) =>
  (s as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId ??
  (s as { parentSpanId?: string }).parentSpanId;

describe('startTelemetry', () => {
  it('ships traces, metrics and logs over OTLP/HTTP to the configured collector', async () => {
    const received: string[] = [];
    const collector = await listen((req) => {
      received.push(`${req.method} ${req.url}`);
      return [200, {}];
    });
    const g = await gateway(collector, await model());
    expect((await g.call()).status).toBe(200);
    await g.telemetry.shutdown(); // flushes everything still buffered
    expect(new Set(received)).toEqual(new Set(['POST /v1/traces', 'POST /v1/metrics', 'POST /v1/logs']));
  });

  it('the upstream model call is a child of the gateway’s span — one trace, end to end', async () => {
    const spans = new InMemorySpanExporter();
    const collector = await listen(() => [200, {}]);
    const upstream = await model();
    const g = await gateway(collector, upstream, spans);
    await g.call();
    await g.telemetry.forceFlush(); // read before shutdown: the in-memory exporter clears on shutdown
    const finished = spans.getFinishedSpans();
    await g.telemetry.shutdown();
    const gatewaySpan = finished.find((s) => s.name === 'llm.complete');
    const upstreamSpan = finished.find((s) => s.name !== 'llm.complete');
    expect(gatewaySpan?.spanContext().traceId).toBe(TRACE_ID);
    expect(parentOf(gatewaySpan)).toBe(PARENT_SPAN);
    expect(upstreamSpan, `spans: ${finished.map((s) => s.name).join(', ')}`).toBeDefined();
    expect(upstreamSpan?.spanContext().traceId).toBe(TRACE_ID);
    expect(parentOf(upstreamSpan)).toBe(gatewaySpan?.spanContext().spanId);
  });

  it('can start again in the same process after a shutdown', async () => {
    const collector = await listen(() => [200, {}]);
    const upstream = await model();
    const first = await gateway(collector, upstream);
    await first.telemetry.shutdown();
    const second = await gateway(collector, upstream);
    expect((await second.call()).status).toBe(200);
    await second.telemetry.shutdown();
  });
});
