import { afterEach, describe, expect, test } from 'bun:test';
import { __setObjectGenerationDepsForTest, generateObjectForCurrentUser } from '../lib/ai/gateway';

describe('structured AI gateway', () => {
  afterEach(() => __setObjectGenerationDepsForTest());

  test('uses the resolved model, feature cap, and default strict provider options', async () => {
    const requests: any[] = [];
    const usage: any[] = [];
    const runtime = {
      userId: 'user_1',
      source: 'lab86',
      provider: 'openai',
      modelName: 'gpt-5.6-luna',
      model: 'resolved-model',
    } as any;
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () => runtime,
      generateObject: (async (request: any) => {
        requests.push(request);
        return { object: { assignments: [] }, usage: { inputTokens: 10, outputTokens: 2 } } as any;
      }) as any,
      recordUsage: (async (...args: any[]) => usage.push(args)) as any,
    });

    const result = await generateObjectForCurrentUser<{ assignments: unknown[] }>({
      userId: 'user_1',
      feature: 'albatross_area_route',
      schema: {},
      prompt: '{}',
    });

    expect(result.object).toEqual({ assignments: [] });
    expect(requests[0]).toMatchObject({
      model: 'resolved-model',
      maxOutputTokens: 1200,
      providerOptions: { openai: { reasoningEffort: 'none', strictJsonSchema: true } },
    });
    expect(usage[0][0]).toBe(runtime);
    expect(usage[0].slice(1)).toEqual(['albatross_area_route', { inputTokens: 10, outputTokens: 2 }, true]);
  });

  test('preserves caller provider options and records/rethrows failed generation', async () => {
    const usage: any[] = [];
    const runtime = {
      userId: 'user_2',
      source: 'byok',
      provider: 'anthropic',
      modelName: 'claude-haiku',
      model: 'anthropic-model',
    } as any;
    const providerOptions = { anthropic: { thinking: { type: 'disabled' } } };
    let request: any;
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () => runtime,
      generateObject: (async (input: any) => {
        request = input;
        throw new Error('structured provider failed');
      }) as any,
      recordUsage: (async (...args: any[]) => usage.push(args)) as any,
    });

    await expect(
      generateObjectForCurrentUser({
        userId: 'user_2',
        feature: 'custom_structured',
        schema: {},
        prompt: '{}',
        maxOutputTokens: 321,
        providerOptions,
      }),
    ).rejects.toThrow('structured provider failed');

    expect(request).toMatchObject({
      model: 'anthropic-model',
      maxOutputTokens: 321,
      providerOptions,
    });
    expect(usage[0].slice(1)).toEqual(['custom_structured', undefined, false, 'structured provider failed']);
  });
});
