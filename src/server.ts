import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppContext } from './app.ts';
import type { WireFormat } from './ir/types.ts';
import { dispatch } from './routing/dispatch.ts';
import type { ResolvedTarget } from './routing/registry.ts';
import { UpstreamError } from './upstream/client.ts';
import { parseSseStream, sniffSseStream } from './upstream/sse.ts';
import { maybeUseVisionSidecar } from './vision/sidecar.ts';
import { ccJsonToAmResponse, translateCcSseToAm } from './wire/am/decode.ts';
import { amJsonToCcResponse, translateAmSseToCc } from './wire/am/encode.ts';
import { type AmRequestBody, buildAmToCcRequest, buildCcToAmRequest } from './wire/am/request.ts';
import {
  assertCcRequestCompatible,
  buildCcRequest,
  type CcRequestBody,
  extractCcUsage,
} from './wire/cc/request.ts';
import { translateResponsesSseToCc } from './wire/resp/decode.ts';
import { ccJsonToResponsesResponse, translateCcSseToResponses } from './wire/resp/encode.ts';
import { buildResponsesRequest, buildResponsesToCcRequest } from './wire/resp/request.ts';

/** UpstreamError 分类 → 返回给客户端的 HTTP 状态。 */
const STATUS_BY_KIND: Record<string, number> = {
  auth: 401,
  rateLimit: 429,
  quota: 402,
  badRequest: 400,
  notFound: 404,
  upstream: 502,
  network: 502,
  timeout: 504,
  canceled: 499,
  internal: 500,
};

/**
 * 会话粘性的键。
 *
 * 取「系统提示 + 第一条用户消息」的哈希：对话轮次增加时这部分不变，
 * 因此同一个会话的后续请求会稳定命中同一个上游。
 */
function sessionKeyOf(body: CcRequestBody): string | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const hash = createHash('sha256');
  let seen = 0;
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'developer' && message.role !== 'user') {
      continue;
    }
    hash.update(`${message.role}:${JSON.stringify(message.content ?? '')}`);
    seen++;
    if (message.role === 'user') break;
  }
  return seen > 0 ? hash.digest('hex').slice(0, 32) : undefined;
}

function errorBody(kind: string, message: string): Record<string, unknown> {
  return { error: { type: kind, message } };
}

/**
 * 错误响应统一走原生 `Response`。
 *
 * Hono 的 `c.json` 只接受它自己枚举的 `ContentfulStatusCode`，而我们需要
 * 499（客户端主动断开）和 501 这类它不认的码，靠断言绕过反而毁了类型安全。
 */
function jsonResponse(
  value: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
/** 将 Responses 翻译后的 CC SSE 聚合为标准的非流式 Chat Completions 响应。 */
async function collectCcSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  let id = `chatcmpl-${Date.now()}`;
  let model = 'acmos';
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let reasoningContent = '';
  let reasoningEncryptedContent: string | undefined;
  let finishReason: string | null = 'stop';
  let usage: unknown;
  const toolCalls = new Map<number, Record<string, unknown>>();

  for await (const event of parseSseStream(stream)) {
    if (event.data === '[DONE]') continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof chunk.id === 'string') id = chunk.id;
    if (typeof chunk.model === 'string') model = chunk.model;
    if (typeof chunk.created === 'number') created = chunk.created;
    if (chunk.usage !== undefined) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice || typeof choice !== 'object') continue;
    const choiceRecord = choice as Record<string, unknown>;
    if (typeof choiceRecord.finish_reason === 'string') finishReason = choiceRecord.finish_reason;
    const delta = choiceRecord.delta;
    if (!delta || typeof delta !== 'object') continue;
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.content === 'string') content += deltaRecord.content;
    if (typeof deltaRecord.reasoning_content === 'string')
      reasoningContent += deltaRecord.reasoning_content;
    if (typeof deltaRecord.reasoning_encrypted_content === 'string') {
      reasoningEncryptedContent = deltaRecord.reasoning_encrypted_content;
    }
    if (!Array.isArray(deltaRecord.tool_calls)) continue;
    for (const call of deltaRecord.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const part = call as Record<string, unknown>;
      const index = typeof part.index === 'number' ? part.index : toolCalls.size;
      const prior = toolCalls.get(index) ?? { index, function: { arguments: '' } };
      if (typeof part.id === 'string') prior.id = part.id;
      if (typeof part.type === 'string') prior.type = part.type;
      const functionPart = part.function;
      if (functionPart && typeof functionPart === 'object') {
        const fn = functionPart as Record<string, unknown>;
        const priorFn = prior.function as Record<string, unknown>;
        if (typeof fn.name === 'string') priorFn.name = fn.name;
        if (typeof fn.arguments === 'string') {
          priorFn.arguments = `${typeof priorFn.arguments === 'string' ? priorFn.arguments : ''}${fn.arguments}`;
        }
      }
      toolCalls.set(index, prior);
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (reasoningEncryptedContent) message.reasoning_encrypted_content = reasoningEncryptedContent;
  if (toolCalls.size > 0) message.tool_calls = [...toolCalls.values()];
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** 返回配置的直连视觉模型；sidecar 模型不能是 combo，避免 OCR 请求递归进入 fallback。 */
function visionSidecarTargetOf(ctx: AppContext): ResolvedTarget | undefined {
  const config = ctx.loaded.config.visionSidecar;
  if (!config.enabled) return undefined;
  const route = ctx.registry.resolve(config.model);
  if (!route || route.combo || route.targets.length !== 1) {
    ctx.logger.warn('识图 sidecar 模型不可解析为直连模型，已禁用本次转写', {
      model: config.model,
    });
    return undefined;
  }
  return route.targets[0];
}

/** 仅当当前实际候选不支持图片时，调用配置的视觉 sidecar 把图片转成文本。 */
async function applyVisionSidecar(
  ctx: AppContext,
  target: ResolvedTarget,
  messages: CcRequestBody['messages'],
  signal: AbortSignal,
  descriptions: Map<string, string>,
): Promise<CcRequestBody['messages']> {
  const visualTarget = visionSidecarTargetOf(ctx);
  if (!visualTarget || !Array.isArray(messages)) return messages;
  const result = await maybeUseVisionSidecar({
    target,
    visionTarget: visualTarget,
    messages,
    maxTokens: ctx.loaded.config.visionSidecar.maxTokens,
    logger: ctx.logger,
    globalProxy: ctx.loaded.config.proxy,
    signal,
    descriptions,
  });
  return result.messages;
}

export function createServer(getContext: () => AppContext): Hono {
  const app = new Hono();

  // --- 入站鉴权 -----------------------------------------------------------
  app.use('/v1/*', async (c, next) => {
    const { loaded } = getContext();
    const expected = loaded.config.apiKeys;
    if (expected.length === 0) return next();

    const header = c.req.header('authorization') ?? c.req.header('x-api-key') ?? '';
    const presented = header.replace(/^Bearer\s+/i, '').trim();
    if (!expected.includes(presented)) {
      return jsonResponse(errorBody('auth', '缺少或错误的 API key'), 401);
    }
    return next();
  });

  app.get('/health', (c) => {
    const { loaded, catalog } = getContext();
    return c.json({
      status: 'ok',
      config: loaded.sourcePath,
      catalog: catalog.source,
      providers: Object.keys(loaded.config.providers).length,
      combo: Object.keys(loaded.config.combo).length,
    });
  });
  app.get('/v1/models', (c) => {
    const { registry } = getContext();
    const created = Math.floor(Date.now() / 1000);
    return c.json({
      object: 'list',
      data: registry.listModels().map((entry) => ({
        id: entry.id,
        object: 'model',
        created,
        owned_by: entry.ownedBy,
        ...(entry.meta?.contextWindow ? { context_window: entry.meta.contextWindow } : {}),
        ...(entry.meta?.maxOutputTokens ? { max_output_tokens: entry.meta.maxOutputTokens } : {}),
        ...(entry.meta
          ? {
              capabilities: {
                reasoning: entry.meta.reasoning === true,
                tools: entry.meta.tools === true,
                vision: entry.meta.vision === true,
              },
            }
          : {}),
      })),
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    const ctx = getContext();
    const reqId = randomUUID().slice(0, 8);
    const log = ctx.logger.child({ reqId });
    const started = Date.now();

    let body: CcRequestBody;
    try {
      body = (await c.req.json()) as CcRequestBody;
    } catch {
      return jsonResponse(errorBody('badRequest', '请求体不是合法 JSON'), 400);
    }

    const requested = typeof body.model === 'string' ? body.model : '';
    const route = ctx.registry.resolve(requested);
    if (!route) {
      return jsonResponse(errorBody('notFound', `未知模型 "${requested}"`), 404);
    }

    const stream = body.stream === true;
    log.info('收到请求', {
      ingress: 'cc',
      model: requested,
      combo: route.combo,
      stream,
      candidates: route.targets.length,
    });
    const sidecarDescriptions = new Map<string, string>();
    try {
      const result = await dispatch({
        route,
        reqId,
        ingress: 'cc' as WireFormat,
        logger: log,
        store: ctx.store,
        globalProxy: ctx.loaded.config.proxy,
        signal: c.req.raw.signal,
        sessionKey: sessionKeyOf(body),
        sessionId: reqId,
        resolvePath: (target: ResolvedTarget) =>
          target.wire === 'resp'
            ? '/responses'
            : target.wire === 'am'
              ? '/messages'
              : '/chat/completions',
        buildBody: async (target: ResolvedTarget) => {
          assertCcRequestCompatible(body, target);
          const messages = await applyVisionSidecar(
            ctx,
            target,
            body.messages,
            c.req.raw.signal,
            sidecarDescriptions,
          );
          const request = { ...body, messages };
          const built =
            target.wire === 'resp'
              ? buildResponsesRequest(request, target, reqId)
              : target.wire === 'am'
                ? buildCcToAmRequest(request, target)
                : buildCcRequest(request, target);
          log.trace('上游请求体', built, { provider: target.providerId, wire: target.wire });
          return built;
        },
      });

      const { target, response, attempt } = result;
      const headers: Record<string, string> = {
        'x-acmos-request-id': reqId,
        'x-acmos-provider': target.providerId,
        'x-acmos-model': target.modelId,
      };

      const recordUsage = (usage: unknown, status: 'ok' | 'error'): void => {
        const parsed = extractCcUsage(usage);
        ctx.store.recordUsage({
          reqId,
          ingress: 'cc',
          wire: target.wire,
          requestedModel: requested,
          provider: target.providerId,
          model: target.modelId,
          combo: route.combo,
          attempt,
          inputTokens: parsed?.inputTokens,
          outputTokens: parsed?.outputTokens,
          cacheReadTokens: parsed?.cacheReadTokens,
          reasoningTokens: parsed?.reasoningTokens,
          latencyMs: Date.now() - started,
          status,
        });
        log.info('请求完成', {
          provider: target.providerId,
          model: target.modelId,
          latencyMs: Date.now() - started,
          ...(parsed ?? {}),
        });
      };

      if (!stream) {
        const json =
          target.wire === 'resp'
            ? response.body
              ? await collectCcSse(translateResponsesSseToCc(response.body))
              : (() => {
                  throw new UpstreamError({ kind: 'upstream', message: '上游未返回响应体' });
                })()
            : target.wire === 'am'
              ? amJsonToCcResponse((await response.json()) as Record<string, unknown>)
              : ((await response.json()) as Record<string, unknown>);
        result.commitSticky();
        recordUsage(json.usage, 'ok');
        return jsonResponse(json, 200, headers);
      }

      if (!response.body) {
        throw new UpstreamError({ kind: 'upstream', message: '上游未返回响应体' });
      }

      result.commitSticky();

      // wire=resp：上游是 Responses SSE，翻译成 CC SSE 再转发，同时旁路嗅探 usage。
      // wire=cc：快路径，字节原样转发，仅旁路嗅探 usage。不反序列化就不可能丢字段。
      let sniffed: unknown;
      let completed = false;
      const onCcChunk = (event: { data: string }): void => {
        if (event.data === '[DONE]') {
          completed = true;
          return;
        }
        try {
          const chunk = JSON.parse(event.data) as Record<string, unknown>;
          if (chunk.usage) sniffed = chunk.usage;
        } catch {
          // 上游偶尔会插入非 JSON 的保活帧，忽略即可。
        }
      };

      const translated =
        target.wire === 'resp'
          ? translateResponsesSseToCc(response.body)
          : target.wire === 'am'
            ? translateAmSseToCc(response.body)
            : response.body;

      const piped = sniffSseStream(translated, onCcChunk);

      const reported = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = piped.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            if (!completed) {
              throw new UpstreamError({
                kind: 'upstream',
                message: '上游流在完成标记前结束',
              });
            }
            recordUsage(sniffed, 'ok');
          } catch (err) {
            const error =
              err instanceof UpstreamError
                ? err
                : new UpstreamError({ kind: 'upstream', message: String(err), raw: err });
            log.warn('流式转发中断', { error: error.message });
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(errorBody(error.kind, error.message))}\n\ndata: [DONE]\n\n`,
              ),
            );
            recordUsage(sniffed, 'error');
          } finally {
            controller.close();
            reader.releaseLock();
          }
        },
      });

      return new Response(reported, {
        headers: {
          ...headers,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    } catch (err) {
      const error =
        err instanceof UpstreamError
          ? err
          : new UpstreamError({ kind: 'internal', message: String(err), raw: err });

      if (error.kind === 'canceled') {
        log.info('客户端已断开', { latencyMs: Date.now() - started });
        return new Response(null, { status: 499 });
      }

      log.error('请求失败', {
        kind: error.kind,
        status: error.httpStatus,
        message: error.message,
        latencyMs: Date.now() - started,
      });
      return jsonResponse(errorBody(error.kind, error.message), STATUS_BY_KIND[error.kind] ?? 500, {
        'x-acmos-request-id': reqId,
      });
    }
  });

  // Anthropic Messages 入站：AM body -> CC/resp 上游 -> AM SSE 响应。
  app.post('/v1/messages', async (c) => {
    const ctx = getContext();
    const reqId = randomUUID().slice(0, 8);
    const log = ctx.logger.child({ reqId });
    const started = Date.now();

    let body: AmRequestBody;
    try {
      body = (await c.req.json()) as AmRequestBody;
    } catch {
      return jsonResponse(errorBody('badRequest', '请求体不是合法 JSON'), 400);
    }

    const requested = typeof body.model === 'string' ? body.model : '';
    const route = ctx.registry.resolve(requested);
    if (!route) {
      return jsonResponse(errorBody('notFound', `未知模型 "${requested}"`), 404);
    }

    const stream = body.stream !== false;
    log.info('收到请求', {
      ingress: 'am',
      model: requested,
      combo: route.combo,
      stream,
      candidates: route.targets.length,
    });
    log.trace('入站请求体', body);

    const sidecarDescriptions = new Map<string, string>();
    try {
      const result = await dispatch({
        route,
        reqId,
        ingress: 'am' as WireFormat,
        logger: log,
        store: ctx.store,
        globalProxy: ctx.loaded.config.proxy,
        signal: c.req.raw.signal,
        sessionKey: undefined,
        sessionId: reqId,
        resolvePath: (target: ResolvedTarget) =>
          target.wire === 'resp'
            ? '/responses'
            : target.wire === 'am'
              ? '/messages'
              : '/chat/completions',
        buildBody: async (target: ResolvedTarget) => {
          const source = buildAmToCcRequest(body, target);
          assertCcRequestCompatible(source, target);
          if (target.wire === 'am') {
            const messages = await applyVisionSidecar(
              ctx,
              target,
              source.messages,
              c.req.raw.signal,
              sidecarDescriptions,
            );
            const built =
              messages === source.messages
                ? { ...body, model: target.modelId }
                : buildCcToAmRequest({ ...source, messages }, target);
            log.trace('上游请求体', built, { provider: target.providerId, wire: target.wire });
            return built;
          }
          const messages = await applyVisionSidecar(
            ctx,
            target,
            source.messages,
            c.req.raw.signal,
            sidecarDescriptions,
          );
          const ccBody = { ...source, messages };
          const built =
            target.wire === 'resp' ? buildResponsesRequest(ccBody, target, reqId) : ccBody;
          log.trace('上游请求体', built, { provider: target.providerId, wire: target.wire });
          return built;
        },
      });

      const { target, response, attempt } = result;
      const headers: Record<string, string> = {
        'x-acmos-request-id': reqId,
        'x-acmos-provider': target.providerId,
        'x-acmos-model': target.modelId,
      };

      const recordUsage = (usage: unknown, status: 'ok' | 'error'): void => {
        const parsed = extractCcUsage(usage);
        ctx.store.recordUsage({
          reqId,
          ingress: 'am',
          wire: target.wire,
          requestedModel: requested,
          provider: target.providerId,
          model: target.modelId,
          combo: route.combo,
          attempt,
          inputTokens: parsed?.inputTokens,
          outputTokens: parsed?.outputTokens,
          cacheReadTokens: parsed?.cacheReadTokens,
          reasoningTokens: parsed?.reasoningTokens,
          latencyMs: Date.now() - started,
          status,
        });
        log.info('请求完成', {
          provider: target.providerId,
          model: target.modelId,
          latencyMs: Date.now() - started,
          ...(parsed ?? {}),
        });
      };

      if (!stream) {
        const json =
          target.wire === 'resp'
            ? response.body
              ? await collectCcSse(translateResponsesSseToCc(response.body))
              : (() => {
                  throw new UpstreamError({ kind: 'upstream', message: '上游未返回响应体' });
                })()
            : target.wire === 'am'
              ? ((await response.json()) as Record<string, unknown>)
              : ((await response.json()) as Record<string, unknown>);
        result.commitSticky();
        recordUsage(target.wire === 'am' ? undefined : json.usage, 'ok');
        return jsonResponse(target.wire === 'am' ? json : ccJsonToAmResponse(json), 200, headers);
      }

      if (!response.body) {
        throw new UpstreamError({ kind: 'upstream', message: '上游未返回响应体' });
      }

      result.commitSticky();

      if (target.wire === 'am') {
        return new Response(response.body, {
          headers: {
            ...headers,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }
      const ccStream =
        target.wire === 'resp' ? translateResponsesSseToCc(response.body) : response.body;
      let sniffed: unknown;
      const piped = sniffSseStream(ccStream, (event) => {
        if (event.data === '[DONE]') return;
        try {
          const chunk = JSON.parse(event.data) as Record<string, unknown>;
          if (chunk.usage) sniffed = chunk.usage;
        } catch {
          // 非 JSON 保活帧，忽略。
        }
      });
      const amStream = translateCcSseToAm(piped);
      const reported = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = amStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            recordUsage(sniffed, 'ok');
          } catch (err) {
            log.warn('流式转发中断', { error: String(err) });
            recordUsage(sniffed, 'error');
          } finally {
            controller.close();
            reader.releaseLock();
          }
        },
      });
      return new Response(reported, {
        headers: {
          ...headers,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    } catch (err) {
      const error =
        err instanceof UpstreamError
          ? err
          : new UpstreamError({ kind: 'internal', message: String(err), raw: err });
      if (error.kind === 'canceled') {
        log.info('客户端已断开', { latencyMs: Date.now() - started });
        return new Response(null, { status: 499 });
      }
      log.error('请求失败', {
        kind: error.kind,
        status: error.httpStatus,
        message: error.message,
        latencyMs: Date.now() - started,
      });
      return jsonResponse(errorBody(error.kind, error.message), STATUS_BY_KIND[error.kind] ?? 500, {
        'x-acmos-request-id': reqId,
      });
    }
  });

  // Responses 入站复用 Chat Completions 的路由、fallback 与鉴权；仅在边界转换协议。
  app.post('/v1/responses', async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse(errorBody('badRequest', '请求体必须是 JSON 对象'), 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonResponse(errorBody('badRequest', '请求体不是合法 JSON'), 400);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');
    const ccResponse = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildResponsesToCcRequest(body)),
    });
    if (!ccResponse.ok) return ccResponse;
    if (body.stream === true) {
      if (!ccResponse.body) {
        return jsonResponse(errorBody('upstream', '上游未返回响应体'), 502);
      }
      return new Response(translateCcSseToResponses(ccResponse.body), {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...Object.fromEntries(
            [...ccResponse.headers].filter(([name]) => name.startsWith('x-acmos-')),
          ),
        },
      });
    }
    return jsonResponse(
      ccJsonToResponsesResponse((await ccResponse.json()) as Record<string, unknown>),
      200,
      Object.fromEntries([...ccResponse.headers].filter(([name]) => name.startsWith('x-acmos-'))),
    );
  });

  return app;
}
