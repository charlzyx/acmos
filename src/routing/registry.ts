import type { Catalog, ModelMeta, ModelMetaField, ModelMetaSource } from '../catalog/catalog.ts';
import type { LoadedConfig } from '../config/load.ts';
import type {
  AuthConfig,
  CompatConfig,
  ComboConfig,
  ModelConfig,
  ProviderConfig,
  ThinkingConfig,
} from '../config/schema.ts';
import type { Logger } from '../log/logger.ts';
import type { WireFormat } from '../ir/types.ts';

/**
 * 模型注册表：把客户端请求的模型名解析成一串按顺序尝试的上游目标。
 *
 * 名称解析优先级：
 *   1. combo id，或 `combo/<id>`
 *   2. `provider/model-id` 全限定名（provider 可以使用配置的 aliases）
 */

export interface ResolvedTarget {
  providerId: string;
  provider: ProviderConfig;
  auth: AuthConfig;
  wire: WireFormat;
  /** 发给上游的真实模型名。 */
  modelId: string;
  meta: ModelMeta;
  thinking: ThinkingConfig | undefined;
  compat: CompatConfig;
  /** 该成员在 combo 里指定的推理档位覆盖。 */
  thinkingLevel?: string | undefined;
}

export interface Route {
  /** 客户端原始请求的模型名。 */
  requested: string;
  /** 命中的 combo id（非 combo 时为 undefined）。 */
  combo?: string | undefined;
  comboConfig?: ComboConfig | undefined;
  /** 按顺序 fallback 的候选目标，至少一个。 */
  targets: ResolvedTarget[];
}

function mergeCompat(
  providerDefault: CompatConfig | undefined,
  model: CompatConfig | undefined,
): CompatConfig {
  return {
    ...providerDefault,
    ...model,
    // extraBody / extraHeaders 是累加语义，不该被模型级配置整体顶掉。
    extraBody: { ...providerDefault?.extraBody, ...model?.extraBody },
    extraHeaders: { ...providerDefault?.extraHeaders, ...model?.extraHeaders },
  };
}

function mergeMeta(
  fromCatalog: ModelMeta | undefined,
  override: ModelConfig | undefined,
): ModelMeta {
  const user = <T>(value: T | undefined, field: ModelMetaField): Record<string, ModelMetaSource> =>
    value !== undefined ? { [field]: 'user' } : {};
  return {
    id: override?.id ?? fromCatalog?.id ?? '',
    name: override?.name ?? fromCatalog?.name,
    contextWindow: override?.contextWindow ?? fromCatalog?.contextWindow,
    maxOutputTokens: override?.maxOutputTokens ?? fromCatalog?.maxOutputTokens,
    reasoning: override?.reasoning ?? fromCatalog?.reasoning,
    tools: override?.tools ?? fromCatalog?.tools,
    vision: override?.vision ?? fromCatalog?.vision,
    cost: fromCatalog?.cost,
    sources: {
      ...fromCatalog?.sources,
      ...user(override?.name, 'name'),
      ...user(override?.contextWindow, 'contextWindow'),
      ...user(override?.maxOutputTokens, 'maxOutputTokens'),
      ...user(override?.reasoning, 'reasoning'),
      ...user(override?.tools, 'tools'),
      ...user(override?.vision, 'vision'),
    },
  };
}

/**
 * combo 的公开能力必须对每一个 fallback 都成立：布尔能力取交集，长度取最小值。
 * 启用且可用的视觉 sidecar 会在请求含图片时转写内容，因此 combo 可公开 vision=true。
 * 任一成员未知时不宣称长度上限，避免客户端据此发送无法被 fallback 接收的请求。
 */
function comboMeta(
  targets: ResolvedTarget[],
  visionSidecarAvailable: boolean,
): ModelMeta | undefined {
  if (targets.length === 0) return undefined;
  const allDefined = (field: 'contextWindow' | 'maxOutputTokens'): number | undefined => {
    const values = targets.map((target) => target.meta[field]);
    return values.every((value): value is number => typeof value === 'number')
      ? Math.min(...values)
      : undefined;
  };
  const allTrue = (field: 'reasoning' | 'tools' | 'vision'): boolean =>
    targets.every((target) => target.meta[field] === true);

  return {
    id: '',
    contextWindow: allDefined('contextWindow'),
    maxOutputTokens: allDefined('maxOutputTokens'),
    reasoning: allTrue('reasoning'),
    tools: allTrue('tools'),
    vision: visionSidecarAvailable || allTrue('vision'),
  };
}

export class Registry {
  /** 全限定名 `provider/model` → 目标。 */
  private byQualified = new Map<string, ResolvedTarget>();
  private combos = new Map<string, ComboConfig>();

  constructor(
    private loaded: LoadedConfig,
    private catalog: Catalog,
    private logger: Logger,
  ) {
    this.build();
  }

  private build(): void {
    const { config, auth } = this.loaded;

    for (const [providerId, provider] of Object.entries(config.providers)) {
      if (!provider || !provider.enabled) continue;
      const providerAuth = auth[providerId] ?? {
        type: 'none' as const,
        keys: [],
        keyStrategy: 'failover' as const,
      };
      const catalogProvider = provider.catalogProvider ?? providerId;
      const declared = provider.models;
      const entries: Array<{ model?: ModelConfig; meta?: ModelMeta }> =
        declared.length > 0
          ? declared.map((model) => ({
              model,
              meta: this.catalog.get(providerId, catalogProvider, model.catalogId ?? model.id),
            }))
          : this.catalog.list(providerId, catalogProvider).map((meta) => ({ meta }));

      for (const entry of entries) {
        const modelId = entry.model?.id ?? entry.meta?.id;
        if (!modelId) continue;

        const target: ResolvedTarget = {
          providerId,
          provider,
          auth: providerAuth,
          wire: provider.wire,
          modelId,
          meta: mergeMeta(entry.meta, entry.model),
          // thinking：配置覆盖 > provider 默认 > catalog 推导
          thinking:
            entry.model?.thinking ?? provider.defaults.thinking ?? entry.meta?.thinkingConfig,
          compat: mergeCompat(
            {
              ...provider.defaults.compat,
              // catalog 标注不支持采样时，作为 provider 级默认的下层兜底
              ...(entry.meta?.supportsSampling === false ? { supportsSampling: false } : {}),
            },
            entry.model?.compat,
          ),
        };

        for (const name of [providerId, ...provider.aliases]) {
          this.byQualified.set(`${name}/${modelId}`, target);
        }
      }
    }

    for (const [comboId, combo] of Object.entries(config.combo)) {
      if (combo) this.combos.set(comboId, combo);
    }
  }

  resolve(requested: string): Route | undefined {
    const comboId = requested.startsWith('combo/') ? requested.slice('combo/'.length) : requested;
    const combo = this.combos.get(comboId);
    if (combo) {
      const targets: ResolvedTarget[] = [];
      for (const member of combo.members) {
        const target = this.byQualified.get(`${member.provider}/${member.model}`);
        if (!target) {
          this.logger.warn('combo 成员无法解析，已跳过', {
            combo: comboId,
            provider: member.provider,
            model: member.model,
          });
          continue;
        }
        targets.push({ ...target, thinkingLevel: member.thinkingLevel });
      }
      if (targets.length === 0) return undefined;
      return { requested, combo: comboId, comboConfig: combo, targets };
    }

    const direct = this.byQualified.get(requested);
    if (!direct) return undefined;
    return { requested, targets: [direct] };
  }

  private visionSidecarAvailable(): boolean {
    const config = this.loaded.config.visionSidecar;
    if (!config.enabled) return false;
    return config.models.some((model) => this.byQualified.get(model)?.meta.vision === true);
  }
  /** `GET /v1/models` 的数据源：combo 在前，具体模型在后。 */
  listModels(): Array<{ id: string; ownedBy: string; meta?: ModelMeta }> {
    const out: Array<{ id: string; ownedBy: string; meta?: ModelMeta }> = [];
    const visionSidecarAvailable = this.visionSidecarAvailable();
    for (const [comboId, combo] of this.combos) {
      const targets = combo.members
        .map((member) => this.byQualified.get(`${member.provider}/${member.model}`))
        .filter((target): target is ResolvedTarget => target !== undefined);
      out.push({
        id: `combo/${comboId}`,
        ownedBy: 'acmos',
        meta: comboMeta(targets, visionSidecarAvailable),
      });
    }
    for (const [qualified, target] of this.byQualified) {
      // 别名条目会指向同一个 target，只输出规范名，避免列表里出现重复项。
      if (qualified !== `${target.providerId}/${target.modelId}`) continue;
      out.push({ id: qualified, ownedBy: target.providerId, meta: target.meta });
    }
    return out;
  }
}
