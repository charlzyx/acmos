import { realpathSync } from 'node:fs';
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

/** 从 Homebrew Cellar 内的可执行文件路径推导安装前缀。 */
export function homebrewPrefixFromExecutable(executable: string): string | undefined {
  const marker = '/Cellar/acmos/';
  const index = executable.indexOf(marker);
  return index > 0 ? executable.slice(0, index) : undefined;
}

function defaultDataDir(): string {
  try {
    const prefix = homebrewPrefixFromExecutable(realpathSync(process.execPath));
    if (prefix) return join(prefix, 'var', 'acmos');
  } catch {
    // 无法解析可执行文件时退回用户目录。
  }
  return expandPath('~/.acmos');
}

/** 配置根目录。优先 `ACMOS_HOME`；Homebrew 安装使用其 var/acmos，否则使用 ~/.acmos。 */
export function dataDir(): string {
  return process.env.ACMOS_HOME ? expandPath(process.env.ACMOS_HOME) : defaultDataDir();
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

/** 当前服务进程信息，供 CLI 查询状态。 */
export function runtimePath(): string {
  return join(dataDir(), 'runtime.json');
}

/** `acmos serve -d` 的标准输出与错误日志。 */
export function daemonLogPath(): string {
  return join(logDir(), 'daemon.log');
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
