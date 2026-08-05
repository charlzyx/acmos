#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type AppContext, createContext } from './app.ts';
import {
  ConfigError,
  type ConfigWatcher,
  loadAcmosConfig,
  watchAcmosConfig,
} from './config/load.ts';
import {
  configPath,
  configSnapshotPath,
  daemonLogPath,
  dataDir,
  envPath,
  logDir,
  runtimePath,
} from './config/paths.ts';
import { logger } from './log/logger.ts';
import { createServer } from './server.ts';

const NAME = 'acmos';
const VERSION = '0.1.12';
const START_TIMEOUT_MS = 5_000;

interface RuntimeInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  config: string;
}

interface ServiceInfo {
  host: string;
  port: number;
  url: string;
  config: string;
  status: 'healthy' | 'unhealthy' | 'not-running';
  warning?: string;
}

async function serviceInfo(): Promise<ServiceInfo> {
  const runtime = readRuntime();
  if (runtime && isProcessRunning(runtime.pid)) {
    const healthy = await isHealthy(runtime);
    if (healthy) {
      return {
        host: runtime.host,
        port: runtime.port,
        url: serviceUrl(runtime),
        config: runtime.config,
        status: 'healthy',
      };
    }
  }

  try {
    const loaded = await loadAcmosConfig();
    const info: RuntimeInfo = {
      pid: 0,
      host: loaded.config.host,
      port: loaded.config.port,
      startedAt: '',
      config: loaded.sourcePath,
    };
    return {
      host: info.host,
      port: info.port,
      url: serviceUrl(info),
      config: info.config,
      status: runtime && isProcessRunning(runtime.pid) ? 'unhealthy' : 'not-running',
      ...(runtime && isProcessRunning(runtime.pid)
        ? { warning: `PID ${runtime.pid} 存在，但健康检查失败；以下连接信息来自配置文件` }
        : {}),
    };
  } catch (err) {
    const info: RuntimeInfo = {
      pid: 0,
      host: '127.0.0.1',
      port: 20129,
      startedAt: '',
      config: configPath(),
    };
    const message = err instanceof ConfigError ? err.summary : '配置读取失败';
    return {
      host: info.host,
      port: info.port,
      url: serviceUrl(info),
      config: info.config,
      status: 'not-running',
      warning: `${message}；以下连接信息为默认值`,
    };
  }
}

async function helpText(): Promise<string> {
  const info = await serviceInfo();
  return `${NAME} ${VERSION}

启动:
  acmos serve        前台启动服务
  acmos serve -d     后台启动服务

连接${info.warning ? `（${info.warning}）` : ''}:
  Host/IP             ${info.host}
  Port                ${info.port}
  OpenAI Base URL     ${info.url}/v1
  Anthropic Base URL  ${info.url}

常用 URL:
  GET  ${info.url}/health
  GET  ${info.url}/v1/models
  POST ${info.url}/v1/chat/completions
  POST ${info.url}/v1/messages
  POST ${info.url}/v1/responses

配置文件: ${info.config}
Agent 文档: acmos --llm
`;
}

async function llmText(): Promise<string> {
  const info = await serviceInfo();
  const status = info.status;
  return `# acmos Agent Guide

acmos is a local multi-format AI proxy. Use this document to configure an AI client or diagnose acmos without guessing paths, ports, or protocols.

## Current installation

- Status: ${status}${info.warning ? ` (${info.warning})` : ''}
- Host/IP: ${info.host}
- Port: ${info.port}
- OpenAI-compatible base URL: ${info.url}/v1
- Anthropic base URL: ${info.url}
- Config: ${info.config}
- Secrets/env file: ${envPath()}
- Runtime state: ${runtimePath()}
- Redacted config snapshot: ${configSnapshotPath()}
- Structured logs: ${logDir()}/acmos-YYYY-MM-DD.jsonl
- Detached-process output: ${daemonLogPath()}

Do not print, copy, or commit API keys, OAuth tokens, the env file, raw request bodies, or unredacted logs.

## Start and inspect

\`\`\`bash
acmos serve          # foreground
acmos serve -d       # detached
acmos                # status, PID, port, URL, and config path
brew services restart acmos  # Homebrew-managed service
curl -fsS ${info.url}/health
\`\`\`

If acmos is installed by Homebrew, its default data directory is \`$(brew --prefix)/var/acmos\`. A source/direct install defaults to \`~/.acmos\`. \`ACMOS_HOME\` overrides the data directory; \`ACMOS_CONFIG\` overrides only the config file.

## Client configuration

OpenAI-compatible clients:

\`\`\`yaml
baseUrl: ${info.url}/v1
apiKey: <one local key from config apiKeys, if configured>
model: <choose an ID from GET /v1/models>
api: openai-completions
\`\`\`

Anthropic Messages clients:

\`\`\`text
ANTHROPIC_BASE_URL=${info.url}
ANTHROPIC_API_KEY=<one local key from config apiKeys, if configured>
model=<choose an ID from GET /v1/models>
\`\`\`

Endpoints:

- \`POST ${info.url}/v1/chat/completions\` — OpenAI Chat Completions
- \`POST ${info.url}/v1/messages\` — Anthropic Messages
- \`POST ${info.url}/v1/responses\` — OpenAI Responses
- \`GET ${info.url}/v1/models\` — configured direct and combo model IDs
- \`GET ${info.url}/health\` — health and config source

Use \`${info.url}/v1\` as an OpenAI base URL. Use \`${info.url}\` without \`/v1\` as an Anthropic base URL. Do not append an endpoint twice.

## Config model

\`\`\`yaml
host: 127.0.0.1
port: 20129
apiKeys: []  # local ingress authentication; prefer env references
proxy: http://127.0.0.1:7890

providers:
  example:
    wire: cc  # cc | am | resp
    baseUrl: https://example.com/v1
    proxy: true  # opt in to the top-level proxy
    apiKey: "\${env:EXAMPLE_API_KEY}"
    models:
      - id: example-model

combo:
  coder:
    members:
      - { provider: example, model: example-model }
\`\`\`

Provider secrets should live in the env file and be referenced as \`"\${env:NAME}"\`. Public model names are \`combo/<combo-id>\` or \`<provider-id>/<model-id>\`. After editing config, acmos hot-reloads valid changes and keeps the old config if validation fails.

## Diagnostic procedure

1. Run \`acmos\`. Confirm status, config path, Host/IP, and Port.
2. Run \`curl -fsS ${info.url}/health\`. If it fails, inspect the service and stderr logs.
3. Query \`${info.url}/v1/models\`. If \`apiKeys\` is configured, send \`Authorization: Bearer <local-key>\`; never expose the key in the report.
4. Inspect the config structure and the redacted snapshot. Do not output secret values.
5. Inspect recent warnings/errors:

\`\`\`bash
tail -n 200 ${logDir()}/acmos-$(date +%F).jsonl | jq 'select(.level == "warn" or .level == "error")'
tail -n 200 ${daemonLogPath()}
\`\`\`

6. Correlate one request using its \`x-acmos-request-id\` / log \`reqId\`.
7. Only for body-conversion bugs, temporarily set \`log.level: debug\` and \`log.captureBody: true\`, reproduce once, then immediately disable it. Treat captured bodies as sensitive.

Common failures:

- \`401/auth\`: distinguish local ingress \`apiKeys\` from provider credentials; for Codex verify \`~/.codex/auth.json\` and run \`codex login\` if refresh credentials are invalid.
- \`400/badRequest\`: check target \`wire\`, request endpoint, tool-call/result pairing, and provider \`compat\` settings.
- \`404/notFound\`: compare the requested model with \`GET /v1/models\` and combo/provider IDs.
- \`429/quota\`: inspect fallback, cooldown, key strategy, and provider quota.
- \`504/timeout\`: inspect \`firstByteTimeoutMs\`, \`timeoutMs\`, proxy configuration, and upstream connectivity.
- Process exists but health fails: inspect runtime state and stderr logs; do not kill an unrelated PID solely from a stale file.

## Safety

Keep \`host: 127.0.0.1\` for local use. Before binding externally, require strong \`apiKeys\`, TLS through a reverse proxy, and explicit user approval. Never silently weaken authentication or enable request-body capture.
`;
}

function readRuntime(): RuntimeInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(runtimePath(), 'utf8')) as Partial<RuntimeInfo>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.host !== 'string' ||
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 0 ||
      typeof value.startedAt !== 'string' ||
      typeof value.config !== 'string'
    ) {
      return undefined;
    }
    return value as RuntimeInfo;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function connectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '[::1]';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function serviceUrl(runtime: RuntimeInfo): string {
  return `http://${connectHost(runtime.host)}:${runtime.port}`;
}

async function isHealthy(runtime: RuntimeInfo): Promise<boolean> {
  if (runtime.port <= 0) return false;
  try {
    const response = await fetch(`${serviceUrl(runtime)}/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function removeRuntimeIfOwned(pid: number): void {
  const current = readRuntime();
  if (current?.pid !== pid) return;
  try {
    rmSync(runtimePath(), { force: true });
  } catch {
    // 退出清理失败不应覆盖原始退出状态。
  }
}

function claimRuntime(info: RuntimeInfo): void {
  mkdirSync(dataDir(), { recursive: true });
  const path = runtimePath();

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(info, null, 2), 'utf8');
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      const current = readRuntime();
      if (current && isProcessRunning(current.pid)) {
        throw new Error(`acmos 已在运行（PID ${current.pid}，端口 ${current.port}）`);
      }
      rmSync(path, { force: true });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  throw new Error(`无法创建运行状态文件：${path}`);
}

function updateRuntime(info: RuntimeInfo): void {
  writeFileSync(runtimePath(), JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function printStatusOrHelp(): Promise<void> {
  const runtime = readRuntime();
  if (!runtime || !isProcessRunning(runtime.pid)) {
    if (runtime) removeRuntimeIfOwned(runtime.pid);
    process.stdout.write(await helpText());
    return;
  }

  const healthy = await isHealthy(runtime);
  const status = healthy
    ? '运行中'
    : runtime.port === 0
      ? '启动中'
      : '异常（进程存在，健康检查失败）';
  process.stdout.write(
    `acmos ${status}\nPID: ${runtime.pid}\n端口: ${runtime.port || '等待分配'}\n地址: ${runtime.port ? serviceUrl(runtime) : '等待服务启动'}\n配置: ${runtime.config}\n`,
  );
}

async function serveForeground(): Promise<void> {
  let context: AppContext;
  let watcher: ConfigWatcher | undefined;

  try {
    watcher = await watchAcmosConfig({
      onUpdate: (loaded) => {
        void createContext(loaded, { store: context.store })
          .then((next) => {
            context = next;
            logger.info('配置已热重载', { source: loaded.sourcePath });
          })
          .catch((err) => logger.error('热重载失败，继续使用旧配置', { error: String(err) }));
      },
      onError: (err) => {
        logger.error('配置变更无效，继续使用旧配置', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
    context = await createContext(watcher.current);
  } catch (err) {
    await watcher?.unwatch().catch(() => undefined);
    if (err instanceof ConfigError) throw err;
    throw err;
  }

  const { config } = context.loaded;
  const runtime: RuntimeInfo = {
    pid: process.pid,
    host: config.host,
    port: config.port,
    startedAt: new Date().toISOString(),
    config: context.loaded.sourcePath,
  };
  try {
    claimRuntime(runtime);
  } catch (err) {
    context.store.close();
    await watcher.unwatch().catch(() => undefined);
    throw err;
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    const app = createServer(() => context);
    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 0,
      fetch: app.fetch,
    });
    runtime.port = server.port ?? config.port;
    updateRuntime(runtime);
  } catch (err) {
    removeRuntimeIfOwned(process.pid);
    context.store.close();
    await watcher.unwatch().catch(() => undefined);
    throw err;
  }

  logger.info('acmos 已启动', {
    url: serviceUrl(runtime),
    config: context.loaded.sourcePath,
    layers: context.loaded.layers.length,
    catalog: context.catalog.source,
    models: context.registry.listModels().length,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('正在关闭');
    await server.stop(true);
    await watcher.unwatch().catch(() => undefined);
    context.store.close();
    removeRuntimeIfOwned(process.pid);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function daemonCommand(): string[] {
  if (Bun.main.startsWith('/$bunfs/')) return [process.execPath, 'serve'];
  return [process.execPath, Bun.main, 'serve'];
}

async function serveDaemon(): Promise<void> {
  const current = readRuntime();
  if (current && isProcessRunning(current.pid)) {
    process.stdout.write(`acmos 已在运行（PID ${current.pid}，端口 ${current.port}）\n`);
    return;
  }
  if (current) removeRuntimeIfOwned(current.pid);

  mkdirSync(logDir(), { recursive: true });
  const logPath = daemonLogPath();
  const logFd = openSync(logPath, 'a', 0o600);
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(daemonCommand(), {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'ignore',
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = readRuntime();
    if (runtime?.pid === child.pid && (await isHealthy(runtime))) {
      process.stdout.write(
        `acmos 已在后台启动\nPID: ${runtime.pid}\n端口: ${runtime.port}\n地址: ${serviceUrl(runtime)}\n日志: ${logPath}\n`,
      );
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error(`后台服务启动失败，请查看日志：${logPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await printStatusOrHelp();
    return;
  }

  const [command, ...options] = args;
  if ((command === '--version' || command === '-v') && options.length === 0) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if ((command === '--help' || command === '-h' || command === 'help') && options.length === 0) {
    process.stdout.write(await helpText());
    return;
  }
  if (command === '--llm' && options.length === 0) {
    process.stdout.write(await llmText());
    return;
  }
  if (command === 'serve') {
    if (options.length === 0) {
      await serveForeground();
      return;
    }
    if (options.length === 1 && (options[0] === '-d' || options[0] === '--detach')) {
      await serveDaemon();
      return;
    }
  }

  process.stderr.write(`未知命令或选项: ${args.join(' ')}\n\n${await helpText()}`);
  process.exitCode = 2;
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${basename(process.execPath)}: ${message}\n`);
  process.exitCode = 1;
});
