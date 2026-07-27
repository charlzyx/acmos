import { afterEach, describe, expect, test } from 'bun:test';
import type { ComboConfig, ProviderConfig } from '../../src/config/schema.ts';
import { Logger } from '../../src/log/logger.ts';
import { dispatch } from '../../src/routing/dispatch.ts';
import type { ResolvedTarget, Route } from '../../src/routing/registry.ts';
import { Store } from '../../src/state/store.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function target(providerId: string): ResolvedTarget {
  return {
    providerId,
    provider: {
      wire: 'cc',
      baseUrl: 'https://upstream.test/v1',
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
    auth: { type: 'none', keys: [], keyStrategy: 'round-robin' },
    wire: 'cc',
    modelId: `${providerId}-model`,
    meta: { id: `${providerId}-model`, sources: {} },
    compat: {},
    thinking: undefined,
  };
}

function failedBeforeFirstChunk(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream closed'));
      },
    }),
  );
}

describe('stream failover', () => {
  test('retries the next combo member when the first stream ends before its first chunk', async () => {
    const first = target('first');
    const second = target('second');
    const route: Route = {
      requested: 'free',
      combo: 'free',
      comboConfig: {
        members: [{ provider: 'first', model: 'first-model' }],
        cooldownMs: 60_000,
        sticky: false,
        stickyTtlMs: 30 * 60_000,
      } satisfies ComboConfig,
      targets: [first, second],
    };
    const responses = [failedBeforeFirstChunk(), new Response('data: [DONE]\n\n')];
    globalThis.fetch = (async () => responses.shift() ?? new Response()) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const result = await dispatch({
        route,
        reqId: 'test',
        ingress: 'cc',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: true }),
        resolvePath: () => '/chat/completions',
      });

      expect(result.target.providerId).toBe('second');
      expect(await result.response.text()).toBe('data: [DONE]\n\n');
    } finally {
      store.close();
    }
  });
});
