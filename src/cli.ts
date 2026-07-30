#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type AppContext, createContext } from './app.ts';
import { ConfigError, type ConfigWatcher, watchAcmosConfig } from './config/load.ts';
import { configPath, daemonLogPath, dataDir, logDir, runtimePath } from './config/paths.ts';
import { logger } from './log/logger.ts';
import { createServer } from './server.ts';

const NAME = 'acmos';
const VERSION = '0.1.6';
const START_TIMEOUT_MS = 5_000;

interface RuntimeInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  config: string;
}

function helpText(): string {
  return `${NAME} ${VERSION}

启动:
  acmos serve        前台启动服务
  acmos serve -d     后台启动服务

常用 URL:
  GET  /health                 健康检查
  GET  /v1/models              可用模型列表
  POST /v1/chat/completions    OpenAI Chat Completions
  POST /v1/messages            Anthropic Messages
  POST /v1/responses           OpenAI Responses

配置文件: ${configPath()}
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
    process.stdout.write(helpText());
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
    process.stdout.write(helpText());
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

  process.stderr.write(`未知命令或选项: ${args.join(' ')}\n\n${helpText()}`);
  process.exitCode = 2;
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${basename(process.execPath)}: ${message}\n`);
  process.exitCode = 1;
});
