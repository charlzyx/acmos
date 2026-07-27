import type { ThinkingLevel } from '../../ir/types.ts';
import type { ResolvedTarget } from '../../routing/registry.ts';
import { projectThinking } from '../../routing/thinking.ts';
import { buildCcRequest, type CcMessage, type CcRequestBody } from '../cc/request.ts';
import { buildResponsesRequest, type ResponsesRequestBody } from '../resp/request.ts';

/** Anthropic Messages 的文本内容块。 */
export interface AmTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic Messages 的 base64 图片来源。 */
export interface AmImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

/** Anthropic Messages 的图片内容块。 */
export interface AmImageBlock {
  type: 'image';
  source: AmImageSource;
}

/** Anthropic Messages 的工具调用内容块。 */
export interface AmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** Anthropic Messages 的工具结果内容块。 */
export interface AmToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AmContentBlock[];
  is_error?: boolean;
}

/** Anthropic 的可回放 thinking 块。跨 wire 时仅保留可读摘要。 */
export interface AmThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** Anthropic 的脱敏 thinking 块。跨 wire 时不能恢复原文。 */
export interface AmRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/** 可跨协议转换的 Anthropic 内容块。 */
export type AmContentBlock =
  | AmTextBlock
  | AmImageBlock
  | AmToolUseBlock
  | AmToolResultBlock
  | AmThinkingBlock
  | AmRedactedThinkingBlock;

/** Anthropic Messages 的一条对话消息。 */
export interface AmMessage {
  role: 'user' | 'assistant';
  content: string | AmContentBlock[];
}

/** Anthropic Messages 的 system 文本块。 */
export interface AmSystemTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic Messages 的函数工具定义。 */
export interface AmTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

/** Anthropic Messages 的 thinking 配置。 */
export interface AmThinking {
  type?: string;
  budget_tokens?: number;
}

/** Anthropic Messages 入站请求体。 */
export interface AmRequestBody {
  model?: string;
  system?: string | AmSystemTextBlock[];
  messages: AmMessage[];
  tools?: AmTool[];
  tool_choice?:
    | 'auto'
    | 'none'
    | { type: 'auto' | 'any' | 'tool'; name?: string; disable_parallel_tool_use?: boolean };
  max_tokens?: number;
  thinking?: AmThinking;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  [key: string]: unknown;
}

type CcContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** 将 Anthropic 的 base64 图片改写为 Chat Completions 可识别的 data URI。 */
function imagePart(source: AmImageSource): CcContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${source.media_type};base64,${source.data}` },
  };
}

/** 提取工具结果中的可传给 tool role 的文本。 */
function toolResultText(content: AmToolResultBlock['content']): string {
  if (typeof content === 'string') return content;

  const text = content
    .filter((block): block is AmTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text || JSON.stringify(content);
}

/** 将一条 Anthropic 消息展开为一条或多条 Chat Completions 消息。 */
function convertMessage(message: AmMessage): CcMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  const content: CcContentPart[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];
  const toolResults: CcMessage[] = [];
  let reasoningContent = '';

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text });
        break;
      case 'image':
        content.push(imagePart(block.source));
        break;
      case 'tool_use':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
        break;
      case 'tool_result':
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolResultText(block.content),
        });
        break;
      case 'thinking':
        reasoningContent += block.thinking;
        break;
      case 'redacted_thinking':
        break;
    }
  }

  if (toolResults.length > 0) {
    if (content.length > 0) toolResults.push({ role: message.role, content });
    return toolResults;
  }

  if (toolCalls.length > 0) {
    return [{
      role: 'assistant',
      ...(content.length > 0 ? { content } : {}),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: toolCalls,
    }];
  }

  return [{
    role: message.role,
    content,
    ...(message.role === 'assistant' && reasoningContent
      ? { reasoning_content: reasoningContent }
      : {}),
  }];
}

/** Anthropic system 的多个文本块归并为一条 system 消息。 */
function systemText(system: AmRequestBody['system']): string | undefined {
  if (typeof system === 'string') return system || undefined;
  if (!Array.isArray(system)) return undefined;

  const text = system
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
  return text || undefined;
}

/** 将 Anthropic 的工具选择策略映射为 Chat Completions 写法。 */
function convertToolChoice(choice: AmRequestBody['tool_choice']): unknown {
  if (!choice || typeof choice === 'string') return choice;

  switch (choice.type) {
    case 'any':
      return 'required';
    case 'tool':
      return choice.name ? { type: 'function', function: { name: choice.name } } : 'auto';
    default:
      return 'auto';
  }
}

/** 将 token 预算向下匹配到内部推理档位，避免超出客户端申请的预算。 */
function thinkingLevelFromBudget(budget: number, target: ResolvedTarget): ThinkingLevel | undefined {
  if (!Number.isFinite(budget) || budget <= 0) return undefined;

  let matched: ThinkingLevel | undefined;
  for (const level of THINKING_LEVELS) {
    const projection = projectThinking(level, target.thinking);
    if (projection.disabled) return undefined;
    if (projection.budgetTokens !== undefined && projection.budgetTokens <= budget) {
      matched = level;
    }
  }
  if (matched) return matched;

  if (target.thinking?.mode === 'budget') return 'minimal';
  if (budget <= 1_024) return 'minimal';
  if (budget <= 4_096) return 'low';
  if (budget <= 8_192) return 'medium';
  if (budget <= 16_384) return 'high';
  if (budget <= 32_768) return 'xhigh';
  return 'max';
}

/** 把 Anthropic Messages 请求转换成 Chat Completions 请求。 */
export function buildAmToCcRequest(body: AmRequestBody, target: ResolvedTarget): CcRequestBody {
  const messages: CcMessage[] = [];
  const system = systemText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages) messages.push(...convertMessage(message));

  const out: CcRequestBody = {
    model: target.modelId,
    messages,
    stream: body.stream ?? true,
  };

  if (typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)) {
    out.max_tokens = body.max_tokens;
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    out.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    }));
  }

  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  if (body.thinking?.type === 'disabled') {
    out.reasoning_effort = 'none';
  } else {
    const budget = body.thinking?.budget_tokens;
    if (typeof budget === 'number') {
      const level = thinkingLevelFromBudget(budget, target);
      if (level) out.reasoning_effort = level;
    }
  }

  return buildCcRequest(out, target);
}

/** 把 Anthropic Messages 请求转换成 OpenAI Responses 请求。 */
export function buildAmToRespRequest(
  body: AmRequestBody,
  target: ResolvedTarget,
  sessionId?: string,
): ResponsesRequestBody {
  return buildResponsesRequest(buildAmToCcRequest(body, target), target, sessionId);
}

function ccContentToAmBlocks(content: unknown): AmContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: AmContentBlock[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const value = part as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') {
      blocks.push({ type: 'text', text: value.text });
      continue;
    }
    if (value.type !== 'image_url') continue;
    const url =
      typeof value.image_url === 'string'
        ? value.image_url
        : value.image_url && typeof value.image_url === 'object'
          ? (value.image_url as Record<string, unknown>).url
          : undefined;
    const match = typeof url === 'string' ? /^data:([^;]+);base64,([\s\S]+)$/.exec(url) : undefined;
    if (match?.[1] && match[2]) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      });
    }
  }
  return blocks;
}

/** Chat Completions 请求转 Anthropic Messages；无等价物的参数不跨协议透传。 */
export function buildCcToAmRequest(body: CcRequestBody, target: ResolvedTarget): AmRequestBody {
  const system: string[] = [];
  const messages: AmMessage[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (id) {
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          }],
        });
      }
      continue;
    }
    const blocks = ccContentToAmBlocks(message.content);
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const value = call as Record<string, unknown>;
        const fn = value.function;
        const name = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).name : undefined;
        const argumentsText = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).arguments : undefined;
        if (typeof value.id !== 'string' || typeof name !== 'string') continue;
        let input: unknown = {};
        if (typeof argumentsText === 'string') {
          try {
            input = JSON.parse(argumentsText);
          } catch {
            input = {};
          }
        }
        blocks.push({ type: 'tool_use', id: value.id, name, input });
      }
    }
    messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }

  const out: AmRequestBody = {
    model: target.modelId,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages,
    stream: body.stream === true,
  };
  const maxTokens =
    typeof body.max_tokens === 'number'
      ? body.max_tokens
      : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_output_tokens === 'number'
          ? body.max_output_tokens
          : undefined;
  if (maxTokens !== undefined && Number.isFinite(maxTokens)) out.max_tokens = maxTokens;
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop)) out.stop_sequences = body.stop.filter((value): value is string => typeof value === 'string');
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.flatMap((tool) => {
      if (!tool || typeof tool !== 'object') return [];
      const value = tool as Record<string, unknown>;
      const fn = value.function;
      if (value.type !== 'function' || !fn || typeof fn !== 'object') return [];
      const definition = fn as Record<string, unknown>;
      if (typeof definition.name !== 'string') return [];
      return [{
        name: definition.name,
        ...(typeof definition.description === 'string' ? { description: definition.description } : {}),
        input_schema: definition.parameters ?? { type: 'object', properties: {} },
      }];
    });
  }
  if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (body.tool_choice === 'none' || body.tool_choice === 'auto') out.tool_choice = body.tool_choice;
  else if (body.tool_choice && typeof body.tool_choice === 'object') {
    const choice = body.tool_choice as Record<string, unknown>;
    const fn = choice.function;
    const name = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).name : undefined;
    if (choice.type === 'function' && typeof name === 'string') out.tool_choice = { type: 'tool', name };
  }
  return out;
}
