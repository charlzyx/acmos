import { describe, expect, test } from 'bun:test';
import type { ResolvedTarget } from '../../../src/routing/registry.ts';
import { buildCcToAmRequest } from '../../../src/wire/am/request.ts';

const target = {
  providerId: 'anthropic',
  modelId: 'deepseek-am',
  compat: {},
} as ResolvedTarget;

describe('buildCcToAmRequest', () => {
  test('merges consecutive parallel tool results into the next user message', () => {
    const result = buildCcToAmRequest(
      {
        model: 'coder',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"a"}' },
              },
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"b"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_0', content: 'a result' },
          { role: 'tool', tool_call_id: 'call_1', content: 'b result' },
        ],
      },
      target,
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_0', content: 'a result' },
        { type: 'tool_result', tool_use_id: 'call_1', content: 'b result' },
      ],
    });
  });

  test('does not merge tool results across a non-tool message', () => {
    const result = buildCcToAmRequest(
      {
        messages: [
          { role: 'tool', tool_call_id: 'call_0', content: 'first' },
          { role: 'user', content: 'next turn' },
          { role: 'tool', tool_call_id: 'call_1', content: 'second' },
        ],
      },
      target,
    );

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'first' }],
    });
    expect(result.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'second' }],
    });
  });
});
