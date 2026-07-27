import type { ResolvedTarget } from '../../routing/registry.ts';
import { parseLevel, projectThinking } from '../../routing/thinking.ts';
import { UpstreamCompatibilityError } from '../../upstream/client.ts';

/**
 * Chat Completions 请求改写（快路径）。
 *
 * 入站与上游同为 CC 时不进 IR —— 只做「换模型名、按上游能力增删字段」这类最小改动，
 * 请求体的其余部分原样转发。任何多余的重新序列化都是丢字段的机会。
 */

export interface CcMessage {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface CcRequestBody {
  model?: unknown;
  messages?: CcMessage[];
  stream?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  reasoning_effort?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  [key: string]: unknown;
}

const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;

/** 统一取出客户端设置的最大输出长度，不管它用的是哪个字段名。 */
function extractMaxTokens(body: CcRequestBody): number | undefined {
  for (const field of MAX_TOKENS_FIELDS) {
    const value = body[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeRoles(messages: CcMessage[], target: ResolvedTarget): CcMessage[] {
  const { supportsDeveloperRole, supportsSystemRole } = target.compat;
  // developer role 是 OpenAI 专属，绝大多数上游（ark/deepseek/glm/...）不支持，
  // 默认降级为 system。只有显式 supportsDeveloperRole: true 才保留。
  const keepDeveloper = supportsDeveloperRole === true;
  const keepSystem = supportsSystemRole !== false;
  if (keepDeveloper && keepSystem) return messages;

  const out: CcMessage[] = [];
  for (const message of messages) {
    let role = message.role;
    if (role === 'developer' && !keepDeveloper) role = 'system';
    if (role === 'system' && !keepSystem) role = 'user';
    out.push(role === message.role ? message : { ...message, role });
  }
  return out;
}

/**
 * 补齐带 `tool_calls` 的 assistant 消息。
 *
 * DeepSeek 等实现要求这类消息必须同时存在 `content`（哪怕空串）和 `reasoning_content`，
 * 否则整轮请求 400。客户端不会知道这种私有约束，只能由代理兜住。
 */
function padToolCallMessages(messages: CcMessage[], target: ResolvedTarget): CcMessage[] {
  const needContent = target.compat.requiresAssistantContentForToolCalls === true;
  const needReasoning = target.compat.requiresReasoningContentForToolCalls === true;
  if (!needContent && !needReasoning) return messages;

  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;

    const patched: CcMessage = { ...message };
    if (needContent && (patched.content === undefined || patched.content === null)) {
      patched.content = '';
    }
    if (
      needReasoning &&
      (patched.reasoning_content === undefined || patched.reasoning_content === null)
    ) {
      patched.reasoning_content = '';
    }
    return patched;
  });
}

function hasForcedToolChoice(choice: unknown): boolean {
  return (
    choice === 'required' ||
    (typeof choice === 'object' && choice !== null && !Array.isArray(choice))
  );
}

/**
 * 成员级兼容门禁。OMP 能在客户端侧读取同名 compat；Pi、Claude Code、Codex
 * 不一定具备该能力，所以代理必须独立执行，且不能把强制约束静默降级为 auto。
 */
export function assertCcRequestCompatible(body: CcRequestBody, target: ResolvedTarget): void {
  if (target.compat.supportsForcedToolChoice !== false || !hasForcedToolChoice(body.tool_choice))
    return;
  throw new UpstreamCompatibilityError(
    `上游 ${target.providerId}/${target.modelId} 不支持强制工具选择`,
  );
}

export function buildCcRequest(body: CcRequestBody, target: ResolvedTarget): CcRequestBody {
  const out: CcRequestBody = { ...body };
  const compat = target.compat;

  out.model = target.modelId;

  // --- 最大输出长度：统一到上游认的字段名 ---
  const maxTokens = extractMaxTokens(body);
  for (const field of MAX_TOKENS_FIELDS) delete out[field];
  if (maxTokens !== undefined) {
    out[compat.maxTokensField ?? 'max_tokens'] = maxTokens;
  }

  const rawReasoning =
    typeof body.reasoning_effort === 'string'
      ? body.reasoning_effort.trim().toLowerCase()
      : undefined;
  const requestedLevel = parseLevel(target.thinkingLevel) ?? parseLevel(rawReasoning) ?? undefined;
  const projection =
    rawReasoning === 'none' || rawReasoning === 'off'
      ? { disabled: true }
      : projectThinking(requestedLevel, target.thinking);
  delete out.reasoning_effort;
  if (projection.disabled || compat.supportsReasoningEffort === false) {
    // 上游不认这个字段，留着必然 400。
  } else if (projection.effort !== undefined) {
    out.reasoning_effort = projection.effort;
  }

  // --- 按上游能力剔除不支持的字段 ---
  if (compat.supportsToolChoice === false) delete out.tool_choice;
  if (compat.supportsParallelToolCalls === false) delete out.parallel_tool_calls;
  if (compat.supportsStopSequences === false) delete out.stop;
  if (compat.supportsSampling === false) {
    delete out.temperature;
    delete out.top_p;
  }
  for (const field of compat.dropFields ?? []) delete out[field];

  // --- 消息层面的兼容处理 ---
  if (Array.isArray(body.messages)) {
    out.messages = padToolCallMessages(normalizeRoles(body.messages, target), target);
  }

  // --- 上游私有的附加字段 ---
  if (compat.extraBody) Object.assign(out, compat.extraBody);

  return out;
}

/** 从 CC 的 usage 对象提取统计值，字段名各家略有出入，都兜一下。 */
export function extractCcUsage(usage: unknown):
  | {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;

  return {
    inputTokens: num(u.prompt_tokens ?? u.input_tokens),
    outputTokens: num(u.completion_tokens ?? u.output_tokens),
    cacheReadTokens: num(details?.cached_tokens ?? u.prompt_cache_hit_tokens),
    reasoningTokens: num(completionDetails?.reasoning_tokens),
  };
}
