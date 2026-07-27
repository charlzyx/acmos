import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from '../config/paths.ts';

/**
 * 运行时状态存储。
 *
 * 只放**运行时产生、重启后仍有价值**的数据：用量、冷却、会话粘性、catalog 缓存。
 * 一切配置性的东西都在配置文件里，DB 永远不是配置的来源。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  req_id             TEXT    NOT NULL,
  ingress            TEXT    NOT NULL,
  wire               TEXT    NOT NULL,
  requested_model    TEXT    NOT NULL,
  provider           TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  combo              TEXT,
  attempt            INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  status             TEXT    NOT NULL,
  error_kind         TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider, model);

CREATE TABLE IF NOT EXISTS cooldown (
  key    TEXT    PRIMARY KEY,
  until  INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS sticky (
  session_key TEXT    NOT NULL,
  combo       TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_key, combo)
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface UsageRecord {
  reqId: string;
  ingress: string;
  wire: string;
  requestedModel: string;
  provider: string;
  model: string;
  combo?: string | undefined;
  attempt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  latencyMs?: number | undefined;
  status: 'ok' | 'error' | 'canceled';
  errorKind?: string | undefined;
}

export interface StickyTarget {
  provider: string;
  model: string;
}

export class Store {
  private db: Database;

  constructor(path = statePath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // WAL 让读写不互相阻塞；代理是高并发短事务场景，默认的 rollback journal 会成为瓶颈。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- 用量 ---------------------------------------------------------------

  recordUsage(record: UsageRecord): void {
    this.db.query(`INSERT INTO usage (
      ts, req_id, ingress, wire, requested_model, provider, model, combo, attempt,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      latency_ms, status, error_kind
    ) VALUES (
      $ts, $reqId, $ingress, $wire, $requestedModel, $provider, $model, $combo, $attempt,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens, $reasoningTokens,
      $latencyMs, $status, $errorKind
    )`,)
      .run({
        $ts: Date.now(),
        $reqId: record.reqId,
        $ingress: record.ingress,
        $wire: record.wire,
        $requestedModel: record.requestedModel,
        $provider: record.provider,
        $model: record.model,
        $combo: record.combo ?? null,
        $attempt: record.attempt ?? 0,
        $inputTokens: record.inputTokens ?? 0,
        $outputTokens: record.outputTokens ?? 0,
        $cacheReadTokens: record.cacheReadTokens ?? 0,
        $cacheWriteTokens: record.cacheWriteTokens ?? 0,
        $reasoningTokens: record.reasoningTokens ?? 0,
        $latencyMs: record.latencyMs ?? null,
        $status: record.status,
        $errorKind: record.errorKind ?? null,
      });
  }

  // --- 冷却 ---------------------------------------------------------------

  /** 把某个 provider 或 provider/model 打入冷却，路由时跳过。 */
  setCooldown(key: string, durationMs: number, reason?: string): void {
    this.db.query(`INSERT INTO cooldown (key, until, reason) VALUES ($key, $until, $reason)
     ON CONFLICT(key) DO UPDATE SET until = excluded.until, reason = excluded.reason`,)
      .run({ $key: key, $until: Date.now() + durationMs, $reason: reason ?? null });
  }

  /** 返回冷却结束时间戳；未在冷却中返回 `undefined`。 */
  getCooldown(key: string): number | undefined {
    const row = this.db.query('SELECT until FROM cooldown WHERE key = $key').get({ $key: key }) as
      | { until: number }
      | null;
    if (!row) return undefined;
    if (row.until <= Date.now()) {
      this.clearCooldown(key);
      return undefined;
    }
    return row.until;
  }

  clearCooldown(key: string): void {
    this.db.query('DELETE FROM cooldown WHERE key = $key').run({ $key: key });
  }

  // --- 会话粘性 -----------------------------------------------------------

  getSticky(sessionKey: string, combo: string, ttlMs: number): StickyTarget | undefined {
    const row = this.db.query('SELECT provider, model, updated_at FROM sticky WHERE session_key = $s AND combo = $c',)
      .get({ $s: sessionKey, $c: combo }) as
      | { provider: string; model: string; updated_at: number }
      | null;
    if (!row) return undefined;
    if (Date.now() - row.updated_at > ttlMs) return undefined;
    return { provider: row.provider, model: row.model };
  }

  setSticky(sessionKey: string, combo: string, target: StickyTarget): void {
    this.db.query(`INSERT INTO sticky (session_key, combo, provider, model, updated_at)
     VALUES ($s, $c, $p, $m, $t)
     ON CONFLICT(session_key, combo) DO UPDATE SET
       provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at`,)
      .run({ $s: sessionKey, $c: combo, $p: target.provider, $m: target.model, $t: Date.now() });
  }

  /** 清理过期粘性记录，避免长期运行后表无限增长。 */
  pruneSticky(maxAgeMs: number): void {
    this.db.query('DELETE FROM sticky WHERE updated_at < $cutoff')
      .run({ $cutoff: Date.now() - maxAgeMs });
  }

  // --- 通用 KV（catalog 缓存等）-------------------------------------------

  getKv(key: string): { value: string; updatedAt: number } | undefined {
    const row = this.db.query('SELECT value, updated_at FROM kv WHERE key = $key').get({
      $key: key,
    }) as { value: string; updated_at: number } | null;
    return row ? { value: row.value, updatedAt: row.updated_at } : undefined;
  }

  setKv(key: string, value: string): void {
    this.db.query(`INSERT INTO kv (key, value, updated_at) VALUES ($key, $value, $t)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,)
      .run({ $key: key, $value: value, $t: Date.now() });
  }
}
