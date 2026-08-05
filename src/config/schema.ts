import { z } from 'zod';

/**
 * 配置 schema。
 *
 * 设计原则：**模型元数据尽量不写在配置里**。上下文长度、是否支持 vision / reasoning
 * 这类信息由 models.dev catalog 提供，配置只做「覆盖」和「catalog 没有时的兜底」。
 * 配置真正要表达的是三件事：上游怎么连、模型怎么映射、combo 怎么编排。
 */

export const wireFormatSchema = z.enum(['cc', 'am', 'resp']);

export const thinkingLevelSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 上游兼容性开关。字段名沿用 omp `models.yml` 的 `compat`，方便直接搬配置。
 * 全部可选 —— 未指定时由 wire 格式的默认值决定（见 `resolveCompat`）。
 */
export const compatSchema = z
  .object({
    /** 请求体里无条件合并的额外字段（如 `{ thinking: { type: 'enabled' } }`）。 */
    extraBody: z.record(z.string(), z.unknown()).optional(),
    /** 额外请求头。 */
    extraHeaders: z.record(z.string(), z.string()).optional(),
    /** 最大输出 token 的字段名。 */
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens', 'max_output_tokens']).optional(),
    /** 不支持 `developer` 角色时降级为 `system`。 */
    supportsDeveloperRole: z.boolean().optional(),
    /** 不支持 `system` 角色时并入首条 user 消息。 */
    supportsSystemRole: z.boolean().optional(),
    /** 不支持 `tool_choice` 时整个字段剔除。 */
    supportsToolChoice: z.boolean().optional(),
    /**
     * 支持 `tool_choice: auto`，但拒绝 required / 指定函数时设为 false。
     * OMP/Pi 可据此避免发出无效请求；Claude Code/Codex 等不读取该配置，
     * 因此代理仍会在成员级校验并让 combo 跳过不兼容目标。
     */
    supportsForcedToolChoice: z.boolean().optional(),
    /** 不支持 `parallel_tool_calls` 时剔除。 */
    supportsParallelToolCalls: z.boolean().optional(),
    /** 不支持 `reasoning_effort` 时剔除，改用 extraBody 表达。 */
    supportsReasoningEffort: z.boolean().optional(),
    /** 不支持 `temperature` / `top_p`（如 o 系列、gpt-5 系列）。 */
    supportsSampling: z.boolean().optional(),
    /** 不支持 `stop` 序列。 */
    supportsStopSequences: z.boolean().optional(),
    /**
     * 带 `tool_calls` 的 assistant 消息必须同时有 `content` 字段（哪怕是空串）。
     * DeepSeek 等实现要求这个。
     */
    requiresAssistantContentForToolCalls: z.boolean().optional(),
    /** 带 `tool_calls` 的 assistant 消息必须回填 `reasoning_content`。 */
    requiresReasoningContentForToolCalls: z.boolean().optional(),
    /** 工具名长度上限，超出则截断并建立映射表。 */
    maxToolNameLength: z.number().int().positive().optional(),
    /** 发出请求前从请求体里剔除的顶层字段。 */
    dropFields: z.array(z.string()).optional(),
  })
  .strict();

export type CompatConfig = z.infer<typeof compatSchema>;

/**
 * thinking 映射。acmos 内部统一用六档 level，这里定义如何投射到具体上游。
 *
 * - `off`：该模型不支持推理，请求里剔除所有 thinking 相关字段
 * - `effort`：映射成字符串档位（OpenAI `reasoning.effort` 风格）
 * - `budget`：映射成 token 预算（Anthropic `thinking.budget_tokens` 风格）
 */
export const thinkingConfigSchema = z
  .object({
    mode: z.enum(['off', 'effort', 'budget']).default('effort'),
    /** 客户端要求低于此档时，抬到此档。 */
    minLevel: thinkingLevelSchema.optional(),
    /** 客户端要求高于此档时，压到此档。 */
    maxLevel: thinkingLevelSchema.optional(),
    /** 客户端未表态时使用的档位。 */
    defaultLevel: thinkingLevelSchema.optional(),
    /** `mode: effort` 时，六档 → 上游取值。缺失的档位向下就近取。 */
    effortMap: z.record(thinkingLevelSchema, z.string()).optional(),
    /** `mode: budget` 时，六档 → token 预算。 */
    budgetMap: z.record(thinkingLevelSchema, z.number().int().positive()).optional(),
  })
  .strict();

export type ThinkingConfig = z.infer<typeof thinkingConfigSchema>;

export const modelSchema = z
  .object({
    /** 上游真实模型名，发给上游时用这个。 */
    id: z.string().min(1),
    /** 展示名。缺省取 catalog 或 `id`。 */
    name: z.string().optional(),
    /** models.dev 里的模型 id，用于拉元数据。缺省等于 `id`。 */
    catalogId: z.string().optional(),

    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),

    thinking: thinkingConfigSchema.optional(),
    compat: compatSchema.optional(),
  })
  .strict();

export type ModelConfig = z.infer<typeof modelSchema>;

/**
 * 鉴权方式。
 * - `bearer`：`Authorization: Bearer <key>`
 * - `header`：自定义头（Anthropic 用 `x-api-key`）
 * - `chatgpt-oauth`：读 `~/.codex/auth.json` 的 ChatGPT token，由 acmos 负责刷新
 * - `none`：不带凭据
 */
export const authSchema = z
  .object({
    type: z.enum(['bearer', 'header', 'chatgpt-oauth', 'none']).default('bearer'),
    /** 一把或多把 key。多 key 默认在可重试失败时依次切换。 */
    keys: z.array(z.string()).default([]),
    /** `type: header` 时的头名。 */
    header: z.string().optional(),
    keyStrategy: z.enum(['round-robin', 'sticky', 'failover']).default('failover'),
    /** `chatgpt-oauth` 的凭据文件位置。 */
    credentialsPath: z.string().optional(),
  })
  .strict();

export type AuthConfig = z.infer<typeof authSchema>;

/** `true` 用全局代理，`false` 直连，字符串则指定代理地址。 */
export const proxySchema = z.union([z.boolean(), z.string().url()]);

/** 上游模型目录：默认从 `<baseUrl>/models` 同步，供模型存在性和明确元数据覆盖使用。 */
export const modelDirectorySchema = z
  .object({
    enabled: z.boolean().default(true),
    path: z.string().startsWith('/').default('/models'),
  })
  .strict();

export type ModelDirectoryConfig = z.infer<typeof modelDirectorySchema>;

export const providerSchema = z
  .object({
    /** 上游 wire 协议。 */
    wire: wireFormatSchema,
    baseUrl: z.string().url(),
    /** 简写：等价于 `auth: { type: bearer, keys: [<value>] }`。 */
    apiKey: z.union([z.string(), z.array(z.string())]).optional(),
    auth: authSchema.optional(),
    /** 展示名。 */
    name: z.string().optional(),
    /** 对外 provider 别名；只影响 `alias/model-id` 形式的直连路由。 */
    aliases: z.array(z.string().min(1)).default([]),
    /** models.dev 的 provider id，用于批量拉模型元数据。 */
    catalogProvider: z.string().optional(),
    /** 上游 `/models` 或等价模型目录。明确字段优先于 models.dev。 */
    modelDirectory: modelDirectorySchema.default({}),
    proxy: proxySchema.optional(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().default(600_000),
    /** 建立连接到首字节的超时。超过则判定上游哑火，可触发 fallback。 */
    firstByteTimeoutMs: z.number().int().positive().default(60_000),
    enabled: z.boolean().default(true),
    /** 该 provider 下所有模型共享的默认 thinking / compat 配置。 */
    defaults: z
      .object({
        thinking: thinkingConfigSchema.optional(),
        compat: compatSchema.optional(),
      })
      .strict()
      .default({}),
    /** 显式模型清单。为空时全部依赖 catalog。 */
    models: z.array(modelSchema).default([]),
  })
  .strict();

export type ProviderConfig = z.infer<typeof providerSchema>;

export const comboMemberSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 覆盖该成员的 thinking 档位。 */
    thinkingLevel: thinkingLevelSchema.optional(),
    /** 权重预留给后续的负载均衡策略，当前顺序 fallback 下忽略。 */
    weight: z.number().positive().optional(),
  })
  .strict();

export const comboSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    /** 按顺序 fallback。 */
    members: z.array(comboMemberSchema).min(1),
    /** 会话粘性：同一会话优先复用上次成功的成员。 */
    sticky: z.boolean().default(true),
    /** 粘性有效期。 */
    stickyTtlMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60_000),
    /** 成员失败后的冷却时长，冷却期内跳过。 */
    cooldownMs: z.number().int().positive().default(60_000),
  })
  .strict();

export type ComboConfig = z.infer<typeof comboSchema>;

/**
 * 视觉 sidecar：当目标或 combo fallback 不支持视觉输入时，先由视觉模型 OCR/描述，
 * 再把图片替换为文本描述交给原目标。默认关闭，避免额外延迟与跨模型语义变化。
 */
export const visionSidecarSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** 必须是已配置的、支持视觉的直连模型，默认 Codex Luna。 */
    model: z.string().min(1).default('codex/gpt-5.6-luna'),
    maxTokens: z.number().int().positive().default(1_024),
  })
  .strict();

export type VisionSidecarConfig = z.infer<typeof visionSidecarSchema>;

export const logSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** 落 JSONL 到 `<dataDir>/logs/`。 */
    file: z.boolean().default(true),
    /** 是否把请求 / 响应体也记下来。会包含对话内容，默认关。 */
    captureBody: z.boolean().default(false),
    retentionDays: z.number().int().positive().default(7),
  })
  .strict();

export const catalogSchema = z
  .object({
    enabled: z.boolean().default(true),
    url: z.string().url().default('https://models.dev/api.json'),
    ttlHours: z.number().positive().default(24),
  })
  .strict();

export const configSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(20129),
    /** 全局出网代理。provider 未指定 `proxy` 时不生效，需显式 `proxy: true`。 */
    proxy: z.string().url().optional(),
    /** 入站鉴权。为空表示不校验（本机使用场景）。 */
    apiKeys: z.array(z.string()).default([]),
    log: logSchema.default({}),
    catalog: catalogSchema.default({}),
    visionSidecar: visionSidecarSchema.default({}),
    providers: z.record(z.string(), providerSchema).default({}),
    combo: z.record(z.string(), comboSchema).default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
