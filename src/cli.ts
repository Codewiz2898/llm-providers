#!/usr/bin/env node
/**
 *   llm-providers serve [--config llm.json] [--host 127.0.0.1] [--port 8787]
 *
 * Without --config, providers come from the environment (ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
 * OLLAMA_URL, CLM_URL). LLM_PROVIDERS_TOKEN adds one shared bearer token, required off loopback —
 * or, as a gateway, the config's `apps` give each app its own. See docs/SERVICE.md, docs/GATEWAY.md.
 */
import { readFileSync } from 'node:fs';
import { VERSION } from './index.js';
import { ConfigError, buildConfig, configFromEnv, parseConfig } from './server/config.js';
import { DEFAULT_PORT, isLoopback, startService } from './server/http.js';

const USAGE = 'usage: llm-providers serve [--config <file.json>] [--host 127.0.0.1] [--port 8787]';

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== 'serve' || rest.includes('--help')) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(command === 'serve' || command === '--help' || command === undefined ? 0 : 2);
  }
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const file = flag('config');
  let raw: unknown;
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
    }
  }
  const config = file ? parseConfig(raw) : configFromEnv(process.env);
  const built = buildConfig(config, process.env);
  const port = Number(flag('port') ?? DEFAULT_PORT);
  // Loaded only when asked for: a service without `telemetry` never loads the OpenTelemetry SDK.
  const telemetry = config.telemetry
    ? await (await import('./server/telemetry.js')).startTelemetry(config.telemetry, VERSION)
    : undefined;
  const svc = await startService(built, {
    port,
    ...(flag('host') ? { host: flag('host') as string } : {}),
    ...(process.env.LLM_PROVIDERS_TOKEN ? { token: process.env.LLM_PROVIDERS_TOKEN } : {}),
    ...(telemetry ? { telemetry } : {}),
  });
  const apps = built.apps
    ? `; apps: ${Object.keys(built.apps).join(', ') || 'none'} (tokenless calls: ${built.allowAnonymous !== false && isLoopback(flag('host') ?? '127.0.0.1') ? 'accepted as anonymous' : 'refused'})`
    : '';
  process.stderr.write(
    `llm-providers serving on ${svc.url} — providers: ${Object.keys(built.providers).join(', ') || 'none'}; system one: ${Object.keys(built.systemOne).join(', ') || 'none'}${apps}\n`,
  );
  for (const s of built.skipped ?? []) process.stderr.write(`llm-providers skipped ${s.name}: ${s.reason}\n`);
  if (config.telemetry)
    process.stderr.write(
      `llm-providers telemetry → ${config.telemetry.otlpEndpoint} as ${config.telemetry.serviceName ?? 'llm-gateway'}\n`,
    );
  // Flush what telemetry still holds before going — the last calls are the ones you will look for.
  const stop = () =>
    void svc
      .close()
      .then(() => telemetry?.shutdown())
      .then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`llm-providers: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof ConfigError ? 2 : 1);
});
