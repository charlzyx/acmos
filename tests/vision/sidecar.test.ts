import { afterEach, describe, expect, test } from 'bun:test';
import type { ProviderConfig } from '../../src/config/schema.ts';
import { Logger } from '../../src/log/logger.ts';
import type { ResolvedTarget } from '../../src/routing/registry.ts';
import { UpstreamCompatibilityError } from '../../src/upstream/client.ts';
import { maybeUseVisionSidecar } from '../../src/vision/sidecar.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function target(providerId: string, vision: boolean): ResolvedTarget {
  return {
    providerId,
    provider: {
      wire: 'cc',
      baseUrl: `https://${providerId}.test/v1`,
      aliases: [],
      modelDirectory: { enabled: false, path: '/models' },
      timeoutMs: 60_000,
      firstByteTimeoutMs: 60_000,
      enabled: true,
      defaults: {},
      models: [],
      proxy: false,
      headers: {},
    } satisfies ProviderConfig,
    auth: { type: 'none', keys: [], keyStrategy: 'failover' },
    wire: 'cc',
    modelId: `${providerId}-model`,
    meta: { id: `${providerId}-model`, vision, sources: {} },
    compat: {},
    thinking: undefined,
  };
}

const imageMessages = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'read this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ],
  },
];

describe('vision sidecar failover', () => {
  test('uses the next configured model after a retryable failure', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response('limited', { status: 429 });
      return new Response(
        'data: {"choices":[{"delta":{"content":"a receipt"}}]}\n\ndata: [DONE]\n\n',
      );
    }) as typeof fetch;

    const result = await maybeUseVisionSidecar({
      target: target('text', false),
      visionTargets: [target('primary', true), target('backup', true)],
      messages: imageMessages,
      maxTokens: 128,
      logger: new Logger(),
    });

    expect(calls).toEqual([
      'https://primary.test/v1/chat/completions',
      'https://backup.test/v1/chat/completions',
    ]);
    expect(result.sidecarUsed).toBe(true);
    expect(result.messages[0]?.content).toEqual([
      { type: 'text', text: 'read this image' },
      { type: 'text', text: '[image: a receipt]' },
    ]);
  });

  test('rejects a text-only target when sidecars are unavailable', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response('invalid input', { status: 400 });
    }) as typeof fetch;

    const result = maybeUseVisionSidecar({
      target: target('text', false),
      visionTargets: [target('primary', true), target('backup', true)],
      messages: imageMessages,
      maxTokens: 128,
      logger: new Logger(),
    });

    await expect(result).rejects.toThrow(UpstreamCompatibilityError);
    expect(calls).toEqual(['https://primary.test/v1/chat/completions']);
  });

  test('rejects when no vision sidecar is configured', async () => {
    const result = maybeUseVisionSidecar({
      target: target('text', false),
      visionTargets: [],
      messages: imageMessages,
      maxTokens: 128,
      logger: new Logger(),
    });

    await expect(result).rejects.toBeInstanceOf(UpstreamCompatibilityError);
    await expect(result).rejects.toThrow(/没有可用的视觉 sidecar 模型/);
  });
});
