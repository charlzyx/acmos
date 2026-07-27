import { writeFileSync } from 'node:fs';
import type { Catalog, ModelMeta } from '../catalog/catalog.ts';
import type { LoadedConfig } from './load.ts';
import { configSnapshotPath } from './paths.ts';
import type { Registry } from '../routing/registry.ts';

const REDACTED = 'REDACTED';
const SENSITIVE_KEY = /^(api[-_]?key|api[-_]?keys|keys|access[-_]?token|refresh[-_]?token|authorization|token|secret|password|cookie)$/i;

type SafeValue =
  | string
  | number
  | boolean
  | null
  | SafeValue[]
  | { [key: string]: SafeValue };

function redact(value: unknown, key?: string): SafeValue {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (
    (key === 'headers' || key === 'extraHeaders') &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(Object.keys(value).map((header) => [header, REDACTED]));
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    const output: { [key: string]: SafeValue } = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function snapshotMeta(meta: ModelMeta): SafeValue {
  return {
    id: meta.id,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
    ...(meta.maxOutputTokens !== undefined ? { maxOutputTokens: meta.maxOutputTokens } : {}),
    ...(meta.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
    ...(meta.tools !== undefined ? { tools: meta.tools } : {}),
    ...(meta.vision !== undefined ? { vision: meta.vision } : {}),
    ...(meta.sources && Object.keys(meta.sources).length > 0 ? { sources: meta.sources } : {}),
    ...(meta.cost !== undefined ? { cost: meta.cost } : {}),
  };
}

/** 写出当前解析后的脱敏配置，仅作审计，不会被 loader 读取。 */
export function writeConfigSnapshot(options: {
  loaded: LoadedConfig;
  catalog: Catalog;
  registry: Registry;
}): string {
  const { loaded, catalog, registry } = options;
  const resolvedModels: Record<string, unknown> = {};
  for (const entry of registry.listModels()) {
    if (entry.ownedBy === 'acmos') continue;
    const target = registry.resolve(entry.id)?.targets[0];
    if (!target) continue;
    resolvedModels[entry.id] = redact({
      wire: target.wire,
      upstreamModel: target.modelId,
      meta: snapshotMeta(target.meta),
      ...(target.thinking !== undefined ? { thinking: target.thinking } : {}),
      ...(Object.keys(target.compat).length > 0 ? { compat: target.compat } : {}),
    });
  }

  const combo: Record<string, unknown> = {};
  for (const [comboId, comboCfg] of Object.entries(loaded.config.combo)) {
    if (!comboCfg) continue;
    const route = registry.resolve(`combo/${comboId}`);
    combo[`combo/${comboId}`] = {
      description: comboCfg.description ?? null,
      sticky: comboCfg.sticky,
      members: (route?.targets ?? []).map((target) => ({
        provider: target.providerId,
        model: target.modelId,
        wire: target.wire,
        meta: snapshotMeta(target.meta),
      })),
    };
  }

  const document: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    sourceConfig: loaded.sourcePath,
    sourceLayers: loaded.layers,
    catalog: {
      modelsDevSource: catalog.source,
      upstreamDirectorySource: catalog.upstreamSource,
      precedence: ['user', 'upstream', 'models.dev', 'unknown'],
    },
    userConfig: redact(loaded.config),
    resolvedModels,
    combo,
  };
  const path = configSnapshotPath();
  writeFileSync(path, Bun.YAML.stringify(document, null, 2), 'utf8');
  return path;
}
