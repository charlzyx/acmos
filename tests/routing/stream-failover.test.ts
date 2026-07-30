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

function sseError(): Response {
  return new Response('event: error\ndata: {"error":{"message":"upstream unavailable"}}\n\n');
}

function jsonError(): Response {
  return Response.json({ error: { message: 'upstream unavailable' } });
}

function openSse(data: string): {
  response: Response;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode(data));
      },
    }),
  );
  return {
    response,
    close: () => controller?.close(),
  };
}

function route(first: ResolvedTarget, second: ResolvedTarget): Route {
  return {
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
}

describe('response preflight failover', () => {
  test('returns a live SSE response after inspecting its first event', async () => {
    const first = target('first');
    const live = openSse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    globalThis.fetch = (async () => live.response) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const dispatched = dispatch({
        route: route(first, target('second')),
        reqId: 'test',
        ingress: 'cc',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: true }),
        resolvePath: () => '/chat/completions',
      });
      const outcome = await Promise.race([
        dispatched.then((result) => ({ result })),
        Bun.sleep(100).then(() => ({ timeout: true as const })),
      ]);

      live.close();
      const result = await dispatched;
      expect('timeout' in outcome).toBe(false);
      expect(await result.response.text()).toContain('"content":"ok"');
    } finally {
      store.close();
    }
  });

  test('retries the same combo member after a first SSE error', async () => {
    const first = target('first');
    const responses = [sseError(), new Response('data: [DONE]\n\n')];
    globalThis.fetch = (async () => responses.shift() ?? new Response()) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const result = await dispatch({
        route: route(first, target('second')),
        reqId: 'test',
        ingress: 'cc',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: true }),
        resolvePath: () => '/chat/completions',
      });

      expect(result.target.providerId).toBe('first');
      expect(result.attempt).toBe(1);
      expect(await result.response.text()).toBe('data: [DONE]\n\n');
    } finally {
      store.close();
    }
  });

  test('falls back after exhausting first-frame retries for a combo member', async () => {
    const first = target('first');
    const second = target('second');
    const responses = [sseError(), sseError(), sseError(), new Response('data: [DONE]\n\n')];
    globalThis.fetch = (async () => responses.shift() ?? new Response()) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const result = await dispatch({
        route: route(first, second),
        reqId: 'test',
        ingress: 'am',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: true }),
        resolvePath: () => '/messages',
      });

      expect(result.target.providerId).toBe('second');
      expect(result.attempt).toBe(3);
      expect(await result.response.text()).toBe('data: [DONE]\n\n');
    } finally {
      store.close();
    }
  });

  test('retries the same combo member after a non-streaming body error', async () => {
    const first = target('first');
    const responses = [jsonError(), Response.json({ id: 'ok' })];
    globalThis.fetch = (async () => responses.shift() ?? new Response()) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const result = await dispatch({
        route: route(first, target('second')),
        reqId: 'test',
        ingress: 'cc',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: false }),
        resolvePath: () => '/chat/completions',
      });

      expect(result.target.providerId).toBe('first');
      expect(result.attempt).toBe(1);
      expect(await result.response.json()).toEqual({ id: 'ok' });
    } finally {
      store.close();
    }
  });

  test('falls back after exhausting non-streaming body-error retries', async () => {
    const first = target('first');
    const second = target('second');
    const responses = [jsonError(), jsonError(), jsonError(), Response.json({ id: 'fallback' })];
    globalThis.fetch = (async () => responses.shift() ?? new Response()) as unknown as typeof fetch;

    const store = new Store(':memory:');
    try {
      const result = await dispatch({
        route: route(first, second),
        reqId: 'test',
        ingress: 'cc',
        logger: new Logger(),
        store,
        buildBody: () => ({ model: 'free', stream: false }),
        resolvePath: () => '/chat/completions',
      });

      expect(result.target.providerId).toBe('second');
      expect(result.attempt).toBe(3);
      expect(await result.response.json()).toEqual({ id: 'fallback' });
    } finally {
      store.close();
    }
  });
});
