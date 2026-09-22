import { expect, mock, test } from 'bun:test';
import { estimateAiUsageCost } from '../lib/ai/budget';
import { recordJevUsage, resolveJevRuntime } from '../lib/ai/gateway';

function deps(extra: Record<string, unknown> = {}) {
  return {
    query: mock(async (..._args: any[]) => ({
      settings: { mode: 'lab86', normalModel: 'unrelated-generator' },
    })),
    requiresOwnKey: () => false,
    entitlement: async () => ({ plan: 'pro', monthlyCredits: 500, status: 'active' }),
    decrypt: mock(() => 'decrypted-key'),
    assertBudget: mock((..._args: any[]) => undefined),
    platformKey: () => 'platform-key',
    ...extra,
  } as any;
}
test('Jev runtime uses fixed provider billing, independent of generative model choices', async () => {
  const d = deps();
  expect(await resolveJevRuntime('owner', d)).toEqual({
    userId: 'owner',
    source: 'lab86',
    apiKey: 'platform-key',
  });
  expect(d.query.mock.calls[0][1]).toEqual({ userId: 'owner' });
  expect(d.assertBudget.mock.calls[0][2]).toBe('jev_mail');
  await expect(resolveJevRuntime('owner', deps({ platformKey: () => undefined }))).rejects.toThrow(
    'not configured',
  );
  await expect(
    resolveJevRuntime(
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
  expect(await resolveJevRuntime('owner', d)).toEqual({
    userId: 'owner',
    source: 'byok',
    apiKey: 'decrypted-key',
  });
  expect(d.decrypt).toHaveBeenCalledWith('encrypted');
  expect(d.assertBudget).not.toHaveBeenCalled();
  await expect(
    resolveJevRuntime('owner', { ...d, entitlement: async () => ({ plan: 'free' }) } as any),
  ).rejects.toThrow('eligible plan');
  expect(
    (
      await resolveJevRuntime('owner', {
        ...d,
        requiresOwnKey: () => true,
        entitlement: async () => ({ plan: 'free' }),
      } as any)
    ).source,
  ).toBe('byok');
  for (const key of [undefined, { provider: 'anthropic', encryptedKey: 'wrong' }])
    await expect(
      resolveJevRuntime(
        'owner',
        deps({ requiresOwnKey: () => true, query: async () => ({ settings: {}, key }) }),
      ),
    ).rejects.toThrow('OpenRouter key');
});
test('usage records the returned version, actual tokens and failures without email content', async () => {
  const record = mock(async (..._args: any[]) => undefined);
  await recordJevUsage(
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
  await recordJevUsage({ userId: 'owner', source: 'lab86' }, 'jev_mail', undefined, record);
  expect(record.mock.calls[1][3]).toBe(false);
  expect(record.mock.calls[1][4]).toBe('Jev evaluation unavailable');
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
  expect((await resolveJevRuntime('owner', d)).source).toBe('lab86');
  expect(d.decrypt).not.toHaveBeenCalled();
  expect(d.assertBudget).toHaveBeenCalled();
  expect((await resolveJevRuntime('owner', { ...d, requiresOwnKey: () => true })).source).toBe('byok');
});
