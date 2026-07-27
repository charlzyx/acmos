import type { ThinkingConfig } from '../config/schema.ts';
import { THINKING_LEVELS, type ThinkingLevel } from '../ir/types.ts';

/**
 * 推理强度归一。
 *
 * 各家的档位取值互不相同（OpenAI 是 `minimal/low/medium/high`，Anthropic 是 token
 * 预算，国内几家又各有各的开关），smooth 内部统一成六档，再按每个上游的配置投射回去。
 */

const LEVEL_INDEX = new Map<ThinkingLevel, number>(
  THINKING_LEVELS.map((level, index) => [level, index]),
);

/** 客户端传来的各种写法 → 内部六档。 */
const ALIASES: Record<string, ThinkingLevel> = {
  none: 'minimal',
  off: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x-high': 'xhigh',
  ultra: 'max',
  max: 'max',
};

export function parseLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  return ALIASES[value.trim().toLowerCase()];
}

function clamp(level: ThinkingLevel, config: ThinkingConfig | undefined): ThinkingLevel {
  if (!config) return level;
  let index = LEVEL_INDEX.get(level) ?? 2;
  const min = config.minLevel ? LEVEL_INDEX.get(config.minLevel) : undefined;
  const max = config.maxLevel ? LEVEL_INDEX.get(config.maxLevel) : undefined;
  if (min !== undefined && index < min) index = min;
  if (max !== undefined && index > max) index = max;
  return THINKING_LEVELS[index] ?? level;
}

/**
 * 取映射表里的值。
 *
 * 上游未必六档全支持，缺失的档位**向下就近取** —— 宁可少想一会儿，
 * 也不要因为映射不到而把请求打成默认最高档，那是烧钱又拖慢首字节。
 */
function lookupDown<T>(level: ThinkingLevel, table: Partial<Record<ThinkingLevel, T>>): T | undefined {
  let index = LEVEL_INDEX.get(level) ?? 0;
  while (index >= 0) {
    const key = THINKING_LEVELS[index];
    if (key) {
      const value = table[key];
      if (value !== undefined) return value;
    }
    index--;
  }
  return undefined;
}

export interface ThinkingProjection {
  /** `mode: effort` 时上游要的字符串档位。 */
  effort?: string | undefined;
  /** `mode: budget` 时上游要的 token 预算。 */
  budgetTokens?: number | undefined;
  /** 上游明确不支持推理，调用方应剔除相关字段。 */
  disabled: boolean;
}

export function projectThinking(
  requested: ThinkingLevel | undefined,
  config: ThinkingConfig | undefined,
): ThinkingProjection {
  if (config?.mode === 'off') return { disabled: true };

  const level = clamp(requested ?? config?.defaultLevel ?? 'medium', config);

  if (config?.mode === 'budget') {
    return { budgetTokens: lookupDown(level, config.budgetMap ?? {}), disabled: false };
  }

  // 默认按 effort 处理。没配映射表就原样透传内部档位名，
  // 对 OpenAI 系上游而言 low/medium/high 本来就是合法取值。
  const effort = config?.effortMap ? lookupDown(level, config.effortMap) : level;
  return { effort, disabled: false };
}
