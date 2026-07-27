import type { IRError } from '../ir/types.ts';
import type { Logger } from '../log/logger.ts';
import type { ResolvedTarget } from '../routing/registry.ts';
import { getChatGptToken } from './auth/chatgptOAuth.ts';

/**
 * 上游 HTTP 客户端。
 *
 * 裸 `fetch`，不经任何 SDK —— 数据通路上多一层归一化就多一次字段丢失，
 * 而这个代理的全部价值就在于不丢字段。
 */

export class UpstreamError extends Error {
  readonly kind: IRError['kind'];
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly raw: unknown;

  constructor(init: {
    kind: IRError['kind'];
    message: string;
    httpStatus?: number | undefined;
    retryAfterMs?: number | undefined;
    raw?: unknown;
  }) {
    super(init.message);
    this.name = 'UpstreamError';
    this.kind = init.kind;
    this.httpStatus = init.httpStatus;
    this.retryAfterMs = init.retryAfterMs;
    this.raw = init.raw;
  }
}

/** HTTP 状态码 → 错误分类。路由层据此决定「换一个上游」还是「直接把错误还给客户端」。 */
function classifyStatus(status: number): IRError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimit';
  if (status === 402) return 'quota';
  if (status >= 400 && status < 500) return 'badRequest';
  return 'upstream';
}

/**
 * 是否值得换下一个上游重试。
 *
 * `badRequest` 不重试 —— 请求本身有问题，换谁都是同样的 400，重试只会放大延迟。
 * `notFound` 同理（模型名不存在）。
 */
export function isFailoverable(kind: IRError['kind']): boolean {
  return (
    kind === 'rateLimit' ||
    kind === 'quota' ||
    kind === 'upstream' ||
    kind === 'network' ||
    kind === 'timeout' ||
    kind === 'auth'
  );
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * key 轮转游标。
 *
 * 只放内存：轮转顺序不需要跨重启保持，落库反而会给每个请求加一次写操作。
 */
const keyCursors = new Map<string, number>();

export function pickKey(target: ResolvedTarget, fixedIndex?: number): { key: string; index: number } | undefined {
  const { keys, keyStrategy } = target.auth;
  if (keys.length === 0) return undefined;

  let index = fixedIndex ?? 0;
  if (fixedIndex === undefined && (keyStrategy === 'round-robin' || keyStrategy === 'failover') && keys.length > 1) {
    const cursor = keyCursors.get(target.providerId) ?? 0;
    index = cursor % keys.length;
    keyCursors.set(target.providerId, cursor + 1);
  }
  const key = keys[index];
  return key ? { key, index } : undefined;
}

export function resolveProxy(target: ResolvedTarget, globalProxy: string | undefined): string | undefined {
  const setting = target.provider.proxy;
  if (setting === undefined || setting === false) return undefined;
  if (setting === true) return globalProxy;
  return setting;
}
/** 组装鉴权与自定义请求头。 */
export async function buildHeaders(
  target: ResolvedTarget,
  extra: Record<string, string> = {},
  options: { proxy?: string; logger?: Logger; sessionId?: string; keyIndex?: number } = {},
): Promise<Record<string, string>> {
  const { proxy, logger, sessionId, keyIndex } = options;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    ...target.provider.headers,
    ...target.compat.extraHeaders,
    ...extra,
  };

  const auth = target.auth;
  switch (auth.type) {
    case 'bearer': {
      const picked = pickKey(target, keyIndex);
      if (!picked) {
        throw new UpstreamError({
          kind: 'auth',
          message: `provider ${target.providerId} 未配置任何 API key`,
        });
      }
      headers.authorization = `Bearer ${picked.key}`;
      break;
    }
    case 'header': {
      const picked = pickKey(target, keyIndex);
      if (!picked || !auth.header) {
        throw new UpstreamError({
          kind: 'auth',
          message: `provider ${target.providerId} 的 header 鉴权配置不完整`,
        });
      }
      headers[auth.header.toLowerCase()] = picked.key;
      break;
    }
    case 'chatgpt-oauth': {
      if (!logger) {
        throw new UpstreamError({
          kind: 'auth',
          message: `provider ${target.providerId} 的 chatgpt-oauth 鉴权需要 logger`,
        });
      }
      const creds = await getChatGptToken({
        credentialsPath: auth.credentialsPath,
        proxy,
        logger,
      });
      headers.authorization = `Bearer ${creds.accessToken}`;
      // Codex backend 必需的身份头。
      if (!headers.originator) headers.originator = 'codex_cli_rs';
      if (sessionId && !headers.session_id) headers.session_id = sessionId;
      if (creds.accountId && !headers['chatgpt-account-id']) {
        headers['chatgpt-account-id'] = creds.accountId;
      }
      break;
    }
    case 'none':
      break;
  }

  return headers;
}

export interface UpstreamCallOptions {
  target: ResolvedTarget;
  path: string;
  body: unknown;
  /** 客户端连接的中断信号。客户端断开时必须同步掐掉上游，否则会白烧 token。 */
  signal?: AbortSignal | undefined;
  globalProxy?: string | undefined;
  logger: Logger;
  extraHeaders?: Record<string, string>;
  /** Codex prompt-cache 会话 id，注入 session_id 头。 */
  sessionId?: string | undefined;
  /** `keyStrategy: failover` 下本次尝试的 key 下标。 */
  keyIndex?: number | undefined;
}
export async function callUpstream(options: UpstreamCallOptions): Promise<Response> {
  const { target, path, body, signal, globalProxy, logger, extraHeaders, sessionId, keyIndex } = options;
  const url = joinUrl(target.provider.baseUrl, path);
  const proxy = resolveProxy(target, globalProxy);
  const timeout = AbortSignal.timeout(target.provider.timeoutMs);
  const firstByte = new AbortController();
  const firstByteTimer = setTimeout(() => firstByte.abort(), target.provider.firstByteTimeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, timeout, firstByte.signal])
    : AbortSignal.any([timeout, firstByte.signal]);

  const started = Date.now();
  let response: Response;
  try {
    const headers = await buildHeaders(target, extraHeaders ?? {}, { proxy, logger, sessionId, keyIndex });
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
      ...(proxy ? { proxy } : {}),
    });
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (signal?.aborted) {
      throw new UpstreamError({ kind: 'canceled', message: '客户端已断开连接' });
    }
    if (firstByte.signal.aborted) {
      throw new UpstreamError({
        kind: 'timeout',
        message: `上游 ${target.providerId} 首字节超时（${target.provider.firstByteTimeoutMs}ms）`,
      });
    }
    if (timeout.aborted) {
      throw new UpstreamError({
        kind: 'timeout',
        message: `上游 ${target.providerId} 超时（${target.provider.timeoutMs}ms）`,
      });
    }
    throw new UpstreamError({
      kind: target.auth.type === 'chatgpt-oauth' ? 'auth' : 'network',
      message: `连接上游 ${target.providerId} 失败：${String(err)}`,
      raw: err,
    });
  } finally {
    clearTimeout(firstByteTimer);
  }

  logger.debug('上游响应头已到达', {
    provider: target.providerId,
    model: target.modelId,
    status: response.status,
    ttfbMs: Date.now() - started,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new UpstreamError({
      kind: classifyStatus(response.status),
      message: `上游 ${target.providerId} 返回 ${response.status}：${text.slice(0, 500)}`,
      httpStatus: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      raw: text,
    });
  }

  return response;
}
