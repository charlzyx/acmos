import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandPath } from '../../config/paths.ts';
import type { Logger } from '../../log/logger.ts';

/**
 * ChatGPT OAuth 鉴权。
 *
 * 复用 `~/.codex/auth.json` 的 token，acmos 只负责 refresh。
 * Codex CLI 用 device-code 流程登录，把 token 落在 auth.json，我们直接读。
 * token 过期（或临近过期）时用 refresh_token 换新的 access_token，写回文件。
 *
 * 关键约束：refresh 失败不能打挂请求 -- 旧 token 可能还能用一会儿，先试一次再说。
 */

/** Codex CLI 注册的 OAuth client_id（与官方 CLI 一致，否则 token 互换会失败）。 */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** 提前多久刷新（与 codex CLI 的 refreshLeadMs 对齐：5 天）。 */
const REFRESH_LEAD_MS = 5 * 24 * 60 * 60 * 1000;
/** 超过这个时长没刷新过，即使没过期也强制刷一次（codex 的 maxRefreshAgeMs：8 天）。 */
const MAX_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000;

interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  auth_mode?: string;
  last_refresh?: string;
  tokens: CodexTokens;
}

export interface ChatGptCredentials {
  accessToken: string;
  accountId?: string;
}

/** 进程级缓存：path -> 解析后的 auth 文件（含刷新后的新 token）。 */
const cache = new Map<string, { file: CodexAuthFile; mtime: number }>();

function defaultPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

function readAuthFile(path: string): CodexAuthFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as CodexAuthFile;
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** token 是否需要刷新：临近过期或距上次刷新超过 8 天。 */
function needsRefresh(file: CodexAuthFile, now = Date.now()): boolean {
  const last = parseTimeMs(file.last_refresh);
  if (last === null) return true;
  if (now - last >= MAX_REFRESH_AGE_MS) return true;
  // auth.json 不带 expires_at，只能靠 last_refresh + lead 提前刷。
  // codex access_token 有效期约 30 天，这里用保守的 5 天 lead。
  return now - last >= REFRESH_LEAD_MS;
}

/** 进程内刷新锁，避免并发请求同时触发多次刷新。 */
const refreshLocks = new Map<string, Promise<CodexAuthFile>>();

async function doRefresh(
  path: string,
  file: CodexAuthFile,
  proxy: string | undefined,
  logger: Logger,
): Promise<CodexAuthFile> {
  const refreshToken = file.tokens.refresh_token;
  if (!refreshToken) {
    throw new Error('auth.json 没有 refresh_token，需要重新 codex login');
  }

  logger.info('刷新 Codex OAuth token', { path });

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    ...(proxy ? { proxy } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // refresh_token 失效（被轮换 / 已用过）-- 这类是永久错误，重试无益。
    if (response.status === 400 || response.status === 401) {
      throw new Error(`Codex refresh_token 已失效（${response.status}），需要重新 codex login：${text.slice(0, 200)}`);
    }
    throw new Error(`刷新 Codex token 失败（${response.status}）：${text.slice(0, 200)}`);
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };

  const next: CodexAuthFile = {
    ...file,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: tokens.access_token,
      // OpenAI 的 refresh_token 是轮换的：响应里带了新的就用新的，否则保留旧的。
      refresh_token: tokens.refresh_token ?? refreshToken,
      id_token: tokens.id_token ?? file.tokens.id_token,
      account_id: file.tokens.account_id,
    },
  };

  try {
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    logger.warn('写回 auth.json 失败，本次请求继续用内存里的新 token', { error: String(err) });
  }

  return next;
}

/** 带锁的刷新：并发调用合并成一次。 */
function refreshWithLock(
  path: string,
  file: CodexAuthFile,
  proxy: string | undefined,
  logger: Logger,
): Promise<CodexAuthFile> {
  const existing = refreshLocks.get(path);
  if (existing) return existing;

  const pending = doRefresh(path, file, proxy, logger).finally(() => {
    refreshLocks.delete(path);
  });
  refreshLocks.set(path, pending);
  return pending;
}

export interface GetTokenOptions {
  /** auth.json 路径，默认 ~/.codex/auth.json。 */
  credentialsPath?: string;
  /** 出网代理（codex 需走代理访问 auth.openai.com）。 */
  proxy?: string;
  logger: Logger;
}

/**
 * 取一个可用的 access_token，必要时先刷新。
 *
 * 失败时抛错 -- 调用方（buildHeaders）会把它收敛成 UpstreamError(kind: auth)。
 */
export async function getChatGptToken(options: GetTokenOptions): Promise<ChatGptCredentials> {
  const { proxy, logger } = options;
  const path = expandPath(options.credentialsPath ?? defaultPath());

  let file: CodexAuthFile;
  try {
    file = readAuthFile(path);
  } catch (err) {
    throw new Error(`读取 Codex 凭据失败（${path}）：${String(err)}。请先 codex login。`);
  }

  if (file.auth_mode && file.auth_mode !== 'chatgpt') {
    throw new Error(`auth.json 的 auth_mode=${file.auth_mode}，acmos 只支持 chatgpt 模式`);
  }

  if (!file.tokens?.access_token) {
    throw new Error('auth.json 没有 access_token，请先 codex login');
  }

  if (needsRefresh(file)) {
    try {
      file = await refreshWithLock(path, file, proxy, logger);
    } catch (err) {
      // 刷新失败不致命：旧 token 可能还没过期，先带着试一次。
      logger.warn('Codex token 刷新失败，尝试用旧 token 继续', { error: String(err) });
    }
  }

  return {
    accessToken: file.tokens.access_token,
    accountId: file.tokens.account_id,
  };
}
