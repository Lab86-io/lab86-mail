import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setObjectGenerationDepsForTest,
  agentProviderOptions,
  generateObjectForCurrentUser,
  generateTextForCurrentUser,
  recordClassifierUsage,
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

describe('a failed call records its own row with the usage it had', () => {
  afterEach(() => __setObjectGenerationDepsForTest());
  const runtime = {
    userId: 'u',
    source: 'byok',
    provider: 'openrouter',
    modelName: 'anthropic/claude-opus-5.5',
    model: 'opus',
  } as any;

  test('a schema failure records the usage of its response', async () => {
    const usage: any[] = [];
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () => runtime,
      generateObject: (async () => {
        throw Object.assign(new Error('No object generated: response did not match schema.'), {
          usage: { inputTokens: 516, outputTokens: 158 },
          response: { id: 'gen-opus' },
        });
      }) as any,
      recordUsage: (async (...args: any[]) => usage.push(args)) as any,
    });
    await expect(
      generateObjectForCurrentUser({ feature: 'brief_preparation_research', schema: {}, prompt: '{}' }),
    ).rejects.toThrow('did not match schema');
    expect(usage).toHaveLength(1);
    expect(usage[0].slice(1)).toEqual([
      'brief_preparation_research',
      { inputTokens: 516, outputTokens: 158 },
      false,
      'No object generated: response did not match schema.',
    ]);
  });

  test('each failed attempt of a text call is one row, and a fallback success is one more', async () => {
    const usage: any[] = [];
    // The fallback chain serves hosted calls. No request left an id, so no lookup runs.
    const hostedRuntime = { ...runtime, source: 'lab86' };
    const fallback = { ...hostedRuntime, modelName: 'openai/gpt-5.5', model: 'fallback' };
    const result = await generateTextForCurrentUser(
      { feature: 'daily_report_insight' },
      {
        resolveAiRuntime: async () => hostedRuntime,
        fallbackRuntimes: () => [fallback],
        recordUsage: (async (...args: any[]) => usage.push(args)) as any,
        generateText: (async (request: any) => {
          if (request.model === 'fallback')
            return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3 } };
          throw Object.assign(new Error('upstream error'), {
            statusCode: 502,
            lastError: { usage: { inputTokens: 40, outputTokens: 7 } },
          });
        }) as any,
      },
    );
    expect(result.text).toBe('ok');
    expect(usage.map((row) => [row[0].modelName, row[2], row[3], row[4]])).toEqual([
      ['anthropic/claude-opus-5.5', { inputTokens: 40, outputTokens: 7 }, false, 'upstream error'],
      ['openai/gpt-5.5', { inputTokens: 9, outputTokens: 3 }, true, undefined],
    ]);
  });

  test('a cut brief answer records one failed row per attempt, not two', async () => {
    const usage: any[] = [];
    await expect(
      generateTextForCurrentUser(
        { feature: 'daily_brief_prose' },
        {
          resolveAiRuntime: async () => runtime,
          fallbackRuntimes: () => [],
          recordUsage: (async (...args: any[]) => usage.push(args)) as any,
          generateText: (async () => ({
            text: '{"lede":',
            finishReason: 'length',
            usage: { inputTokens: 100, outputTokens: 32_000 },
          })) as any,
        },
      ),
    ).rejects.toThrow('exhausted its own output allowance');
    // Two attempts (the brief retry), one row each.
    expect(usage.map((row) => [row[2].outputTokens, row[3], row[4]])).toEqual([
      [32_000, false, 'Incomplete brief response'],
      [32_000, false, 'Incomplete brief response'],
    ]);
  });
});

describe('usage records the cost the provider reported', () => {
  afterEach(() => __setObjectGenerationDepsForTest());
  const runtime = {
    userId: 'u',
    source: 'lab86',
    provider: 'openrouter',
    modelName: 'z-ai/glm-5.3-flash',
    model: 'glm',
  } as any;
  const body = (cost?: number) => ({ body: { usage: { prompt_tokens: 10, completion_tokens: 2, cost } } });

  test('a tool loop sums the OpenRouter cost of each step', async () => {
    const usage: any[] = [];
    await generateTextForCurrentUser(
      { feature: 'narrative_research' },
      {
        resolveAiRuntime: async () => runtime,
        fallbackRuntimes: () => [],
        recordUsage: (async (...args: any[]) => usage.push(args)) as any,
        generateText: (async () => ({
          text: 'done',
          finishReason: 'stop',
          totalUsage: { inputTokens: 20, outputTokens: 4 },
          steps: [{ response: body(0.0012) }, { response: body(0.0003) }],
        })) as any,
      },
    );
    expect(usage[0][2].inputTokens).toBe(20);
    expect(usage[0][2].costUsd).toBeCloseTo(0.0015);
  });

  test('a direct key with no reported cost keeps the plain usage for the price table', async () => {
    const usage: any[] = [];
    await generateTextForCurrentUser(
      { feature: 'summarize_thread' },
      {
        resolveAiRuntime: async () => ({ ...runtime, provider: 'openai' }),
        fallbackRuntimes: () => [],
        recordUsage: (async (...args: any[]) => usage.push(args)) as any,
        generateText: (async () => ({
          text: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 1 },
          response: { body: { usage: { prompt_tokens: 5 } } },
        })) as any,
      },
    );
    expect(usage[0][2]).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  test('a structured call records the cost from its response body', async () => {
    const usage: any[] = [];
    __setObjectGenerationDepsForTest({
      resolveAiRuntime: async () => runtime,
      generateObject: (async () => ({
        object: {},
        usage: { inputTokens: 10, outputTokens: 2 },
        response: body(0.0004),
      })) as any,
      recordUsage: (async (...args: any[]) => usage.push(args)) as any,
    });
    await generateObjectForCurrentUser({ feature: 'albatross_area_route', schema: {}, prompt: '{}' });
    expect(usage[0][2]).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.0004 });
  });

  test('a classifier result passes its reported cost; no cost keeps the plain token usage', async () => {
    const recorded: any[] = [];
    const record: any = async (...args: any[]) => {
      recorded.push(args[2]);
    };
    const owner = { userId: 'owner', source: 'lab86' as const };
    await recordClassifierUsage(
      owner,
      'jev_mail',
      { model: 'typesafe/jev-1.13', usage: { input_tokens: 200, output_tokens: 0, cost: 0.0000084 } },
      record,
    );
    await recordClassifierUsage(
      owner,
      'jev_mail',
      { model: 'typesafe/jev-1.13', usage: { input_tokens: 200, output_tokens: 0 } },
      record,
    );
    expect(recorded).toEqual([
      { inputTokens: 200, outputTokens: 0, costUsd: 0.0000084 },
      { inputTokens: 200, outputTokens: 0 },
    ]);
    expect('costUsd' in recorded[1]).toBe(false);
  });
});
