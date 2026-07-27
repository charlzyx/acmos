import type { ResolvedTarget } from '../../routing/registry.ts';
import { projectThinking } from '../../routing/thinking.ts';
import type { CcMessage, CcRequestBody } from '../cc/request.ts';

/**
 * Chat Completions -> OpenAI Responses 请求构造（CC 入 -> resp 上游）。
 *
 * Codex 的 /backend-api/codex/responses 用 Responses API，但客户端（omp/pi）发的是
 * Chat Completions。这里把 CC body 翻成 Responses body，并套上 Codex 必需的约束：
 *   - store:false（Codex 不存历史）
 *   - system -> developer role（留在可缓存前缀里）
 *   - 剥离 server 生成的 item id（store=false 时后端无法解析）
 *   - allowlist 过滤未知字段
 *   - reasoning.effort + include:[reasoning.encrypted_content]
 *   - 删除 Codex 不支持的字段（temperature/top_p/max_tokens/...）
 */

const RESPONSES_ALLOWLIST = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'store',
  'reasoning', 'service_tier', 'include', 'prompt_cache_key', 'client_metadata', 'text',
  'max_output_tokens',
]);

/** server 生成的 item id 前缀，store=false 时后端无法解析，必须剥离。 */
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

/** Codex 后端会执行的服务端工具类型，其余 type!=function 的工具丢弃。 */
const HOSTED_TOOL_TYPES = new Set([
  'image_generation', 'web_search', 'web_search_preview', 'file_search',
  'computer', 'computer_use_preview', 'code_interpreter', 'mcp', 'local_shell', 'tool_search',
]);

interface ResponsesInputText { type: 'input_text'; text: string }
interface ResponsesInputImage { type: 'input_image'; image_url: string; detail?: string }
interface ResponsesOutputText { type: 'output_text'; text: string }
type ResponsesContent = ResponsesInputText | ResponsesInputImage | ResponsesOutputText

interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'developer' | 'system';
  content: ResponsesContent[];
}

interface ResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface ResponsesReasoningItem {
  type: 'reasoning';
  summary?: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | Record<string, unknown>;

interface ResponsesTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  stream: boolean;
  store: false;
  reasoning?: { effort: string; summary: string };
  include?: string[];
  service_tier?: string;
  prompt_cache_key?: string;
  max_output_tokens?: number;
  [key: string]: unknown;
}

function responseCallId(value: string): string {
  return value.length > 64 ? value.slice(0, 64) : value;
}

/** 从 CC message 的 content 提取文本（可能是 string 或 content parts 数组）。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** CC content parts -> Responses content parts。文本与图片直接映射。 */
function toInputContent(content: unknown): ResponsesContent[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) {
    const text = extractText(content);
    return text ? [{ type: 'input_text', text }] : [];
  }
  const out: ResponsesContent[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      out.push({ type: 'input_text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'input_text', text: p.text });
    } else if (p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url as { url?: string })?.url;
      const detail = typeof p.image_url === 'object' ? (p.image_url as { detail?: string })?.detail : undefined;
      if (typeof url === 'string') {
        out.push({ type: 'input_image', image_url: url, ...(detail ? { detail } : {}) });
      }
    }
  }
  return out;
}

/** 把一条 CC message 翻成一个或多个 Responses input item。 */
function messageToItems(msg: CcMessage): ResponsesInputItem[] {
  const role = typeof msg.role === 'string' ? msg.role : 'user';
  const items: ResponsesInputItem[] = [];

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const tool = tc as Record<string, unknown>;
      const fn = tool.function as Record<string, unknown> | undefined;
      const callId = typeof tool.id === 'string' ? responseCallId(tool.id) : '';
      const name = typeof fn?.name === 'string' ? fn.name : '';
      const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
      if (callId && name) {
        items.push({ type: 'function_call', call_id: callId, name, arguments: args });
      }
    }
    const text = extractText(msg.content);
    if (text) {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }
    return items;
  }

  if (role === 'tool') {
    const callId = typeof msg.tool_call_id === 'string' ? responseCallId(msg.tool_call_id) : '';
    if (callId) {
      items.push({ type: 'function_call_output', call_id: callId, output: extractText(msg.content) });
    }
    return items;
  }

  const respRole =
    role === 'system' || role === 'developer'
      ? 'developer'
      : role === 'assistant'
        ? 'assistant'
        : 'user';
  const contentType = role === 'assistant' ? 'output_text' : 'input_text';
  const content = toInputContent(msg.content);
  const fixedContent = content.map((part) =>
    part.type === 'input_text' && contentType === 'output_text'
      ? { type: 'output_text' as const, text: part.text }
      : part,
  );
  if (fixedContent.length > 0) {
    items.push({ type: 'message', role: respRole, content: fixedContent });
  }
  return items;
}

/** 剥离 server 生成的 item id（store=false 时后端无法解析）。 */
function stripServerIds(input: ResponsesInputItem[]): ResponsesInputItem[] {
  return input.filter((item) => {
    if (typeof item === 'string') return !SERVER_ID_PATTERN.test(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (obj.type === 'item_reference') return false;
      if (typeof obj.id === 'string' && SERVER_ID_PATTERN.test(obj.id)) delete obj.id;
    }
    return true;
  });
}

/** CC tools -> Responses tools. Function tools are flattened; hosted tools retain their native object. */
function normalizeTools(tools: unknown[]): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const t = tool as Record<string, unknown>;
    const type = typeof t.type === 'string' ? t.type : '';
    const fn = t.function as Record<string, unknown> | undefined;

    if (type === 'function' || (!type && fn)) {
      const name = (typeof t.name === 'string' ? t.name : typeof fn?.name === 'string' ? fn.name : '').trim();
      if (!name) continue;
      const description = typeof t.description === 'string' ? t.description : typeof fn?.description === 'string' ? fn.description : undefined;
      const parameters = (t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters))
        ? t.parameters
        : fn?.parameters ?? { type: 'object', properties: {} };
      const strict = typeof t.strict === 'boolean' ? t.strict : fn?.strict;
      out.push({
        type: 'function',
        name: name.slice(0, 128),
        ...(description ? { description } : {}),
        parameters,
        ...(typeof strict === 'boolean' ? { strict } : {}),
      });
    } else if (type) {
      out.push(t as ResponsesTool);
    }
  }
  return out;
}

function reasoningItemFromMessage(message: CcMessage): ResponsesReasoningItem | undefined {
  const record = message as Record<string, unknown>;
  const encrypted =
    typeof record.reasoning_encrypted_content === 'string'
      ? record.reasoning_encrypted_content
      : typeof record.encrypted_content === 'string'
        ? record.encrypted_content
        : record.reasoning && typeof record.reasoning === 'object' &&
            typeof (record.reasoning as Record<string, unknown>).encrypted_content === 'string'
          ? (record.reasoning as Record<string, unknown>).encrypted_content as string
          : undefined;
  const summary =
    typeof record.reasoning_content === 'string'
      ? record.reasoning_content
      : typeof record.reasoning === 'string'
        ? record.reasoning
        : undefined;
  if (!encrypted && !summary) return undefined;
  return {
    type: 'reasoning',
    ...(summary ? { summary: [{ type: 'summary_text', text: summary }] } : {}),
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  };
}

function normalizeToolChoice(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const choice = value as Record<string, unknown>;
  const fn = choice.function;
  if (choice.type === 'function' && fn && typeof fn === 'object') {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === 'string') return { type: 'function', name };
  }
  return value;
}

/**
 * 构造发给 Codex 的 Responses 请求体。
 *
 * @param body 客户端的 CC 请求体
 * @param target 解析出的上游目标
 * @param sessionId 会话 id，用于 prompt_cache_key
 */
export function buildResponsesRequest(
  body: CcRequestBody,
  target: ResolvedTarget,
  sessionId?: string,
): ResponsesRequestBody {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input: ResponsesInputItem[] = [];
  let instructions: string | undefined;

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (!instructions) instructions = text;
      else instructions += `\n\n${text}`;
      continue;
    }
    if (msg.role === 'assistant') {
      const reasoning = reasoningItemFromMessage(msg);
      if (reasoning) input.push(reasoning);
    }
    input.push(...messageToItems(msg));
  }

  // 空 input 兜底（Codex 拒绝空 input）
  if (input.length === 0) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] });
  }

  const stripped = stripServerIds(input);

  const requestedLevel =
    typeof target.thinkingLevel === 'string'
      ? target.thinkingLevel
      : typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort
        : undefined;
  const projection = projectThinking(
    requestedLevel ? parseLevelLocal(requestedLevel) : undefined,
    target.thinking,
  );

  const out: ResponsesRequestBody = {
    model: target.modelId,
    input: stripped,
    // ChatGPT Codex 后端强制要求 SSE；下游非流式请求由 server 聚合转换。
    stream: true,
    store: false,
  };

  if (instructions) out.instructions = instructions;

  // tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = normalizeTools(body.tools);
    if (tools.length > 0) out.tools = tools;
  }
  if (body.tool_choice !== undefined) out.tool_choice = normalizeToolChoice(body.tool_choice);
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;

  // reasoning
  if (!projection.disabled) {
    out.reasoning = { effort: projection.effort ?? 'medium', summary: 'auto' };
    out.include = ['reasoning.encrypted_content'];
  }

  const maxOutputTokens =
    typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined;
  // ChatGPT Codex 的私有 Responses 端点不接受公开 Responses API 的此字段。
  if (
    !target.provider.baseUrl.includes('/backend-api/codex') &&
    maxOutputTokens !== undefined &&
    Number.isFinite(maxOutputTokens)
  ) {
    out.max_output_tokens = maxOutputTokens;
  }

  // prompt cache
  if (sessionId) out.prompt_cache_key = sessionId;

  // service_tier 归一（codex 只接受 priority）
  if (body.service_tier === 'fast' || body.service_tier === 'priority') {
    out.service_tier = 'priority';
  }

  // allowlist 过滤：删掉所有白名单外的字段（body 里可能带了 CC 专有字段）
  // 注意 out 里已经只有合法字段，这里只是防御性清理
  for (const key of Object.keys(out)) {
    if (!RESPONSES_ALLOWLIST.has(key)) delete (out as Record<string, unknown>)[key];
  }

  return out;
}

/** CC 的 reasoning_effort 字符串 -> 内部 ThinkingLevel。重复定义以避免循环依赖。 */
function parseLevelLocal(value: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const v = value.trim().toLowerCase();
  const map: Record<string, 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {
    none: 'minimal', off: 'minimal', minimal: 'minimal',
    low: 'low', medium: 'medium', high: 'high',
    xhigh: 'xhigh', 'x-high': 'xhigh', ultra: 'max', max: 'max',
  };
  return map[v];
}

function responseContentToCc(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    const type = item.type;
    if (
      (type === 'input_text' || type === 'output_text' || type === 'text') &&
      typeof item.text === 'string'
    ) {
      parts.push({ type: 'text', text: item.text });
      continue;
    }
    if (type === 'input_image' && typeof item.image_url === 'string') {
      parts.push({ type: 'image_url', image_url: item.image_url });
    }
  }
  const onlyPart = parts[0];
  return onlyPart?.type === 'text' ? onlyPart.text : parts;
}

function responseInputToCcMessages(input: unknown): CcMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const messages: CcMessage[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const type = item.type;
    if (type === 'message') {
      messages.push({
        role: typeof item.role === 'string' ? item.role : 'user',
        content: responseContentToCc(item.content),
      });
      continue;
    }
    if (type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: item.call_id,
            type: 'function',
            function: {
              name: item.name,
              arguments: typeof item.arguments === 'string' ? item.arguments : '',
            },
          },
        ],
      });
      continue;
    }
    if (type === 'function_call_output' && typeof item.call_id === 'string') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary
            .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object' && !Array.isArray(part))
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
        : '';
      messages.push({
        role: 'assistant',
        content: '',
        ...(summary ? { reasoning_content: summary } : {}),
        ...(typeof item.encrypted_content === 'string'
          ? { reasoning_encrypted_content: item.encrypted_content }
          : {}),
      });
    }
  }
  return messages;
}

function responsesToolsToCc(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
    const value = tool as Record<string, unknown>;
    if (value.type !== 'function' || typeof value.name !== 'string') return [value];
    return [
      {
        type: 'function',
        function: {
          name: value.name,
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          ...(value.parameters !== undefined ? { parameters: value.parameters } : {}),
          ...(typeof value.strict === 'boolean' ? { strict: value.strict } : {}),
        },
      },
    ];
  });
  return converted.length > 0 ? converted : undefined;
}

/** Responses 入站请求归一为 Chat Completions，供非 Responses 上游复用既有路由。 */
export function buildResponsesToCcRequest(body: Record<string, unknown>): CcRequestBody {
  const tools = responsesToolsToCc(body.tools);
  const toolChoice =
    body.tool_choice &&
    typeof body.tool_choice === 'object' &&
    !Array.isArray(body.tool_choice) &&
    (body.tool_choice as Record<string, unknown>).type === 'function' &&
    typeof (body.tool_choice as Record<string, unknown>).name === 'string'
      ? {
          type: 'function',
          function: { name: (body.tool_choice as Record<string, unknown>).name },
        }
      : body.tool_choice;
  const messages = responseInputToCcMessages(body.input);
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.unshift({ role: 'developer', content: body.instructions });
  }
  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(typeof body.max_output_tokens === 'number'
      ? { max_completion_tokens: body.max_output_tokens }
      : {}),
    ...(body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
      ? {
          reasoning_effort: (body.reasoning as Record<string, unknown>).effort,
        }
      : {}),
  };
}
