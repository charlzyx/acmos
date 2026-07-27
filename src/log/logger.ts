import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from '../config/paths.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 键名命中即整体打码。 */
const SENSITIVE_KEY =
  /(authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|credential|session[-_]?key)/i;

/**
 * 值形态命中也打码 —— 光靠键名不够，密钥经常出现在自由文本里
 * （比如上游把整条 curl 命令回显在错误消息中）。
 */
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9._-]{24,})/g;

function maskSecret(text: string): string {
  return text.replace(SECRET_VALUE, (match) => {
    const head = match.slice(0, 6);
    return `${head}***(${match.length})`;
  });
}

function maskValue(value: unknown): unknown {
  if (typeof value !== 'string') return '***';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-2)}(${value.length})`;
}

/**
 * 递归脱敏。
 *
 * 日志会长期留在磁盘上，一旦漏了密钥就是永久性的。宁可多打码，
 * 所以键名匹配和值形态匹配两条规则都跑。
 */
export function redact(node: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[深度截断]';
  if (typeof node === 'string') return maskSecret(node);
  if (node === null || typeof node !== 'object') return node;

  if (seen.has(node)) return '[循环引用]';
  seen.add(node);

  if (Array.isArray(node)) {
    return node.slice(0, 200).map((item) => redact(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? maskValue(value) : redact(value, depth + 1, seen);
  }
  return out;
}

export interface LoggerOptions {
  level: LogLevel;
  /** 落 JSONL 到 `<dataDir>/logs/`。 */
  file: boolean;
  /** 是否记录完整请求 / 响应体。含对话原文，默认关。 */
  captureBody: boolean;
  retentionDays: number;
}

const DEFAULT_OPTIONS: LoggerOptions = {
  level: 'info',
  file: true,
  captureBody: false,
  retentionDays: 7,
};

type Fields = Record<string, unknown>;

function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export class Logger {
  private options: LoggerOptions = DEFAULT_OPTIONS;
  private dir = logDir();
  private currentDay = '';
  private currentFile = '';
  private bindings: Fields;

  constructor(bindings: Fields = {}) {
    this.bindings = bindings;
  }

  configure(options: Partial<LoggerOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.options.file) {
      mkdirSync(this.dir, { recursive: true });
      this.pruneOldFiles();
    }
  }

  /** 派生带固定字段的子 logger，用于给一次请求打上 reqId。 */
  child(bindings: Fields): Logger {
    const child = new Logger({ ...this.bindings, ...bindings });
    child.options = this.options;
    child.dir = this.dir;
    return child;
  }

  get captureBody(): boolean {
    return this.options.captureBody;
  }

  debug(msg: string, fields?: Fields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write('error', msg, fields);
  }

  /**
   * 记录原始请求 / 响应体，仅在 `captureBody` 打开时生效。
   * 这是排查格式转换 bug 的主要手段，但会写下完整对话内容。
   */
  trace(msg: string, body: unknown, fields?: Fields): void {
    if (!this.options.captureBody) return;
    this.write('debug', msg, { ...fields, body });
  }

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level]) return;

    const at = new Date();
    const record: Fields = {
      ts: at.toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(fields ? (redact(fields) as Fields) : {}),
    };

    const line = safeStringify(record);
    this.writeConsole(level, at, msg, record);
    if (this.options.file) this.writeFile(at, line);
  }

  private writeConsole(level: LogLevel, at: Date, msg: string, record: Fields): void {
    const extras: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (key === 'ts' || key === 'level' || key === 'msg' || key === 'body') continue;
      extras.push(`${key}=${typeof value === 'string' ? value : safeStringify(value)}`);
    }
    const time = at.toISOString().slice(11, 23);
    const head = `${time} ${level.toUpperCase().padEnd(5)} ${msg}`;
    const text = extras.length > 0 ? `${head}  ${extras.join(' ')}` : head;
    // 全部走 stderr：stdout 留给可能的管道输出，日志不该污染它。
    process.stderr.write(`${text}\n`);
  }

  private writeFile(at: Date, line: string): void {
    const day = dayStamp(at);
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.currentFile = join(this.dir, `acmos-${day}.jsonl`);
      this.pruneOldFiles();
    }
    try {
      appendFileSync(this.currentFile, `${line}\n`);
    } catch {
      // 日志写不进去不该影响请求处理，静默降级为只输出到 stderr。
    }
  }

  private pruneOldFiles(): void {
    const cutoff = Date.now() - this.options.retentionDays * 86_400_000;
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith('acmos-') || !name.endsWith('.jsonl')) continue;
      const path = join(this.dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // 单个文件清理失败无所谓，下次启动再试。
      }
    }
  }
}

/** `JSON.stringify` 遇到 BigInt / 循环引用会抛异常，日志路径不能因此崩掉。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? String(val) : val));
  } catch {
    return String(value);
  }
}

/** 进程级默认 logger。配置加载完成后调用 `configure` 生效。 */
export const logger = new Logger();
