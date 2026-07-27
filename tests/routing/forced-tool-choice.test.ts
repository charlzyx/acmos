import { describe, expect, test } from 'bun:test';
import type { ResolvedTarget } from '../../src/routing/registry.ts';
import { buildAmToCcRequest } from '../../src/wire/am/request.ts';
import { assertCcRequestCompatible } from '../../src/wire/cc/request.ts';

const forcedChoiceUnsupported = {
  modelId: 'test-model',
  compat: { supportsForcedToolChoice: false },
  thinking: undefined,
} as unknown as ResolvedTarget;

describe('forced tool choice compatibility', () => {
  test('rejects Anthropic forced selection after converting to Chat Completions', () => {
    const request = buildAmToCcRequest(
      {
        messages: [],
        tool_choice: { type: 'any' },
      },
      forcedChoiceUnsupported,
    );

    expect(request.tool_choice).toBe('required');
    expect(() => assertCcRequestCompatible(request, forcedChoiceUnsupported)).toThrow(
      /不支持强制工具选择/,
    );
  });
});
