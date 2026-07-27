/**
 * smooth 的中立超集 IR（Intermediate Representation）。
 *
 * 设计原则：
 *
 * 1. **不以任何一种 wire 格式为中枢。** 9router 拿 OpenAI Chat Completions 当中转站，
 *    `source → openai → target` 两跳会系统性丢字段。IR 是三种格式的并集而非交集。
 *
 * 2. **可逆性优先。** 凡是「上游生成、下一轮必须原样送回去」的内容（Anthropic 的
 *    `thinking.signature`、Responses 的 `reasoning.encrypted_content` 与 item `id`），
 *    都通过 {@link IROpaque} 挂着原始 JSON。当目标格式 === 来源格式时逐字节回放，
 *    否则按规则降级。丢了这些字段，多轮对话第二轮就会断链。
 *
 * 3. **统一到最富表达力的形状。** 例如 tool result：Chat Completions 用独立的
 *    `role:"tool"` 消息，Anthropic 用 user 消息里的 `tool_result` block。
 *    IR 采用后者（block 形式），序列化成 CC 时再拆开。
 */

/** 三种 wire 协议。 */
export type WireFormat =
  /** OpenAI Chat Completions —— `POST /v1/chat/completions` */
  | 'cc'
  /** Anthropic Messages —— `POST /v1/messages` */
  | 'am'
  /** OpenAI Responses —— `POST /v1/responses` */
  | 'resp';

/**
 * 原始载荷的出处标记。
 *
 * `raw` 只有在 `origin` 与目标格式一致时才会被回放；否则转换层要么降级、要么丢弃。
 * 永远不要跨格式直接塞 `raw`。
 */
export interface IROpaque {
  origin: WireFormat;
  /** 上游返回的原始 JSON 片段，保持引用不可变。 */
  raw: unknown;
}

/** Anthropic 的 prompt caching 断点。位置本身是语义的一部分，必须原位保留。 */
export interface IRCacheControl {
  type: 'ephemeral';
  /** Anthropic 后来引入的 `ttl` 字段（`5m` / `1h`）。 */
  ttl?: string;
}

// ---------------------------------------------------------------------------
// 内容块
// ---------------------------------------------------------------------------

export type IRImageSource =
  | { type: 'url'; url: string }
  | { type: 'base64'; mediaType: string; data: string };

export interface IRTextBlock {
  kind: 'text';
  text: string;
  cache?: IRCacheControl;
}

export interface IRImageBlock {
  kind: 'image';
  source: IRImageSource;
  cache?: IRCacheControl;
}

/**
 * 思考 / 推理块。
 *
 * - Anthropic：`{type:"thinking", thinking, signature}`，或 `{type:"redacted_thinking", data}`
 * - Responses：`{type:"reasoning", id, summary:[...], encrypted_content}`
 * - Chat Completions：只有裸的 `reasoning_content` 字符串，无可逆载荷
 *
 * `text` 是人类可读部分（redacted 时为空串）。可逆载荷全在 `opaque` 里。
 */
export interface IRThinkingBlock {
  kind: 'thinking';
  text: string;
  /** 内容被上游加密/脱敏，`text` 无意义。 */
  redacted?: boolean;
  opaque?: IROpaque;
  cache?: IRCacheControl;
}

export interface IRToolUseBlock {
  kind: 'toolUse';
  /** Anthropic `tool_use.id` / CC `tool_calls[].id` / Responses `function_call.call_id`。 */
  id: string;
  name: string;
  /** 已解析的参数对象。原始字符串形态若重要，放在 `opaque` 里。 */
  input: unknown;
  opaque?: IROpaque;
  cache?: IRCacheControl;
}

/** tool_result 的内容目前只支持文本与图片，与三家的实际能力对齐。 */
export type IRToolResultContent = IRTextBlock | IRImageBlock;

export interface IRToolResultBlock {
  kind: 'toolResult';
  /** 指向对应 {@link IRToolUseBlock.id}。 */
  toolUseId: string;
  content: IRToolResultContent[];
  isError?: boolean;
  cache?: IRCacheControl;
}

/**
 * 解析不了的块。仅在同格式快路径下原样回放，跨格式时丢弃。
 * 存在的意义是让 near-passthrough 不至于因为上游加了新 block 类型就掉数据。
 */
export interface IRUnknownBlock {
  kind: 'unknown';
  opaque: IROpaque;
}

export type IRBlock =
  | IRTextBlock
  | IRImageBlock
  | IRThinkingBlock
  | IRToolUseBlock
  | IRToolResultBlock
  | IRUnknownBlock;

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/**
 * IR 只有 user / assistant 两种角色。
 *
 * - system / developer 提示统一提到 {@link IRRequest.system}
 * - `role:"tool"` 消息被折叠成 user 消息里的 {@link IRToolResultBlock}
 */
export type IRRole = 'user' | 'assistant';

export interface IRMessage {
  role: IRRole;
  content: IRBlock[];
}

/** 系统提示分段。分段而非单字符串，是为了保住 Anthropic 的多段 `cache_control`。 */
export interface IRSystemSegment {
  text: string;
  cache?: IRCacheControl;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export interface IRFunctionTool {
  kind: 'function';
  name: string;
  description?: string;
  /** JSON Schema。三家格式一致，直接透传。 */
  inputSchema: Record<string, unknown>;
  cache?: IRCacheControl;
  opaque?: IROpaque;
}

/**
 * 上游托管工具（web_search / file_search / code_interpreter / computer / mcp …）。
 * 各家定义差异极大，不做归一，只在同格式时透传。
 */
export interface IRHostedTool {
  kind: 'hosted';
  type: string;
  opaque: IROpaque;
}

export type IRTool = IRFunctionTool | IRHostedTool;

export type IRToolChoice =
  | { mode: 'auto' }
  | { mode: 'none' }
  | { mode: 'required' }
  | { mode: 'tool'; name: string };

// ---------------------------------------------------------------------------
// thinking 归一
// ---------------------------------------------------------------------------

/**
 * 六档推理强度。与 omp / pi 客户端使用的档位一致，便于直接对接。
 * 每个上游在配置里给出自己的映射表（仿 omp 的 `reasoningEffortMap`）。
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export interface IRThinkingConfig {
  /**
   * - `off`：显式关闭
   * - `auto`：客户端没表态，由上游默认值决定
   * - `level`：客户端指定了强度，见 `level` / `budgetTokens`
   */
  mode: 'off' | 'auto' | 'level';
  level?: ThinkingLevel;
  /** Anthropic 风格的 token 预算。与 `level` 同时存在时以 `level` 为准。 */
  budgetTokens?: number;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 用于会话粘性与缓存的提示信息，全部可选。 */
export interface IRRequestMeta {
  /** Responses API 的 `prompt_cache_key`。 */
  promptCacheKey?: string;
  /** Anthropic `metadata.user_id` / CC `user`。 */
  userId?: string;
  /** 客户端自带的会话标识（若有）。 */
  sessionId?: string;
}

export interface IRRequest {
  /** 客户端请求的模型名，可能是 `combo/max` 这样的虚拟模型。 */
  model: string;
  system: IRSystemSegment[];
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: IRToolChoice;
  /** 并行工具调用开关。三家都有，语义一致。 */
  parallelToolCalls?: boolean;

  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];

  thinking: IRThinkingConfig;
  stream: boolean;
  meta: IRRequestMeta;

  /** 请求的来源格式。决定 opaque 回放与快路径判定。 */
  origin: WireFormat;
  /**
   * 未被 IR 识别的顶层字段。只在 `origin` 与目标 wire 格式相同时合并回去，
   * 跨格式一律丢弃 —— 否则会把 A 家的参数塞给 B 家导致 400。
   */
  passthrough: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 响应（流式事件）
// ---------------------------------------------------------------------------

export type IRFinishReason =
  | 'stop'
  | 'length'
  | 'toolUse'
  | 'contentFilter'
  | 'refusal'
  | 'error'
  | 'other';

export interface IRUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 上游原始 usage 对象，用于日志与计费核对。 */
  raw?: unknown;
}

/** 块打开时已知的元信息。 */
export type IRBlockOpen =
  | { kind: 'text' }
  | { kind: 'thinking'; redacted?: boolean }
  | { kind: 'toolUse'; id: string; name: string };

/** 块内增量。 */
export type IRBlockDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  /** Anthropic 的 `signature_delta`。单独一类，因为它不是可读内容。 */
  | { kind: 'thinkingSignature'; signature: string }
  /** 工具参数的 JSON 片段，需要按序拼接。 */
  | { kind: 'toolInput'; partialJson: string };

export interface IRError {
  /** 归一化的错误分类，路由层据此决定是否 fallback。 */
  kind:
    | 'auth'
    | 'rateLimit'
    | 'quota'
    | 'badRequest'
    | 'notFound'
    | 'upstream'
    | 'network'
    | 'timeout'
    | 'canceled'
    | 'internal';
  message: string;
  httpStatus?: number;
  /** 上游原始错误体，用于日志与向下游透传细节。 */
  raw?: unknown;
  /** `Retry-After` 或上游给出的建议重试延迟（毫秒）。 */
  retryAfterMs?: number;
}

/**
 * 统一的流式事件。三个解码器产出它，三个编码器消费它。
 *
 * 事件序列约定：
 * `start` → (`blockStart` → `blockDelta`* → `blockStop`)* → `finish`
 * 任何时刻都可能以 `error` 终止。
 */
export type IREvent =
  | { type: 'start'; messageId: string; model: string }
  | { type: 'blockStart'; index: number; block: IRBlockOpen }
  | { type: 'blockDelta'; index: number; delta: IRBlockDelta }
  /** `opaque` 承载该块的最终可逆载荷（如 reasoning 的 `encrypted_content`）。 */
  | { type: 'blockStop'; index: number; opaque?: IROpaque }
  | { type: 'finish'; reason: IRFinishReason; usage?: IRUsage }
  | { type: 'error'; error: IRError };

// ---------------------------------------------------------------------------
// 非流式聚合结果
// ---------------------------------------------------------------------------

/**
 * 非流式请求的返回。内部一律走流式再聚合，所以这是 {@link IREvent} 序列的折叠结果。
 */
export interface IRResponse {
  messageId: string;
  model: string;
  content: IRBlock[];
  finishReason: IRFinishReason;
  usage?: IRUsage;
}
