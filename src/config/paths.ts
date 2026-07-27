import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** 展开 `~` 前缀并转成绝对路径。 */
export function expandPath(p: string, base?: string): string {
  let out = p;
  if (out === '~') {
    out = homedir();
  } else if (out.startsWith('~/')) {
    out = join(homedir(), out.slice(2));
  }
  if (isAbsolute(out)) return out;
  return resolve(base ?? process.cwd(), out);
}

/** 配置根目录。优先 `ACMOS_HOME`，否则 `~/.acmos`。 */
export function dataDir(): string {
  return expandPath(process.env.ACMOS_HOME ?? '~/.acmos');
}

/** 配置文件路径。优先 `ACMOS_CONFIG`。 */
export function configPath(): string {
  const explicit = process.env.ACMOS_CONFIG;
  if (explicit) return expandPath(explicit);
  return join(dataDir(), 'config.yml');
}

export function statePath(): string {
  return join(dataDir(), 'state.db');
}

export function logDir(): string {
  return join(dataDir(), 'logs');
}

/** `.env` 文件位置，用于给配置里的 `${env:X}` 提供取值。 */
export function envPath(): string {
  return join(dataDir(), '.env');
}

/** 运行时解析后的脱敏配置快照，仅供审计，不会被 loader 读取。 */
export function configSnapshotPath(): string {
  return join(dataDir(), 'config.snapshot.yaml');
}
