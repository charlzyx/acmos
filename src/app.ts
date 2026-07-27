import { Catalog } from './catalog/catalog.ts';
import type { LoadedConfig } from './config/load.ts';
import { Logger, logger as rootLogger } from './log/logger.ts';
import { writeConfigSnapshot } from './config/snapshot.ts';
import { Registry } from './routing/registry.ts';
import { Store } from './state/store.ts';

/** 进程内的运行时上下文。配置热重载时整体替换，正在处理的请求持有旧引用不受影响。 */
export interface AppContext {
  loaded: LoadedConfig;
  store: Store;
  catalog: Catalog;
  registry: Registry;
  logger: Logger;
}

export async function createContext(
  loaded: LoadedConfig,
  existing?: { store: Store },
): Promise<AppContext> {
  const { config } = loaded;

  rootLogger.configure({
    level: config.log.level,
    file: config.log.file,
    captureBody: config.log.captureBody,
    retentionDays: config.log.retentionDays,
  });

  // 热重载时复用同一个 DB 连接：SQLite 反复开关既慢又可能撞上 WAL 锁。
  const store = existing?.store ?? new Store();
  const catalog = await Catalog.load({ config, auth: loaded.auth, store, logger: rootLogger });
  const registry = new Registry(loaded, catalog, rootLogger);
  const snapshotPath = writeConfigSnapshot({ loaded, catalog, registry });
  rootLogger.info('已写入脱敏配置快照', { path: snapshotPath });

  return { loaded, store, catalog, registry, logger: rootLogger };
}
