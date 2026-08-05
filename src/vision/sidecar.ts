import type { Logger } from '../log/logger.ts';
import type { ResolvedTarget } from '../routing/registry.ts';
import { callUpstream, isFailoverable, UpstreamError } from '../upstream/client.ts';
import { parseSseStream } from '../upstream/sse.ts';
import { buildCcRequest, type CcMessage, type CcRequestBody } from '../wire/cc/request.ts';
import { translateResponsesSseToCc } from '../wire/resp/decode.ts';
import { buildResponsesRequest } from '../wire/resp/request.ts';

/** 视觉 sidecar 的调用参数。 */
export interface VisionSidecarOptions {
  /** 原请求将要使用的目标；其无视觉能力时才交给 sidecar 转写。 */
  target: ResolvedTarget;
  /** 配置指定的视觉模型，按顺序在可重试失败时切换。 */
  visionTargets: ResolvedTarget[];
  messages: CcMessage[];
  maxTokens: number;
  descriptions?: Map<string, string> | undefined;
  logger: Logger;
  globalProxy?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** 视觉 sidecar 的处理结果。 */
export interface VisionSidecarResult {
  messages: CcMessage[];
  sidecarUsed: boolean;
}

type ContentPart = Record<string, unknown> & { type: string };

function isContentPart(value: unknown): value is ContentPart {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function imageParts(messages: CcMessage[]): Array<{
  messageIndex: number;
  partIndex: number;
  part: ContentPart;
}> {
  const out: Array<{ messageIndex: number; partIndex: number; part: ContentPart }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const part = content[partIndex];
      if (isContentPart(part) && part.type === 'image_url') {
        out.push({ messageIndex, partIndex, part });
      }
    }
  }
  return out;
}

function textFromChunk(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';

  let text = '';
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (!delta || typeof delta !== 'object') continue;
    const content = (delta as { content?: unknown }).content;
    if (typeof content === 'string') text += content;
  }
  return text;
}

/** 从 CC SSE 响应中聚合模型生成的图片描述。 */
async function readDescription(stream: ReadableStream<Uint8Array>): Promise<string> {
  let description = '';
  for await (const event of parseSseStream(stream)) {
    if (event.data === '[DONE]') continue;
    try {
      description += textFromChunk(JSON.parse(event.data));
    } catch {
      // SSE 保活帧和非 JSON 帧不参与文本聚合。
    }
  }
  return description.trim();
}

/**
 * 当目标模型不支持图片时，依序使用视觉 sidecar 生成描述并替换全部图片。
 * 所有 sidecar 失败时保留原始请求，避免辅助能力影响正常请求的可用性。
 */
export async function maybeUseVisionSidecar(
  opts: VisionSidecarOptions,
): Promise<VisionSidecarResult> {
  const { target, visionTargets, messages, maxTokens, logger, globalProxy, signal, descriptions } =
    opts;
  if (target.meta.vision === true) return { messages, sidecarUsed: false };
  const visualTargets = visionTargets.filter((visualTarget) => visualTarget.meta.vision === true);
  if (visualTargets.length === 0) {
    logger.warn('没有支持图片的视觉 sidecar 模型，跳过转写', {
      provider: target.providerId,
      model: target.modelId,
    });
    return { messages, sidecarUsed: false };
  }

  const images = imageParts(messages);
  if (images.length === 0) return { messages, sidecarUsed: false };

  try {
    const rewritten = messages.map((message) => ({ ...message }));
    for (const image of images) {
      const cacheKey = JSON.stringify(image.part);
      let description = descriptions?.get(cacheKey);
      if (!description) {
        let lastError: unknown;
        for (const visualTarget of visualTargets) {
          try {
            const sourceBody: CcRequestBody = {
              model: visualTarget.modelId,
              stream: true,
              max_tokens: maxTokens,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: '请准确描述这张图片中的内容、文字和关键信息。' },
                    image.part,
                  ],
                },
              ],
            };
            const response = await callUpstream({
              target: visualTarget,
              path: visualTarget.wire === 'resp' ? '/responses' : '/chat/completions',
              body:
                visualTarget.wire === 'resp'
                  ? buildResponsesRequest(sourceBody, visualTarget)
                  : buildCcRequest(sourceBody, visualTarget),
              signal,
              globalProxy,
              logger,
            });
            if (!response.body) throw new Error('视觉模型未返回响应体');
            const ccStream =
              visualTarget.wire === 'resp'
                ? translateResponsesSseToCc(response.body)
                : response.body;
            description = await readDescription(ccStream);
            if (!description) throw new Error('视觉模型未返回图片描述');
            descriptions?.set(cacheKey, description);
            break;
          } catch (err) {
            lastError = err;
            logger.warn('识图 sidecar 失败，尝试备选模型', {
              provider: visualTarget.providerId,
              model: visualTarget.modelId,
              error: String(err),
            });
            if (!(err instanceof UpstreamError) || !isFailoverable(err.kind)) throw err;
          }
        }
        if (!description) throw lastError ?? new Error('视觉 sidecar 未返回图片描述');
      }

      const originalContent = rewritten[image.messageIndex]?.content;
      if (!Array.isArray(originalContent)) throw new Error('图片消息内容无效');
      const content = [...originalContent];
      content[image.partIndex] = { type: 'text', text: `[image: ${description}]` };
      rewritten[image.messageIndex] = { ...rewritten[image.messageIndex], content };
    }
    return { messages: rewritten, sidecarUsed: true };
  } catch (err) {
    logger.warn('所有识图 sidecar 均失败，保留原始图片', {
      provider: target.providerId,
      model: target.modelId,
      error: String(err),
    });
    return { messages, sidecarUsed: false };
  }
}
