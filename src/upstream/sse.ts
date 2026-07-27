/**
 * SSE 解析。
 *
 * 不用现成库的原因：各家上游对 SSE 的实现都有偏差（有的不发 `event:` 行、
 * 有的在 data 里塞多行 JSON、有的用 `\r\n`），而这条链路上任何一次解析错误
 * 都会直接表现为客户端对话卡死。自己写才能精确控制这些边界。
 */

export interface SseEvent {
  event?: string | undefined;
  data: string;
  id?: string | undefined;
  retry?: number | undefined;
}

/** 单个字段行的解析：`field: value`，冒号后的一个前导空格要去掉。 */
function splitField(line: string): [string, string] {
  const colon = line.indexOf(':');
  if (colon === -1) return [line, ''];
  const field = line.slice(0, colon);
  let value = line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  return [field, value];
}

class EventAccumulator {
  private event: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;
  private dataLines: string[] = [];

  push(line: string): void {
    // 以冒号开头的是注释行。有的上游拿它做心跳保活，必须忽略而非当数据。
    if (line.startsWith(':')) return;

    const [field, value] = splitField(line);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.id = value;
        break;
      case 'retry': {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) this.retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  /** 遇到空行时结算。没有任何 data 行的事件按规范应当丢弃。 */
  flush(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.reset();
      return undefined;
    }
    const result: SseEvent = {
      event: this.event,
      data: this.dataLines.join('\n'),
      id: this.id,
      retry: this.retry,
    };
    this.reset();
    return result;
  }

  private reset(): void {
    this.event = undefined;
    this.id = undefined;
    this.retry = undefined;
    this.dataLines = [];
  }
}

/** 从原始字节流中逐个产出 SSE 事件。 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  // stream: true 保证多字节字符被切在 chunk 边界时不会解码出替换字符。
  const decoder = new TextDecoder('utf-8');
  const accumulator = new EventAccumulator();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = findLineEnd(buffer);
        if (!boundary) break;
        const line = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        if (line === '') {
          const event = accumulator.flush();
          if (event) yield event;
        } else {
          accumulator.push(line);
        }
      }
    }

    // 流结束时把残留内容按最后一行处理，兼容上游漏发结尾空行的情况。
    buffer += decoder.decode();
    if (buffer.length > 0) accumulator.push(buffer);
    const last = accumulator.flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** 找到下一个行结束符，兼容 `\n`、`\r\n`、单独的 `\r`。 */
function findLineEnd(buffer: string): { index: number; length: number } | undefined {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '\n') return { index: i, length: 1 };
    if (ch === '\r') {
      // 落在 chunk 末尾的 \r 可能是 \r\n 被切开了，留到下一轮再判断。
      if (i === buffer.length - 1) return undefined;
      return buffer[i + 1] === '\n' ? { index: i, length: 2 } : { index: i, length: 1 };
    }
  }
  return undefined;
}

/**
 * 旁路嗅探：字节原样透传，同时把解析出的事件交给回调。
 *
 * 快路径（入站格式 === 上游格式）用这个 —— 既不反序列化再编码，
 * 又能拿到 usage 用于计费与日志。回调里的异常不允许影响主流。
 */
export function sniffSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8');
  const accumulator = new EventAccumulator();
  let buffer = '';

  const consume = (chunk: Uint8Array | undefined): void => {
    buffer += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    while (true) {
      const boundary = findLineEnd(buffer);
      if (!boundary) break;
      const line = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      if (line === '') {
        const event = accumulator.flush();
        if (event) onEvent(event);
      } else {
        accumulator.push(line);
      }
    }
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // 先转发再嗅探：嗅探逻辑不该给首字节延迟增加任何开销。
        controller.enqueue(chunk);
        try {
          consume(chunk);
        } catch {
          // 嗅探失败只影响 usage 统计，不能中断用户的流。
        }
      },
      flush() {
        try {
          consume(undefined);
          if (buffer.length > 0) accumulator.push(buffer);
          const last = accumulator.flush();
          if (last) onEvent(last);
        } catch {
          // 同上。
        }
      },
    }),
  );
}
