import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig as loadC12Config, watchConfig as watchC12Config } from 'c12';
import type { z } from 'zod';
import { configPath, dataDir, envPath, expandPath } from './paths.ts';
import { type AuthConfig, type Config, configSchema } from './schema.ts';

/**
 * 配置加载。
 *
 * 职责切分：**c12 负责「取到并合并成一棵对象树」**（多格式、`extends` 分层、dotenv、
 * 文件监听），**zod 负责「这棵树是否合法」**。两者不重叠，默认值只有一个来源
 * —— 全部写在 {@link configSchema} 里，不用 c12 的 `defaults`。
 */

export class ConfigError extends Error {
  /** 不含明细的一句话摘要。 */
  readonly summary: string;
  /** 逐条列出的具体问题，可能多行。 */
  readonly detail: string | undefined;

  constructor(summary: string, detail?: string) {
    // 明细并进 message：调用方多半只会打印 err.message，
    // 把「哪一条配错了」藏在附加属性里等于没说。
    super(detail ? `${summary}\n${detail}` : summary);
    this.name = 'ConfigError';
    this.summary = summary;
    this.detail = detail;
  }
}

/** `${env:NAME}` 或 `${env:NAME:-fallback}` */
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * 递归替换配置树里的 `${env:X}`。
 *
 * c12 的 dotenv 只把 `.env` 灌进 `process.env`，YAML 里仍需要一个引用语法才取得到。
 * （写 `.ts` 配置的话直接用 `process.env` 即可，这个替换对普通字符串无副作用。）
 *
 * 注意 dotenv 语义：**已存在的环境变量不会被 `.env` 覆盖**，即 shell > `.env`。
 *
 * 未定义且无默认值时直接抛错 —— 静默变空串会让上游回 401，排查成本反而更高。
 */
function interpolateEnv(node: unknown, path: string): unknown {
  if (typeof node === 'string') {
    return node.replace(ENV_REF, (_match, name: string, fallback?: string) => {
      const value = process.env[name];
      if (value !== undefined) return value;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`环境变量 ${name} 未定义（引用位置 ${path}）`, `可写入 ${envPath()}`);
    });
  }
  if (Array.isArray(node)) {
    return node.map((item, i) => interpolateEnv(item, `${path}[${i}]`));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = interpolateEnv(value, path ? `${path}.${key}` : key);
    }
    return out;
  }
  return node;
}

/**
 * 剔除 c12 的元字段。
 *
 * `extends` / `$development` 这类键 c12 消费后可能仍留在结果里，而
 * {@link configSchema} 是 `.strict()` 的，不清掉会被直接判非法。
 */
function stripMeta(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'extends' || key.startsWith('$')) continue;
    out[key] = value;
  }
  return out;
}

/** 把 `apiKey` 简写归一成完整的 `auth` 对象。 */
function normalizeAuth(providerId: string, provider: Config['providers'][string]): AuthConfig {
  if (!provider) throw new ConfigError(`provider ${providerId} 缺失`);
  const shorthand = provider.apiKey;
  const explicit = provider.auth;

  if (explicit && shorthand !== undefined) {
    throw new ConfigError(`providers.${providerId} 同时配置了 apiKey 与 auth，请二选一`);
  }
  if (explicit) return explicit;
  if (shorthand !== undefined) {
    const keys = Array.isArray(shorthand) ? shorthand : [shorthand];
    return { type: 'bearer', keys, keyStrategy: 'failover' };
  }
  return { type: 'none', keys: [], keyStrategy: 'failover' };
}

/** schema 之外的交叉校验：引用完整性、代理可用性。 */
function validateReferences(config: Config): void {
  const problems: string[] = [];

  for (const [comboId, combo] of Object.entries(config.combo)) {
    if (!combo) continue;
    for (const [i, member] of combo.members.entries()) {
      const provider = config.providers[member.provider];
      if (!provider) {
        problems.push(
          `combo.${comboId}.members[${i}] 引用了不存在的 provider "${member.provider}"`,
        );
        continue;
      }
      if (!provider.enabled) {
        problems.push(
          `combo.${comboId}.members[${i}] 引用了已禁用的 provider "${member.provider}"`,
        );
      }
      if (
        provider.models.length > 0 &&
        !provider.models.some((model) => model.id === member.model)
      ) {
        problems.push(
          `combo.${comboId}.members[${i}] 引用了 provider "${member.provider}" 中未声明的模型 "${member.model}"`,
        );
      }
    }
  }

  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider) continue;
    if (provider.proxy === true && !config.proxy) {
      problems.push(`providers.${providerId}.proxy 为 true，但顶层未配置 proxy`);
    }
    if (provider.auth?.type === 'header' && !provider.auth.header) {
      problems.push(`providers.${providerId}.auth.type 为 header，但未指定 header 名`);
    }
    const seen = new Set<string>();
    for (const model of provider.models) {
      if (seen.has(model.id)) {
        problems.push(`providers.${providerId} 存在重复的模型标识 "${model.id}"`);
      }
      seen.add(model.id);
    }
  }

  const providerNames = new Map<string, string>();
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider) continue;
    for (const name of [providerId, ...provider.aliases]) {
      const previous = providerNames.get(name);
      if (previous && previous !== providerId) {
        problems.push(`provider 别名 "${name}" 同时指向 "${previous}" 与 "${providerId}"`);
      } else {
        providerNames.set(name, providerId);
      }
    }
  }

  const comboIds = new Set(Object.keys(config.combo));
  for (const providerId of Object.keys(config.providers)) {
    if (comboIds.has(providerId)) {
      problems.push(`"${providerId}" 同时是 provider 和 combo，路由会歧义`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError('配置校验失败', problems.map((p) => `  - ${p}`).join('\n'));
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n');
}

export interface LoadedConfig {
  config: Config;
  /** 归一化后的 provider 鉴权信息，按 provider id 索引。 */
  auth: Record<string, AuthConfig>;
  /** 实际生效的配置文件绝对路径。 */
  sourcePath: string;
  /** 参与合并的所有文件（含 `extends` 链），供启动日志与 watch 展示。 */
  layers: string[];
}

/**
 * 构造 c12 选项。
 *
 * - `cwd` 固定为数据目录（默认 `~/.acmos`）而非进程 cwd —— acmos 是常驻服务，
 *   配置位置不该随启动目录漂移
 * - `rcFile` / `globalRc` / `packageJson` 全关：只认一个配置文件加它的 `extends` 链。
 *   多余的隐式来源只会让「这个值为什么是这样」变难回答
 */
function c12Options(file?: string) {
  const explicit = file ?? process.env.ACMOS_CONFIG;
  return {
    cwd: dataDir(),
    name: 'acmos',
    configFile: explicit ? expandPath(explicit) : 'config',
    rcFile: false as const,
    globalRc: false,
    packageJson: false,
    dotenv: true,
  };
}

interface C12Layer {
  cwd?: string;
  configFile?: string;
}

/**
 * 收集实际参与合并的文件。
 *
 * c12 在主层里放的 `configFile` 是**未解析的相对名**（如 `config`，不带扩展名），
 * 只有 `extends` 出来的层才是绝对路径。所以主文件必须单独并进来，
 * 再按 realpath 去重（macOS 上 `/tmp` 与 `/private/tmp` 指向同一处）。
 */
function resolveLayers(layers: C12Layer[] | undefined, mainFile: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (file: string): void => {
    if (!existsSync(file)) return;
    let key: string;
    try {
      key = realpathSync(file);
    } catch {
      key = file;
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };

  add(mainFile);
  for (const layer of layers ?? []) {
    if (typeof layer.configFile !== 'string') continue;
    add(resolve(layer.cwd ?? dataDir(), layer.configFile));
  }
  return out;
}

/** c12 拿到原始对象树之后的统一收尾：插值 → zod 校验 → 交叉校验 → 归一鉴权。 */
function finalize(
  rawConfig: unknown,
  configFile: string | undefined,
  layers: C12Layer[] | undefined,
): LoadedConfig {
  if (!configFile || !existsSync(configFile)) {
    throw new ConfigError(
      `找不到配置文件（期望位置 ${configPath()}）`,
      '可以从仓库里的 config.example.yml 复制一份到该位置',
    );
  }

  const source =
    rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};

  const interpolated = interpolateEnv(stripMeta(source), '');

  const parsed = configSchema.safeParse(interpolated);
  if (!parsed.success) {
    throw new ConfigError(`配置不合法：${configFile}`, formatZodError(parsed.error));
  }

  const config = parsed.data;
  validateReferences(config);

  const auth: Record<string, AuthConfig> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider) continue;
    auth[providerId] = normalizeAuth(providerId, provider);
  }

  return { config, auth, sourcePath: configFile, layers: resolveLayers(layers, configFile) };
}

/**
 * 把 c12 / 底层解析器抛出的异常收敛成 {@link ConfigError}。
 *
 * confbox 的 `YAMLException` 会把**整个文件内容**塞进 `message` 和 `buffer`，
 * 直接冒泡出去会在日志里刷屏、还可能连带打印出密钥。这里只保留位置和原因。
 */
function toConfigError(err: unknown): ConfigError {
  if (err instanceof ConfigError) return err;

  const e = err as {
    name?: string;
    reason?: string;
    message?: string;
    mark?: { line?: number; column?: number };
  };

  if (e?.name === 'YAMLException') {
    const line = (e.mark?.line ?? 0) + 1;
    const column = (e.mark?.column ?? 0) + 1;
    return new ConfigError(
      `配置文件语法错误（第 ${line} 行第 ${column} 列）`,
      [
        `  - ${e.reason ?? '解析失败'}`,
        '  - 提示：${env:X} 出现在 [a, b] 或 {a: b} 这类流式集合里时必须加引号，',
        '    否则其中的冒号会被当成键值分隔符',
      ].join('\n'),
    );
  }

  return new ConfigError('加载配置失败', `  - ${e?.message ?? String(err)}`);
}

export async function loadAcmosConfig(file?: string): Promise<LoadedConfig> {
  let result: Awaited<ReturnType<typeof loadC12Config<Record<string, unknown>>>>;
  try {
    result = await loadC12Config<Record<string, unknown>>(c12Options(file));
  } catch (err) {
    throw toConfigError(err);
  }
  return finalize(result.config, result.configFile, result.layers);
}

export interface ConfigWatcher {
  current: LoadedConfig;
  unwatch: () => Promise<void>;
}

/**
 * 监听配置变更并热重载。
 *
 * 关键约束：**重载失败绝不能打挂正在跑的服务。** 新配置校验不过时保留旧配置，
 * 只把错误交给 `onError`。代理是长驻进程，一个手滑的 YAML 缩进不该掐断在途的流式请求。
 */
export async function watchAcmosConfig(options: {
  file?: string;
  onUpdate: (loaded: LoadedConfig) => void;
  onError?: (error: unknown) => void;
}): Promise<ConfigWatcher> {
  const { file, onUpdate, onError } = options;

  const result = await watchC12Config<Record<string, unknown>>({
    ...c12Options(file),
    onUpdate({ newConfig }) {
      try {
        onUpdate(finalize(newConfig.config, newConfig.configFile, newConfig.layers));
      } catch (err) {
        onError?.(toConfigError(err));
      }
    },
  });

  return {
    current: finalize(result.config, result.configFile, result.layers),
    unwatch: () => result.unwatch(),
  };
}
