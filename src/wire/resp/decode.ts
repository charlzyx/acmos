import { parseSseStream, type SseEvent } from '../../upstream/sse.ts';
import { UpstreamError } from '../../upstream/client.ts';

/**
 * Responses SSE -> Chat Completions SSE 流式转换。
 *
 * Codex 上游返回 Responses API 事件流，CC 客户端（omp/pi）只认 Chat Completions 格式。
 * 这里逐事件翻译，不反序列化整个响应--每收到一个 SSE event 就吐一个 CC chunk。
 *
 * 关键事件映射：
 *   response.output_text.delta            -> delta.content
 *   response.reasoning_summary_text.delta -> delta.reasoning_content
 *   response.output_item.added (function_call) -> delta.tool_calls[i].{id,name}
 *   response.function_call_arguments.delta     -> delta.tool_calls[i].function.arguments
 *   response.completed / response.failed       -> 最终 chunk（finish_reason + usage）
 *
 * 不走 IR：运行时 IR 流式中间层还没建，这里直转最快打通 codex 链路。
 * IR 留给后续同格式保真度验证（AM<->AM、RESP<->RESP）时用。
 */

interface CcChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    reasoning_encrypted_content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface CcChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: CcChoice[];
  usage?: unknown;
}

interface TranslateState {
  chatId: string;
  created: number;
  model: string;
  started: boolean;
  toolCallIndex: number;
  toolCallIndexes: Map<string, number>;
  finishReasonSent: boolean;
  usage: unknown;
}

function newState(): TranslateState {
  return {
    chatId: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: 'codex',
    started: false,
    toolCallIndex: 0,
    toolCallIndexes: new Map(),
    finishReasonSent: false,
    usage: undefined,
  };
}

function chunk(state: TranslateState, delta: CcChoice['delta'], finishReason?: string | null): CcChunk {
  const choice: CcChoice = { index: 0, delta };
  if (finishReason !== undefined) choice.finish_reason = finishReason;
  return {
    id: state.chatId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [choice],
  };
}

function buildUsage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const input = r.input_tokens ?? r.prompt_tokens ?? 0;
  const output = r.output_tokens ?? r.completion_tokens ?? 0;
  const cacheRead = (r.input_tokens_details as { cached_tokens?: number })?.cached_tokens ?? r.cache_read_input_tokens ?? 0;
  const usage: Record<string, unknown> = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(input) + Number(output),
  };
  if (cacheRead) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return usage;
}

/** 单个 SSE event -> 0 或多个 CC chunk。 */
function translateEvent(event: SseEvent, state: TranslateState): CcChunk[] {

  // data 行可能是 JSON，也可能带 event: 前缀。type 优先取 event 字段，否则取 data.type。
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return [];
  }

  const eventType = event.event ?? data.type ?? '';
  const d = (data.data as Record<string, unknown>) ?? data;
  const out: CcChunk[] = [];

  switch (eventType) {
    case 'response.created':
    case 'response.in_progress': {
      state.model = (data.response as { model?: string })?.model ?? state.model;
      return [];
    }

    case 'response.output_text.delta': {
      const delta = typeof d.delta === 'string' ? d.delta : '';
      if (delta) out.push(chunk(state, { content: delta }));
      return out;
    }

    case 'response.reasoning_summary_text.delta': {
      const delta = typeof d.delta === 'string' ? d.delta : '';
      if (delta) out.push(chunk(state, { reasoning_content: delta }));
      return out;
    }

    case 'response.output_item.added': {
      const item = d.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
        const id = typeof item.call_id === 'string' ? item.call_id : `call_${state.toolCallIndex}`;
        const itemId = typeof item.id === 'string' ? item.id : id;
        let index = state.toolCallIndexes.get(itemId) ?? state.toolCallIndexes.get(id);
        if (index === undefined) {
          index = state.toolCallIndex++;
          state.toolCallIndexes.set(itemId, index);
          state.toolCallIndexes.set(id, index);
        }
        const name = typeof item.name === 'string' ? item.name : '';
        out.push(
          chunk(state, {
            tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
          }),
        );
      }
      return out;
    }

    case 'response.function_call_arguments.delta':
    case 'response.custom_tool_call_input.delta': {
      const argsDelta = typeof d.delta === 'string' ? d.delta : '';
      const itemId =
        typeof d.item_id === 'string'
          ? d.item_id
          : typeof d.call_id === 'string'
            ? d.call_id
            : undefined;
      const index =
        (itemId ? state.toolCallIndexes.get(itemId) : undefined) ??
        Math.max(state.toolCallIndex - 1, 0);
      if (argsDelta) {
        out.push(
          chunk(state, {
            tool_calls: [{ index, function: { arguments: argsDelta } }],
          }),
        );
      }
      return out;
    }

    case 'response.output_item.done': {
      const item = d.item as Record<string, unknown> | undefined;
      if (item?.type === 'reasoning') {
        const encrypted = item.encrypted_content;
        if (typeof encrypted === 'string' && encrypted) {
          out.push(chunk(state, { reasoning_encrypted_content: encrypted }));
        }
      }
      // 索引在 output_item.added 分配；不要等 done，否则并行 tool 调用会串线。
      return out;
    }

    case 'response.completed':
    case 'response.done': {
      const responseUsage = (d.response as { usage?: unknown })?.usage;
      if (responseUsage) state.usage = buildUsage(responseUsage);
      if (!state.finishReasonSent) {
        state.finishReasonSent = true;
        const finalChunk = chunk(state, {}, state.toolCallIndex > 0 ? 'tool_calls' : 'stop');
        if (state.usage) finalChunk.usage = state.usage;
        out.push(finalChunk);
      }
      return out;
    }

    case 'error':
    case 'response.failed': {
      const error = (d.error as Record<string, unknown>) ?? (d.response as { error?: unknown })?.error;
      const message = (error as { message?: string })?.message ?? 'Responses 上游返回失败事件';
      throw new UpstreamError({ kind: 'upstream', message, raw: data });
    }

    default:
      return [];
  }
}

/**
 * 把 Responses SSE 字节流转成 CC SSE 字节流。
 *
 * 用法：`new Response(translateResponsesSseToCc(upstream.body))`。
 */
export function translateResponsesSseToCc(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const state = newState();
  const encoder = new TextEncoder();

  // 复用 smooth 的 SSE 解析器逐事件读
  // 注意：parseSseStream 是 async generator，这里用 ReadableStream 包一层。
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of parseSseStream(upstream)) {
          const chunks = translateEvent(event, state);
          for (const c of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
          }
        }
        if (!state.finishReasonSent) {
          throw new UpstreamError({
            kind: 'upstream',
            message: 'Responses 上游流在完成事件前结束',
          });
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
}

/** 从 Responses SSE 流里嗅探 usage（用于非流式聚合或日志）。 */
export function extractResponsesUsage(upstream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  usage: Promise<unknown>;
} {
  let resolveUsage: (u: unknown) => void = () => {};
  const usage = new Promise<unknown>((r) => {
    resolveUsage = r;
  });

  // 旁路嗅探：tee 一份解析，原样透传另一份
  const [a, b] = upstream.tee();
  const sniffed = a;
  const passthrough = b;

  void (async () => {
    try {
      for await (const event of parseSseStream(sniffed)) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const eventType = event.event ?? data.type ?? '';
        if (eventType === 'response.completed' || eventType === 'response.done') {
          const u = (data.data as { response?: { usage?: unknown } })?.response?.usage ?? (data.response as { usage?: unknown })?.usage;
          if (u) resolveUsage(u);
        }
      }
    } catch {
      // 嗅探失败不影响转发
    } finally {
      resolveUsage(undefined);
    }
  })();

  return { stream: passthrough, usage };
}
