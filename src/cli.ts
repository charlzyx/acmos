#!/usr/bin/env bun
import { type AppContext, createContext } from './app.ts';
import { ConfigError, watchAcmosConfig } from './config/load.ts';
import { logger } from './log/logger.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  let context: AppContext;

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
  logger.info('smooth 已启动', {
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
