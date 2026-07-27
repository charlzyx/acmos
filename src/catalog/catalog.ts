import { createHash } from 'node:crypto';
import type { AuthConfig, Config } from '../config/schema.ts';
import type { Logger } from '../log/logger.ts';
import type { Store } from '../state/store.ts';
import { fetchUpstreamDirectories, type UpstreamModelDirectory } from './upstream.ts';

/**
 * models.dev 模型元数据同步。
 *
 * 目的是让配置文件里不用手写上下文长度、是否支持 vision 这类会过期的信息。
 * catalog 是**可选增强**：拉不到就退回配置里的显式声明，绝不阻塞启动。
 */

const KV_KEY = 'catalog:models.dev';
const UPSTREAM_KV_KEY = 'catalog:upstream.v1';

/** models.dev `api.json` 里单个模型的形状，只声明我们用得到的字段。 */
interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  reasoning_options?: Array<{ type: string; values: string[] }>;
  temperature?: boolean;
}

interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

type RawCatalog = Record<string, RawProvider>;

interface UpstreamCache {
  endpoints: Record<string, string>;
  directories: Record<string, UpstreamModelDirectory>;
}

export type ModelMetaField =
  | 'name'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'reasoning'
  | 'tools'
  | 'vision'
  | 'cost';

export type ModelMetaSource = 'user' | 'models.dev' | 'upstream' | 'unknown';

export interface ModelMeta {
  id: string;
  name?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoning?: boolean | undefined;
  tools?: boolean | undefined;
  vision?: boolean | undefined;
  /** 每个公开元数据字段最终取值的来源。 */
  sources?: Partial<Record<ModelMetaField, ModelMetaSource>> | undefined;
  /** 从 reasoning_options 推导出的 thinking 配置，配置里可覆盖。 */
  thinkingConfig?: { mode: 'effort'; effortMap: Partial<Record<string, string>> } | undefined;
  /** models.dev 标注 temperature:false 时为 false，表示不支持采样参数。 */
  supportsSampling?: boolean | undefined;
  cost?:
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;
}

/**
 * 把 models.dev 的 reasoning_options.values 映射成 smooth 六档 effortMap。
 *
 * 优先向下匹配，若请求档位低于模型最小能力则提升至最低支持档位；绝不生成 catalog
 * 未声明的上游值。例：仅支持 high/max 的模型收到 medium 时发送 high。
 */
function deriveEffortMap(
  values: string[] | undefined,
): { mode: 'effort'; effortMap: Partial<Record<string, string>> } | undefined {
  if (!values || values.length === 0) return undefined;
  const supported = new Set(values);
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  const aliases: Record<string, readonly string[]> = {
    minimal: ['minimal', 'none', 'off'],
    low: ['low'],
    medium: ['medium'],
    high: ['high'],
    xhigh: ['xhigh', 'x-high'],
    max: ['max'],
  };
  const supportedAt = (level: (typeof levels)[number]): string | undefined =>
    aliases[level]?.find((value) => supported.has(value));
  const effortMap: Partial<Record<string, string>> = {};
  for (const level of levels) {
    const index = levels.indexOf(level);
    let value: string | undefined;
    for (let i = index; i >= 0 && value === undefined; i--) {
      const candidate = levels[i];
      if (candidate) value = supportedAt(candidate);
    }
    for (let i = 0; i < levels.length && value === undefined; i++) {
      const candidate = levels[i];
      if (candidate) value = supportedAt(candidate);
    }
    if (value !== undefined) effortMap[level] = value;
  }
  return { mode: 'effort', effortMap };
}

function toMeta(modelId: string, raw: RawModel): ModelMeta {
  const inputs = raw.modalities?.input ?? [];
  const effortOpts = raw.reasoning_options?.find((o) => o.type === 'effort');
  const vision = inputs.includes('image');
  const cost = raw.cost
    ? {
        input: raw.cost.input,
        output: raw.cost.output,
        cacheRead: raw.cost.cache_read,
        cacheWrite: raw.cost.cache_write,
      }
    : undefined;
  return {
    id: raw.id ?? modelId,
    name: raw.name,
    contextWindow: raw.limit?.context,
    maxOutputTokens: raw.limit?.output,
    reasoning: raw.reasoning,
    tools: raw.tool_call,
    // `attachment` 表示能收附件，但只有 modalities 明说 image 才算真的能识图。
    vision,
    sources: {
      ...(raw.name !== undefined ? { name: 'models.dev' as const } : {}),
      ...(raw.limit?.context !== undefined ? { contextWindow: 'models.dev' as const } : {}),
      ...(raw.limit?.output !== undefined ? { maxOutputTokens: 'models.dev' as const } : {}),
      ...(raw.reasoning !== undefined ? { reasoning: 'models.dev' as const } : {}),
      ...(raw.tool_call !== undefined ? { tools: 'models.dev' as const } : {}),
      ...(inputs.length > 0 ? { vision: 'models.dev' as const } : {}),
      ...(cost !== undefined ? { cost: 'models.dev' as const } : {}),
    },
    thinkingConfig: deriveEffortMap(effortOpts?.values),
    supportsSampling: raw.temperature === false ? false : undefined,
    cost,
  };
}

/**
 * 只保留配置里真正引用到的 provider。
 * 完整的 `api.json` 有 3MB / 170+ provider，整包落库纯属浪费。
 */
function slim(raw: RawCatalog, wanted: Set<string>): RawCatalog {
  const out: RawCatalog = {};
  for (const id of wanted) {
    // 未被 models.dev 收录也保留空标记，避免下一次启动把裁剪缓存误判为不完整。
    out[id] = raw[id] ?? { models: {} };
  }
  return out;
}

function directoryEndpoints(
  config: Config,
  auth: Record<string, AuthConfig>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider || !provider.enabled || !provider.modelDirectory.enabled) continue;
    const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}${provider.modelDirectory.path}`;
    const identity = JSON.stringify({
      endpoint,
      auth: auth[providerId],
      headers: provider.headers,
      proxy: provider.proxy,
    });
    out[providerId] = `${endpoint}#${createHash('sha256').update(identity).digest('hex')}`;
  }
  return out;
}

function catalogCacheKey(url: string): string {
  return `${KV_KEY}:${createHash('sha256').update(url).digest('hex')}`;
}

function mergeDirectoryMeta(
  catalog: ModelMeta | undefined,
  upstream: Partial<ModelMeta> | undefined,
  modelId: string,
): ModelMeta | undefined {
  if (!catalog && !upstream) return undefined;
  return {
    id: modelId,
    name: upstream?.name ?? catalog?.name,
    contextWindow: upstream?.contextWindow ?? catalog?.contextWindow,
    maxOutputTokens: upstream?.maxOutputTokens ?? catalog?.maxOutputTokens,
    reasoning: upstream?.reasoning ?? catalog?.reasoning,
    tools: upstream?.tools ?? catalog?.tools,
    vision: upstream?.vision ?? catalog?.vision,
    thinkingConfig: catalog?.thinkingConfig,
    supportsSampling: catalog?.supportsSampling,
    cost: catalog?.cost,
    sources: { ...catalog?.sources, ...upstream?.sources },
  };
}

function wantedProviders(config: Config): Set<string> {
  const out = new Set<string>();
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider) out.add(provider.catalogProvider ?? providerId);
  }
  return out;
}

function parseUpstreamCache(raw: unknown): UpstreamCache | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const cached = raw as UpstreamCache;
  if (
    !cached.endpoints ||
    typeof cached.endpoints !== 'object' ||
    !cached.directories ||
    typeof cached.directories !== 'object'
  ) {
    return undefined;
  }
  return cached;
}

function reusableDirectories(
  cached: UpstreamCache | undefined,
  endpoints: Record<string, string>,
): Record<string, UpstreamModelDirectory> {
  if (!cached) return {};
  const reusable: Record<string, UpstreamModelDirectory> = {};
  for (const [providerId, endpoint] of Object.entries(endpoints)) {
    const directory = cached.directories[providerId];
    if (cached.endpoints[providerId] === endpoint && directory) {
      reusable[providerId] = directory;
    }
  }
  return reusable;
}

export class Catalog {
  private data: RawCatalog = {};
  private upstream: Record<string, UpstreamModelDirectory> = {};

  /** models.dev 数据来源，用于启动日志说明当前元数据是新拉的还是缓存的。 */
  source: 'network' | 'cache' | 'stale-cache' | 'empty' = 'empty';
  /** 上游模型目录来源；目录失败不影响 catalog。 */
  upstreamSource: 'network' | 'cache' | 'stale-cache' | 'empty' = 'empty';

  get(providerId: string, catalogProvider: string, modelId: string): ModelMeta | undefined {
    const model = this.data[catalogProvider]?.models?.[modelId];
    return mergeDirectoryMeta(model ? toMeta(modelId, model) : undefined, this.upstream[providerId]?.models[modelId], modelId);
  }

  /** 列出某 provider 在 catalog 中的全部模型，用于配置未显式声明模型时兜底。 */
  list(providerId: string, catalogProvider: string): ModelMeta[] {
    const models = this.data[catalogProvider]?.models;
    const ids = new Set([...Object.keys(models ?? {}), ...Object.keys(this.upstream[providerId]?.models ?? {})]);
    return [...ids]
      .map((id) => this.get(providerId, catalogProvider, id))
      .filter((meta): meta is ModelMeta => meta !== undefined);
  }

  private adopt(raw: unknown, wanted: Set<string>, requireAll = false): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const catalog = raw as RawCatalog;
    if (requireAll && [...wanted].some((providerId) => catalog[providerId] === undefined)) return false;
    this.data = slim(catalog, wanted);
    return true;
  }

  private adoptUpstream(raw: unknown, endpoints: Record<string, string>): boolean {
    const cached = parseUpstreamCache(raw);
    if (!cached || JSON.stringify(cached.endpoints) !== JSON.stringify(endpoints)) return false;
    this.upstream = cached.directories;
    return true;
  }

  static async load(options: {
    config: Config;
    auth: Record<string, AuthConfig>;
    store: Store;
    logger: Logger;
    signal?: AbortSignal;
  }): Promise<Catalog> {
    const { config, auth, store, logger, signal } = options;
    const catalog = new Catalog();
    const wanted = wantedProviders(config);
    const ttlMs = config.catalog.ttlHours * 3_600_000;

    if (config.catalog.enabled) {
      const catalogKvKey = catalogCacheKey(config.catalog.url);
      const cached = store.getKv(catalogKvKey);
      const fresh = cached !== undefined && Date.now() - cached.updatedAt < ttlMs;
      if (fresh && cached) {
        try {
          if (catalog.adopt(JSON.parse(cached.value), wanted, true)) {
            catalog.source = 'cache';
            logger.debug('catalog 命中缓存', { providers: Object.keys(catalog.data).length });
          }
        } catch {
          // 缓存损坏，走网络重取。
        }
      }
      if (catalog.source !== 'cache') {
        try {
          const response = await fetch(config.catalog.url, { signal: signal ?? AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!catalog.adopt(await response.json(), wanted)) throw new Error('返回结构不是对象');
          store.setKv(catalogKvKey, JSON.stringify(catalog.data));
          catalog.source = 'network';
          logger.info('catalog 已更新', { url: config.catalog.url, providers: Object.keys(catalog.data).length });
        } catch (error) {
          if (cached) {
            try {
              if (catalog.adopt(JSON.parse(cached.value), wanted)) catalog.source = 'stale-cache';
            } catch {
              // 无可用缓存。
            }
          }
          if (catalog.source === 'empty') logger.warn('catalog 不可用，仅使用用户和上游目录元数据', { error: String(error) });
        }
      }
    } else {
      logger.debug('models.dev catalog 已禁用');
    }

    const endpoints = directoryEndpoints(config, auth);
    const cachedUpstream = store.getKv(UPSTREAM_KV_KEY);
    const parsedUpstream = cachedUpstream
      ? (() => {
          try {
            return parseUpstreamCache(JSON.parse(cachedUpstream.value));
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const freshUpstream = cachedUpstream !== undefined && Date.now() - cachedUpstream.updatedAt < ttlMs;
    if (freshUpstream && parsedUpstream && catalog.adoptUpstream(parsedUpstream, endpoints)) {
      catalog.upstreamSource = 'cache';
      logger.debug('上游模型目录命中缓存', { providers: Object.keys(catalog.upstream).length });
    }
    if (catalog.upstreamSource !== 'cache') {
      const directories = await fetchUpstreamDirectories({ config, auth, logger, signal });
      if (Object.keys(directories).length > 0) {
        const merged = { ...reusableDirectories(parsedUpstream, endpoints), ...directories };
        catalog.upstream = merged;
        store.setKv(
          UPSTREAM_KV_KEY,
          JSON.stringify({ endpoints, directories: merged } satisfies UpstreamCache),
        );
        catalog.upstreamSource = 'network';
      } else if (catalog.adoptUpstream(parsedUpstream, endpoints)) {
        catalog.upstreamSource = 'stale-cache';
      }
    }
    return catalog;
  }
}
