import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setObjectGenerationDepsForTest,
  agentProviderOptions,
  generateObjectForCurrentUser,
} from '../lib/ai/gateway';
import { buildModelCatalog } from '../lib/ai/model-catalog';

describe('structured AI gateway', () => {
  afterEach(() => __setObjectGenerationDepsForTest());

  test('vision calls forward images to GLM through OpenRouter and reject text-only or unverified runtimes', async () => {
    let modelName = 'z-ai/glm-5.3-flash';
    const sent: any[] = [];
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () => ({
        userId: 'u',
        source: 'byok',
        provider: 'openrouter',
        modelName,
        model: 'selected-glm',
      }),
      loadRuntimeModelCatalog: async () => buildModelCatalog(),
      generateObject: (async (request: any) => {
        sent.push(request);
        return { object: {}, usage: {} };
      }) as any,
      recordUsage: async () => undefined,
    });
    const messages = [
      { role: 'user', content: [{ type: 'image', image: Buffer.from('slide'), mediaType: 'image/png' }] },
    ];
    const options = { schema: {}, feature: 'presentation_visual_review', requireVision: true, messages };
    await generateObjectForCurrentUser(options);
    expect(sent[0]).toMatchObject({ model: 'selected-glm', maxOutputTokens: 3500, messages });
    expect(sent[0]).not.toHaveProperty('requireVision');
    for (const id of ['deepseek/deepseek-v4-pro', 'vendor/unverified']) {
      modelName = id;
      await expect(generateObjectForCurrentUser(options)).rejects.toThrow('verified image-input');
    }
    expect(sent).toHaveLength(1);
  });

  test('agent cache and reasoning options follow the provider transport', () => {
    const direct = agentProviderOptions({ provider: 'openai' } as any, 'agent:owner');
    expect(direct?.openai).toMatchObject({
      reasoningEffort: process.env.LAB86_MAIL_AGENT_REASONING_EFFORT || 'low',
      reasoningSummary: 'auto',
      parallelToolCalls: true,
      promptCacheKey: 'agent:owner',
    });
    expect(agentProviderOptions({ provider: 'openai' } as any)?.openai).not.toHaveProperty('promptCacheKey');
    expect(agentProviderOptions({ provider: 'openrouter' } as any, 'agent:owner')).toEqual({
      openai: {
        reasoningEffort: (process.env.LAB86_MAIL_AGENT_REASONING_EFFORT || 'low') as 'low',
        parallelToolCalls: true,
      },
    });
    expect(agentProviderOptions({ provider: 'anthropic' } as any, 'agent:owner')).toBeUndefined();
  });

  test('uses the resolved model, feature cap, and default strict provider options', async () => {
    const requests: any[] = [];
    const usage: any[] = [];
    let runtimeRequest: any;
    const runtime = {
      userId: 'user_1',
      source: 'lab86',
      provider: 'openai',
      modelName: 'gpt-5.6-luna',
      model: 'resolved-model',
    } as any;
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async (input) => {
        runtimeRequest = input;
        return runtime;
      },
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
      narrativeModel: 'z-ai/glm-5.3-flash',
    });

    expect(result.object).toEqual({ assignments: [] });
    expect(runtimeRequest).toMatchObject({
      userId: 'user_1',
      speed: 'classify',
      feature: 'albatross_area_route',
      narrativeModel: 'z-ai/glm-5.3-flash',
    });
    expect(requests[0]).toMatchObject({
      model: 'resolved-model',
      maxOutputTokens: 1200,
      providerOptions: { openai: { strictJsonSchema: true } },
    });
    expect(requests[0].narrativeModel).toBeUndefined();
    expect(requests[0].providerOptions.openai.reasoningEffort).toBeUndefined();
    expect(usage[0][0]).toBe(runtime);
    expect(usage[0].slice(1)).toEqual(['albatross_area_route', { inputTokens: 10, outputTokens: 2 }, true]);
  });

  test('presentation planning forwards high effort with a bounded output budget', async () => {
    let sent: any;
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () =>
        ({
          userId: 'planner',
          source: 'lab86',
          provider: 'openai',
          modelName: 'gpt-5.5',
          model: 'resolved',
        }) as any,
      generateObject: (async (request: any) => {
        sent = request;
        return { object: {}, usage: {} };
      }) as any,
      recordUsage: async () => undefined,
    });
    await generateObjectForCurrentUser({
      userId: 'planner',
      schema: {},
      feature: 'presentation_planning',
      speed: 'primary',
      reasoningEffort: 'high',
    });
    expect(sent.providerOptions.openai.reasoningEffort).toBe('high');
    expect(sent.maxOutputTokens).toBe(24000);
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
