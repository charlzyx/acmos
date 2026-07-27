import { parseSseStream } from '../../upstream/sse.ts';

interface AmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface State {
  id: string;
  model: string;
  created: number;
  toolIndexes: Map<number, number>;
  nextToolIndex: number;
  finished: boolean;
}

function usage(raw: AmUsage | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0;
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(typeof raw.cache_read_input_tokens === 'number'
      ? { prompt_tokens_details: { cached_tokens: raw.cache_read_input_tokens } }
      : {}),
  };
}

function chunk(state: State, delta: Record<string, unknown>, finishReason?: string, rawUsage?: AmUsage): Record<string, unknown> {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    ...(usage(rawUsage) ? { usage: usage(rawUsage) } : {}),
  };
}

function finishReason(value: unknown): string {
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'stop_sequence' || value === 'end_turn') return 'stop';
  return 'stop';
}

/** 将 Anthropic 非流式 Message 响应编码为 Chat Completions JSON。 */
export function amJsonToCcResponse(body: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(body.content) ? body.content : [];
  let text = '';
  let reasoning = '';
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') text += value.text;
    if (value.type === 'thinking' && typeof value.thinking === 'string') reasoning += value.thinking;
    if (value.type === 'tool_use' && typeof value.id === 'string' && typeof value.name === 'string') {
      toolCalls.push({
        id: value.id,
        type: 'function',
        function: { name: value.name, arguments: JSON.stringify(value.input ?? {}) },
      });
    }
  }
  const stop = finishReason(body.stop_reason);
  return {
    id: typeof body.id === 'string' ? body.id : `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : 'unknown',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: stop,
    }],
    ...(usage(body.usage as AmUsage | undefined) ? { usage: usage(body.usage as AmUsage | undefined) } : {}),
  };
}

/** 将 Anthropic Messages SSE 转为 Chat Completions SSE。 */
export function translateAmSseToCc(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const state: State = {
    id: `chatcmpl-${Date.now()}`,
    model: 'unknown',
    created: Math.floor(Date.now() / 1000),
    toolIndexes: new Map(),
    nextToolIndex: 0,
    finished: false,
  };
  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, value: Record<string, unknown>): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of parseSseStream(upstream)) {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = event.event ?? data.type;
          if (type === 'error') {
            const error = data.error as Record<string, unknown> | undefined;
            throw new Error(typeof error?.message === 'string' ? error.message : 'Anthropic 上游流失败');
          }
          if (type === 'message_start') {
            const message = data.message as Record<string, unknown> | undefined;
            if (typeof message?.id === 'string') state.id = message.id;
            if (typeof message?.model === 'string') state.model = message.model;
            continue;
          }
          if (type === 'content_block_start') {
            const index = typeof data.index === 'number' ? data.index : state.nextToolIndex;
            const block = data.content_block as Record<string, unknown> | undefined;
            if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
              const toolIndex = state.nextToolIndex++;
              state.toolIndexes.set(index, toolIndex);
              emit(controller, chunk(state, {
                tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }],
              }));
            }
            continue;
          }
          if (type === 'content_block_delta') {
            const index = typeof data.index === 'number' ? data.index : -1;
            const delta = data.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') emit(controller, chunk(state, { content: delta.text }));
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') emit(controller, chunk(state, { reasoning_content: delta.thinking }));
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const toolIndex = state.toolIndexes.get(index);
              if (toolIndex !== undefined) emit(controller, chunk(state, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }));
            }
            continue;
          }
          if (type === 'message_delta') {
            const delta = data.delta as Record<string, unknown> | undefined;
            const rawUsage = data.usage as AmUsage | undefined;
            emit(controller, chunk(state, {}, finishReason(delta?.stop_reason), rawUsage));
            state.finished = true;
          }
        }
        if (!state.finished) throw new Error('Anthropic 上游流在完成事件前结束');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
