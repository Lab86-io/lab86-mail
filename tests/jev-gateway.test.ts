import { expect, mock, test } from 'bun:test';
import { estimateAiUsageCost } from '../lib/ai/budget';
import {
  recordClassifierUsage,
  resolveClassifierRuntime,
  resolveOpenRouterUtilityRuntime,
} from '../lib/ai/gateway';
import { classifierById } from '../lib/classifier/catalog';

const JEV = classifierById('jev-1.13')!;
const TEV1 = classifierById('tev1-4b')!;

function deps(extra: Record<string, unknown> = {}) {
  return {
    query: mock(async (..._args: any[]) => ({
      settings: { mode: 'lab86', normalModel: 'unrelated-generator' },
    })),
    requiresOwnKey: () => false,
    entitlement: async () => ({ plan: 'pro', monthlyCredits: 500, status: 'active' }),
    decrypt: mock(() => 'decrypted-key'),
    assertBudget: mock((..._args: any[]) => undefined),
    selectedClassifier: async () => JEV,
    platformKey: mock((credential: string) => (credential === 'openrouter' ? 'platform-key' : undefined)),
    ...extra,
  } as any;
}
test('Jev runtime uses fixed provider billing, independent of generative model choices', async () => {
  const d = deps();
  expect(await resolveClassifierRuntime('owner', d)).toEqual({
    userId: 'owner',
    source: 'lab86',
    apiKey: 'platform-key',
    model: JEV,
  });
  expect(d.query.mock.calls[0][1]).toEqual({ userId: 'owner' });
  expect(d.assertBudget.mock.calls[0][2]).toBe('jev_mail');
  await expect(resolveClassifierRuntime('owner', deps({ platformKey: () => undefined }))).rejects.toThrow(
    'not configured',
  );
  await expect(
    resolveClassifierRuntime(
      'owner',
      deps({
        assertBudget: () => {
          throw new Error('No budget');
        },
      }),
    ),
  ).rejects.toThrow('No budget');
});
test('BYOK requires the correct provider and honors existing eligibility rules', async () => {
  const d = deps({
    query: async () => ({
      settings: { mode: 'byok' },
      key: { provider: 'openrouter', encryptedKey: 'encrypted' },
    }),
  });
  expect(await resolveClassifierRuntime('owner', d)).toEqual({
    userId: 'owner',
    source: 'byok',
    apiKey: 'decrypted-key',
    model: JEV,
  });
  expect(d.decrypt).toHaveBeenCalledWith('encrypted');
  expect(d.assertBudget).not.toHaveBeenCalled();
  await expect(
    resolveClassifierRuntime('owner', { ...d, entitlement: async () => ({ plan: 'free' }) } as any),
  ).rejects.toThrow('eligible plan');
  expect(
    (
      await resolveClassifierRuntime('owner', {
        ...d,
        requiresOwnKey: () => true,
        entitlement: async () => ({ plan: 'free' }),
      } as any)
    ).source,
  ).toBe('byok');
  for (const key of [undefined, { provider: 'anthropic', encryptedKey: 'wrong' }])
    await expect(
      resolveClassifierRuntime(
        'owner',
        deps({ requiresOwnKey: () => true, query: async () => ({ settings: {}, key }) }),
      ),
    ).rejects.toThrow('OpenRouter key');
});
test('usage records the returned version, actual tokens and failures without email content', async () => {
  const record = mock(async (..._args: any[]) => undefined);
  await recordClassifierUsage(
    { userId: 'owner', source: 'byok' },
    'jev_search',
    { model: 'typesafe/jev-1.13-20260917', usage: { input_tokens: 1000, output_tokens: 302 } },
    record,
  );
  expect(record.mock.calls[0]).toEqual([
    {
      userId: 'owner',
      source: 'byok',
      provider: 'openrouter',
      modelName: 'typesafe/jev-1.13-20260917',
      model: undefined,
    },
    'jev_search',
    { inputTokens: 1000, outputTokens: 302 },
    true,
    undefined,
  ]);
  await recordClassifierUsage({ userId: 'owner', source: 'lab86' }, 'jev_mail', undefined, record);
  expect(record.mock.calls[1][3]).toBe(false);
  expect(record.mock.calls[1][4]).toBe('Classifier evaluation unavailable');
  expect(record.mock.calls[1][0].modelName).toBe('typesafe/jev-1.13');
  await recordClassifierUsage(
    { userId: 'owner', source: 'lab86', model: TEV1 },
    'jev_mail',
    { model: 'together/Tev1-4B-experimental', usage: { input_tokens: 10, output_tokens: 1 } },
    record,
  );
  expect(record.mock.calls[2][0]).toMatchObject({
    provider: 'together',
    modelName: 'together/Tev1-4B-experimental',
  });
  expect(
    estimateAiUsageCost({
      provider: 'together',
      model: 'together/Tev1-4B-experimental',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    }).estimatedCostUsd,
  ).toBe(0.042);
  expect(
    estimateAiUsageCost({
      provider: 'openrouter',
      model: 'typesafe/jev-1.13-20260917',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    }).estimatedCostUsd,
  ).toBe(0.042);
});

test('disabled personal keys use platform billing unless the deployment requires a personal key', async () => {
  const d = deps({
    query: async () => ({
      settings: { enabled: false, mode: 'byok' },
      key: { provider: 'openrouter', encryptedKey: 'encrypted' },
    }),
  });
  expect((await resolveClassifierRuntime('owner', d)).source).toBe('lab86');
  expect(d.decrypt).not.toHaveBeenCalled();
  expect(d.assertBudget).toHaveBeenCalled();
  expect((await resolveClassifierRuntime('owner', { ...d, requiresOwnKey: () => true })).source).toBe('byok');
});

test('the deployment-selected classifier picks its own platform credential', async () => {
  const d = deps({
    selectedClassifier: async () => TEV1,
    platformKey: mock((credential: string) =>
      credential === 'together' ? 'together-key' : 'openrouter-key',
    ),
  });
  expect(await resolveClassifierRuntime('owner', d)).toEqual({
    userId: 'owner',
    source: 'lab86',
    apiKey: 'together-key',
    model: TEV1,
  });
  expect(d.platformKey).toHaveBeenCalledWith('together');
  await expect(
    resolveClassifierRuntime('owner', deps({ selectedClassifier: async () => TEV1 })),
  ).rejects.toThrow('Tev1 4B (experimental) is not configured');
});

test('a personal OpenRouter key cannot run a classifier hosted elsewhere', async () => {
  const d = deps({
    selectedClassifier: async () => TEV1,
    query: async () => ({
      settings: { mode: 'byok' },
      key: { provider: 'openrouter', encryptedKey: 'encrypted' },
    }),
  });
  await expect(resolveClassifierRuntime('owner', d)).rejects.toThrow('not available with your own API key');
  expect(d.decrypt).not.toHaveBeenCalled();
});

test('OpenRouter utility calls keep OpenRouter credentials whichever classifier is selected', async () => {
  const d = deps({ selectedClassifier: async () => TEV1 });
  const runtime = await resolveOpenRouterUtilityRuntime('owner', d);
  expect(runtime.apiKey).toBe('platform-key');
  expect(runtime.model.credential).toBe('openrouter');
});

test('agent usage recording never throws when Convex is unavailable', async () => {
  const { recordAgentUsage } = await import('../lib/ai/gateway');
  const previous = { url: process.env.NEXT_PUBLIC_CONVEX_URL, alt: process.env.CONVEX_URL };
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.CONVEX_URL;
  try {
    const runtime = { userId: 'owner', source: 'lab86', provider: 'openrouter', modelName: 'openai/gpt-5.5' };
    await expect(
      recordAgentUsage(
        runtime as any,
        'agent',
        { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
        true,
      ),
    ).resolves.toBeUndefined();
    // A runtime with no user records nothing.
    await expect(
      recordAgentUsage({ ...runtime, userId: null } as any, 'agent', {}, false, 'x'),
    ).resolves.toBe(undefined);
  } finally {
    if (previous.url === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = previous.url;
    if (previous.alt === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = previous.alt;
  }
});
