import { parseSseStream, type SseEvent } from '../../upstream/sse.ts';

/** Chat Completions 流中的工具调用增量。 */
interface CcToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Chat Completions 流中的候选增量。 */
interface CcChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    reasoning_details?: Array<{ text?: string; content?: string } | string>;
    tool_calls?: CcToolCallDelta[];
  };
  finish_reason?: string | null;
}

/** Chat Completions 流中的 usage。 */
interface CcUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
}

/** Chat Completions SSE chunk 的本次转换所需字段。 */
interface CcChunk {
  id?: string;
  model?: string;
  choices?: CcChoice[];
  usage?: CcUsage;
  error?: { message?: string; type?: string };
}

type ContentKind = 'text' | 'thinking';

interface ToolState {
  id?: string;
  name?: string;
  arguments: string;
  blockIndex?: number;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface TranslateState {
  started: boolean;
  errored: boolean;
  messageId: string;
  model: string;
  nextBlockIndex: number;
  activeContent?: { kind: ContentKind; index: number };
  tools: Map<number, ToolState>;
  usage: Usage;
  finishReason?: string;
}

/** 初始化单条 Anthropic 消息的流式状态。 */
function newState(): TranslateState {
  return {
    started: false,
    errored: false,
    messageId: '',
    model: 'unknown',
    nextBlockIndex: 0,
    tools: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Anthropic SSE 的标准帧编码。 */
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 统一清理上游 id，生成 Anthropic 兼容的 message id。 */
function messageId(value: unknown): string {
  if (typeof value !== 'string' || !value) return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  if (value.startsWith('msg_')) return value;
  return `msg_${value.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** 将各家 usage 命名统一为 Anthropic 使用的统计值。 */
function extractUsage(raw: CcUsage | undefined): Usage | undefined {
  if (!raw) return undefined;

  const prompt = numberOf(raw.prompt_tokens ?? raw.input_tokens);
  const output = numberOf(raw.completion_tokens ?? raw.output_tokens);
  const cached = numberOf(raw.prompt_tokens_details?.cached_tokens);
  const created = numberOf(raw.prompt_tokens_details?.cache_creation_tokens);
  const input = Math.max(0, prompt - cached - created);

  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(created > 0 ? { cacheCreationTokens: created } : {}),
  };
}

/** 非负有限数，否则按零处理。 */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function reasoningText(delta: CcChoice['delta']): string {
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta?.reasoning === 'string') return delta.reasoning;
  return delta?.reasoning_details
    ?.map((detail) =>
      typeof detail === 'string'
        ? detail
        : typeof detail?.text === 'string'
          ? detail.text
          : typeof detail?.content === 'string'
            ? detail.content
            : '',
    )
    .join('') ?? '';
}

/** Anthropic message_start 的 usage（含可选缓存统计）。 */
function startUsage(usage: Usage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: 0,
    ...(usage.cacheReadTokens ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
  };
}

/** 确保所有其他事件之前先发 message_start。 */
function startMessage(state: TranslateState, chunk: CcChunk, out: string[]): void {
  if (state.started) return;

  state.started = true;
  state.messageId = messageId(chunk.id);
  state.model = typeof chunk.model === 'string' && chunk.model ? chunk.model : 'unknown';
  const usage = extractUsage(chunk.usage);
  if (usage) state.usage = usage;

  out.push(frame('message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: startUsage(state.usage),
    },
  }));
}

/** 停止当前连续文本或 thinking 块。 */
function stopActiveContent(state: TranslateState, out: string[]): void {
  if (!state.activeContent) return;
  out.push(frame('content_block_stop', {
    type: 'content_block_stop',
    index: state.activeContent.index,
  }));
  state.activeContent = undefined;
}

/** 取得对应类型的已打开块；类型变化时先收束前一个块。 */
function contentBlock(state: TranslateState, kind: ContentKind, out: string[]): number {
  if (state.activeContent?.kind === kind) return state.activeContent.index;
  stopActiveContent(state, out);

  const index = state.nextBlockIndex++;
  state.activeContent = { kind, index };
  out.push(frame('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
  }));
  return index;
}

/** 建立工具调用内容块，缺失的上游字段用稳定合法值兜底。 */
function startTool(state: TranslateState, upstreamIndex: number, tool: ToolState, out: string[]): number {
  if (tool.blockIndex !== undefined) return tool.blockIndex;
  stopActiveContent(state, out);

  const index = state.nextBlockIndex++;
  tool.blockIndex = index;
  const id = tool.id || `toolu_${state.messageId}_${upstreamIndex}`;
  const name = tool.name || 'unknown_tool';
  out.push(frame('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  }));
  return index;
}

/** 将上游 stop 原因映射为 Anthropic 的枚举值。 */
function stopReason(reason: string | undefined, hasTools: boolean): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
      return hasTools ? 'tool_use' : 'end_turn';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return hasTools ? 'tool_use' : 'end_turn';
  }
}

/** 收束所有内容块并发出 Anthropic 消息结束事件。 */
function finishMessage(state: TranslateState, out: string[]): void {
  if (!state.started) return;
  stopActiveContent(state, out);

  for (const [upstreamIndex, tool] of state.tools) {
    const started = tool.blockIndex !== undefined;
    const index = startTool(state, upstreamIndex, tool, out);
    if (!started && tool.arguments) {
      out.push(frame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: tool.arguments },
      }));
    }
    out.push(frame('content_block_stop', { type: 'content_block_stop', index }));
  }

  out.push(frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason(state.finishReason, state.tools.size > 0), stop_sequence: null },
    usage: {
      input_tokens: state.usage.inputTokens,
      output_tokens: state.usage.outputTokens,
      ...(state.usage.cacheReadTokens ? { cache_read_input_tokens: state.usage.cacheReadTokens } : {}),
      ...(state.usage.cacheCreationTokens ? { cache_creation_input_tokens: state.usage.cacheCreationTokens } : {}),
    },
  }));
  out.push(frame('message_stop', { type: 'message_stop' }));
}

/** 判断 SSE data 是否是可安全读取字段的 JSON 对象。 */
function parseChunk(event: SseEvent): CcChunk | undefined {
  if (event.data === '[DONE]') return undefined;

  try {
    const parsed: unknown = JSON.parse(event.data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as CcChunk;
  } catch {
    return undefined;
  }
}

/** 将一个 Chat Completions SSE 事件转换成若干 Anthropic SSE 帧。 */
function translateEvent(event: SseEvent, state: TranslateState): string[] {
  const chunk = parseChunk(event);
  if (!chunk) return [];

  if (chunk.error) {
    state.errored = true;
    return [frame('error', {
      type: 'error',
      error: {
        type: chunk.error.type ?? 'api_error',
        message: chunk.error.message ?? '上游返回错误',
      },
    })];
  }

  const choice = chunk.choices?.[0];
  if (!choice && chunk.usage === undefined) return [];

  const out: string[] = [];
  startMessage(state, chunk, out);
  const usage = extractUsage(chunk.usage);
  if (usage) state.usage = usage;

  const delta = choice?.delta;
  const reasoning = reasoningText(delta);
  if (reasoning) {
    const index = contentBlock(state, 'thinking', out);
    out.push(frame('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: reasoning },
    }));
  }

  if (typeof delta?.content === 'string' && delta.content) {
    const index = contentBlock(state, 'text', out);
    out.push(frame('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: delta.content },
    }));
  }

  if (Array.isArray(delta?.tool_calls)) {
    for (let position = 0; position < delta.tool_calls.length; position++) {
      const call = delta.tool_calls[position];
      if (!call) continue;
      const upstreamIndex = typeof call.index === 'number' && call.index >= 0 ? call.index : position;
      const tool = state.tools.get(upstreamIndex) ?? { arguments: '' };
      const hadBlock = tool.blockIndex !== undefined;
      if (typeof call.id === 'string' && call.id) tool.id = call.id;
      if (typeof call.function?.name === 'string' && call.function.name) tool.name = call.function.name;
      if (typeof call.function?.arguments === 'string' && call.function.arguments) {
        tool.arguments += call.function.arguments;
      }
      state.tools.set(upstreamIndex, tool);

      if (!tool.id || !tool.name) continue;
      const index = startTool(state, upstreamIndex, tool, out);
      const argumentsDelta = hadBlock ? call.function?.arguments : tool.arguments;
      if (typeof argumentsDelta === 'string' && argumentsDelta) {
        out.push(frame('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: argumentsDelta },
        }));
      }
    }
  }

  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  return out;
}

/**
 * 将 Chat Completions SSE 转换为 Anthropic Messages SSE。
 *
 * 上游常在 finish chunk 后另发只含 usage 的 chunk，因此消息结束统一延后到流结束，确保
 * `message_delta.usage.output_tokens` 是最终值。
 */
export function translateCcSseToAm(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const state = newState();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of parseSseStream(upstream)) {
          for (const output of translateEvent(event, state)) controller.enqueue(encoder.encode(output));
        }

        if (state.started && !state.errored && state.finishReason) {
          const out: string[] = [];
          finishMessage(state, out);
          for (const output of out) controller.enqueue(encoder.encode(output));
        } else if (!state.errored) {
          controller.enqueue(encoder.encode(frame('error', {
            type: 'error',
            error: { type: 'api_error', message: '上游未返回有效的 Chat Completions SSE 事件' },
          })));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(frame('error', {
          type: 'error',
          error: { type: 'api_error', message: `上游 SSE 转换失败: ${String(error)}` },
        })));
      } finally {
        controller.close();
      }
    },
  });
}

/** 将非流式 Chat Completions 响应编码为 Anthropic Messages JSON。 */
export function ccJsonToAmResponse(json: Record<string, unknown>): Record<string, unknown> {
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const message =
    choice && typeof choice === 'object' && (choice as Record<string, unknown>).message &&
    typeof (choice as Record<string, unknown>).message === 'object'
      ? (choice as Record<string, unknown>).message as Record<string, unknown>
      : {};
  const content: Array<Record<string, unknown>> = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const tool = call as Record<string, unknown>;
      const fn = tool.function;
      const name = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).name : undefined;
      const argumentsText = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).arguments : undefined;
      if (typeof tool.id !== 'string' || typeof name !== 'string') continue;
      let input: unknown = {};
      if (typeof argumentsText === 'string') {
        try {
          input = JSON.parse(argumentsText);
        } catch {
          input = {};
        }
      }
      content.push({ type: 'tool_use', id: tool.id, name, input });
    }
  }
  const finish =
    choice && typeof choice === 'object' && typeof (choice as Record<string, unknown>).finish_reason === 'string'
      ? (choice as Record<string, unknown>).finish_reason as string
      : undefined;
  const usage = extractUsage(json.usage as CcUsage | undefined) ?? {
    inputTokens: 0,
    outputTokens: 0,
  };
  return {
    id: messageId(json.id),
    type: 'message',
    role: 'assistant',
    model: typeof json.model === 'string' ? json.model : 'unknown',
    content,
    stop_reason: stopReason(finish, content.some((block) => block.type === 'tool_use')),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      ...(usage.cacheReadTokens ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheCreationTokens ? { cache_creation_input_tokens: usage.cacheCreationTokens } : {}),
    },
  };
}
