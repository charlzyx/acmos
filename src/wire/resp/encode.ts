import { parseSseStream } from '../../upstream/sse.ts';

interface CcToolCall {
  id: string;
  name: string;
  arguments: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const item = asRecord(part);
      return item && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function toolCalls(message: Record<string, unknown>): CcToolCall[] {
  const rawCalls = message.tool_calls;
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.flatMap((value) => {
    const call = asRecord(value);
    const fn = asRecord(call?.function);
    if (!call || !fn || typeof call.id !== 'string' || typeof fn.name !== 'string') return [];
    return [{ id: call.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '' }];
  });
}

function responseUsage(usage: unknown): Record<string, unknown> | undefined {
  const value = asRecord(usage);
  if (!value) return undefined;
  const input = value.prompt_tokens ?? value.input_tokens;
  const output = value.completion_tokens ?? value.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    input_tokens: typeof input === 'number' ? input : 0,
    output_tokens: typeof output === 'number' ? output : 0,
    total_tokens: (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0),
  };
}

/** Chat Completions 非流式响应转换为 Responses 响应。 */
export function ccJsonToResponsesResponse(json: Record<string, unknown>): Record<string, unknown> {
  const choice = Array.isArray(json.choices) ? asRecord(json.choices[0]) : undefined;
  const message = asRecord(choice?.message) ?? {};
  const output: Array<Record<string, unknown>> = [];
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const encrypted = typeof message.reasoning_encrypted_content === 'string'
    ? message.reasoning_encrypted_content
    : undefined;
  if (reasoning || encrypted) {
    output.push({
      type: 'reasoning',
      id: `rs_${typeof json.id === 'string' ? json.id : Date.now()}`,
      ...(reasoning ? { summary: [{ type: 'summary_text', text: reasoning }] } : {}),
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    });
  }
  const text = outputText(message.content);
  if (text) {
    output.push({
      type: 'message',
      id: `msg_${typeof json.id === 'string' ? json.id : Date.now()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    });
  }
  for (const call of toolCalls(message)) {
    output.push({
      type: 'function_call',
      id: `fc_${call.id}`,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    });
  }
  return {
    id: typeof json.id === 'string' ? `resp_${json.id}` : `resp_${Date.now()}`,
    object: 'response',
    created_at: typeof json.created === 'number' ? json.created : Math.floor(Date.now() / 1000),
    status: 'completed',
    model: typeof json.model === 'string' ? json.model : 'acmos',
    output,
    ...(responseUsage(json.usage) ? { usage: responseUsage(json.usage) } : {}),
  };
}

/** Chat Completions SSE 转换为 Responses SSE。 */
export function translateCcSseToResponses(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = `resp_${Date.now()}`;
  const startedAt = Math.floor(Date.now() / 1000);
  let model = 'acmos';
  let textIndex: number | undefined;
  const seenTools = new Set<number>();
  let finalJson: Record<string, unknown> | undefined;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      emit(controller, 'response.created', {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model, created_at: startedAt },
      });
      try {
        for await (const event of parseSseStream(upstream)) {
          if (event.data === '[DONE]') continue;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof data.model === 'string') model = data.model;
          const choice = Array.isArray(data.choices) ? asRecord(data.choices[0]) : undefined;
          if (!choice) continue;
          const delta = asRecord(choice.delta);
          if (delta && typeof delta.content === 'string' && delta.content) {
            if (textIndex === undefined) {
              textIndex = 0;
              emit(controller, 'response.output_item.added', {
                type: 'response.output_item.added',
                output_index: textIndex,
                item: { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'in_progress', content: [] },
              });
              emit(controller, 'response.content_part.added', {
                type: 'response.content_part.added',
                output_index: textIndex,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              });
            }
            emit(controller, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: textIndex,
              content_index: 0,
              delta: delta.content,
            });
          }
          if (delta && Array.isArray(delta.tool_calls)) {
            for (const rawCall of delta.tool_calls) {
              const call = asRecord(rawCall);
              const index = typeof call?.index === 'number' ? call.index : seenTools.size;
              const fn = asRecord(call?.function);
              if (!seenTools.has(index) && call && fn) {
                seenTools.add(index);
                emit(controller, 'response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: index + 1,
                  item: {
                    type: 'function_call',
                    id: `fc_${typeof call.id === 'string' ? call.id : index}`,
                    call_id: typeof call.id === 'string' ? call.id : `call_${index}`,
                    name: typeof fn.name === 'string' ? fn.name : '',
                    arguments: '',
                    status: 'in_progress',
                  },
                });
              }
              if (fn && typeof fn.arguments === 'string' && fn.arguments) {
                emit(controller, 'response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  output_index: index + 1,
                  delta: fn.arguments,
                });
              }
            }
          }
          if (typeof choice.finish_reason === 'string' || data.usage !== undefined) finalJson = data;
        }
        if (textIndex !== undefined) {
          emit(controller, 'response.content_part.done', {
            type: 'response.content_part.done', output_index: textIndex, content_index: 0,
            part: { type: 'output_text', text: '' },
          });
          emit(controller, 'response.output_item.done', {
            type: 'response.output_item.done', output_index: textIndex,
            item: { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [] },
          });
        }
        const finalResponse = ccJsonToResponsesResponse({
          id: responseId,
          model,
          created: startedAt,
          choices: finalJson?.choices ?? [],
          usage: finalJson?.usage,
        });
        emit(controller, 'response.completed', { type: 'response.completed', response: finalResponse });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
