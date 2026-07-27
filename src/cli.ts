#!/usr/bin/env bun
import { type AppContext, createContext } from './app.ts';
import { ConfigError, watchAcmosConfig } from './config/load.ts';
import { logger } from './log/logger.ts';
import { createServer } from './server.ts';

const NAME = 'acmos';
const VERSION = '0.1.0';

async function main(): Promise<void> {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${NAME} ${VERSION}` +
      '\n用法: acmos [选项]' +
      '\n  -v, --version  输出版本' +
      '\n  -h, --help     显示帮助' +
      '\n' +
      '\n环境变量:' +
      '\n  ACMOS_HOME     数据目录 (默认 ~/.acmos)' +
      '\n  ACMOS_CONFIG   配置文件路径\n');
    process.exit(0);
  }

  try {
    const watcher = await watchAcmosConfig({
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
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n`);
      process.exit(1);
    }
    throw err;
  }

  const { config } = context.loaded;
  const app = createServer(() => context);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // 生成可能持续很久，禁掉 Bun 默认的空闲超时，否则长思考会被拦腰切断。
    idleTimeout: 0,
    fetch: app.fetch,
  });
  logger.info('acmos 已启动', {
    url: `http://${config.host}:${config.port}`,
    config: context.loaded.sourcePath,
    layers: context.loaded.layers.length,
    catalog: context.catalog.source,
    models: context.registry.listModels().length,
  });

  const shutdown = (): void => {
    logger.info('正在关闭');
    void server.stop(true);
    context.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
