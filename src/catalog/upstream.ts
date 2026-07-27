import type { AuthConfig, Config, ProviderConfig } from '../config/schema.ts';
import type { Logger } from '../log/logger.ts';
import { getChatGptToken } from '../upstream/auth/chatgptOAuth.ts';
import type { ModelMeta } from './catalog.ts';

export interface UpstreamModelDirectory {
  models: Record<string, Partial<ModelMeta>>;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function proxyOf(provider: ProviderConfig, globalProxy: string | undefined): string | undefined {
  if (provider.proxy === true) return globalProxy;
  return typeof provider.proxy === 'string' ? provider.proxy : undefined;
}

async function headersFor(options: {
  providerId: string;
  provider: ProviderConfig;
  auth: AuthConfig;
  globalProxy?: string;
  logger: Logger;
}): Promise<Record<string, string>> {
  const { provider, auth, globalProxy, logger } = options;
  const headers: Record<string, string> = { accept: 'application/json', ...provider.headers };
  if (auth.type === 'bearer') {
    const key = auth.keys[0];
    if (key) headers.authorization = `Bearer ${key}`;
  } else if (auth.type === 'header') {
    const key = auth.keys[0];
    if (key && auth.header) headers[auth.header.toLowerCase()] = key;
  } else if (auth.type === 'chatgpt-oauth') {
    const credentials = await getChatGptToken({
      credentialsPath: auth.credentialsPath,
      proxy: proxyOf(provider, globalProxy),
      logger,
    });
    headers.authorization = `Bearer ${credentials.accessToken}`;
    headers.originator ??= 'codex_cli_rs';
    if (credentials.accountId) headers['chatgpt-account-id'] ??= credentials.accountId;
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 兼容 OpenAI 风格 data[] 与常见 metadata 字段；不猜测未返回的能力。 */
function parseDirectory(payload: unknown): UpstreamModelDirectory | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const rows = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : undefined;
  if (!rows) return undefined;

  const models: Record<string, Partial<ModelMeta>> = {};
  for (const value of rows) {
    const row = asRecord(value);
    if (!row) continue;
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (!id) continue;
    const modalities = asRecord(row.modalities);
    const input = stringArray(modalities?.input ?? row.input_modalities ?? row.input);
    const capabilities = asRecord(row.capabilities);
    const contextWindow = numberOf(row.context_window ?? row.contextWindow ?? row.max_context_tokens);
    const maxOutputTokens = numberOf(row.max_output_tokens ?? row.maxTokens ?? row.max_completion_tokens);
    const reasoning =
      typeof row.reasoning === 'boolean'
        ? row.reasoning
        : typeof capabilities?.reasoning === 'boolean'
          ? capabilities.reasoning
          : undefined;
    const tools =
      typeof row.tool_call === 'boolean'
        ? row.tool_call
        : typeof capabilities?.tools === 'boolean'
          ? capabilities.tools
          : undefined;
    const vision =
      typeof row.vision === 'boolean'
        ? row.vision
        : input.length > 0
          ? input.includes('image')
          : undefined;
    models[id] = {
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(vision !== undefined ? { vision } : {}),
      sources: {
        ...(typeof row.name === 'string' ? { name: 'upstream' as const } : {}),
        ...(contextWindow !== undefined ? { contextWindow: 'upstream' as const } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens: 'upstream' as const } : {}),
        ...(reasoning !== undefined ? { reasoning: 'upstream' as const } : {}),
        ...(tools !== undefined ? { tools: 'upstream' as const } : {}),
        ...(vision !== undefined ? { vision: 'upstream' as const } : {}),
      },
    };
  }
  return { models };
}

export async function fetchUpstreamDirectories(options: {
  config: Config;
  auth: Record<string, AuthConfig>;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<Record<string, UpstreamModelDirectory>> {
  const { config, auth, logger, signal } = options;
  const result: Record<string, UpstreamModelDirectory> = {};
  await Promise.all(
    Object.entries(config.providers).map(async ([providerId, provider]) => {
      if (!provider || !provider.enabled || !provider.modelDirectory.enabled) return;
      try {
        const response = await fetch(joinUrl(provider.baseUrl, provider.modelDirectory.path), {
          headers: await headersFor({
            providerId,
            provider,
            auth: auth[providerId] ?? { type: 'none', keys: [], keyStrategy: 'round-robin' },
            globalProxy: config.proxy,
            logger,
          }),
          signal: signal ?? AbortSignal.timeout(Math.min(provider.firstByteTimeoutMs, 30_000)),
          ...(proxyOf(provider, config.proxy) ? { proxy: proxyOf(provider, config.proxy) } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const directory = parseDirectory(await response.json());
        if (!directory) throw new Error('响应不含 data 或 models 数组');
        result[providerId] = directory;
        logger.debug('上游模型目录已同步', { provider: providerId, models: Object.keys(directory.models).length });
      } catch (error) {
        logger.warn('上游模型目录不可用，仅继续使用 catalog', { provider: providerId, error: String(error) });
      }
    }),
  );
  return result;
}
