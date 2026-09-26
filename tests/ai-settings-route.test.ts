import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createAiSettingsPost } from '../app/api/ai/settings/route';
import { buildModelCatalog } from '../lib/ai/model-catalog';
import { AuthRequiredError } from '../lib/auth/current-user';

function harness(provider: 'openrouter' | 'openai' | 'anthropic' = 'openrouter') {
  const writes: Array<{ name: string; args: any }> = [];
  const deps = {
    requireCurrentUser: async () => ({ userId: 'user-1', email: 'test@example.test', source: 'clerk' }),
    enforceUserRateLimit: async () => ({}),
    convexQuery: async () => ({
      settings: {
        mode: 'byok',
        provider,
        model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'openai/gpt-5.5',
      },
      key: { provider },
    }),
    convexMutation: async (name: any, args: any) => {
      writes.push({ name: getFunctionName(name), args });
    },
    loadModelCatalog: async ({ provider: selected }: any) => ({
      catalog: buildModelCatalog({ provider: selected }),
    }),
    getAiBillingEntitlement: async () => ({ plan: 'pro' }),
    isUserOpenRouterKeyRequired: () => false,
    encryptSecret: () => 'encrypted-fixture',
    secretFingerprint: () => 'fingerprint',
    maskFingerprint: () => 'masked',
  };
  const post = (body: unknown, overrides = {}) =>
    createAiSettingsPost({ ...deps, ...overrides } as any)(
      new NextRequest('http://localhost/api/ai/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  return { writes, post };
}

describe('AI settings persistence', () => {
  test('saving unrelated preferences migrates an old text-only choice to a compatible default', async () => {
    const h = harness();
    const response = await h.post(
      { mode: 'lab86' },
      {
        convexQuery: async () => ({
          settings: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v4-pro',
            fastModel: 'vendor/custom-fast',
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(buildModelCatalog().find((model) => model.id === saved.model)?.capabilities.vision).toBe(true);
    expect(buildModelCatalog().find((model) => model.id === saved.fastModel)?.capabilities.vision).toBe(true);
  });
  test('hosted mode persists verified vision models across providers', async () => {
    const h = harness();
    const response = await h.post({
      mode: 'lab86',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      fastModel: 'z-ai/glm-5.3-flash',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      fastModel: 'z-ai/glm-5.3-flash',
      unknown: false,
    });
    expect(h.writes.find((write) => write.name === 'ai:upsertSettings')?.args).toMatchObject({
      userId: 'user-1',
      model: 'anthropic/claude-sonnet-4.6',
    });
  });
  test('direct providers persist actual choices as vendor ids', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      const h = harness(provider);
      const model = provider === 'openai' ? 'openai/gpt-5.4' : 'anthropic/claude-opus-4.8';
      const response = await h.post({ mode: 'byok', provider, model });
      expect(response.status).toBe(200);
      expect((await response.json()).model).toBe(provider === 'openai' ? 'gpt-5.4' : 'claude-opus-4-8');
    }
  });
  test('native clients that omit model slots preserve a saved direct choice', async () => {
    const h = harness('anthropic');
    const response = await h.post({ mode: 'byok', provider: 'anthropic' });
    expect((await response.json()).model).toBe('claude-sonnet-4-6');
  });
  test('rejects missing provider keys, cross-vendor models, and malformed settings without writes', async () => {
    for (const body of [
      { mode: 'byok', provider: 'anthropic' },
      { mode: 'byok', provider: 'openai', model: 'anthropic/claude-sonnet-4.6', apiKey: 'fixture' },
      { mode: 'byok', provider: 'openrouter', model: 123 },
      { mode: 'lab86', model: 'malformed' },
      { mode: 'lab86', model: 'deepseek/deepseek-v4-pro' },
      { mode: 'lab86', fastModel: 'vendor/custom-fast' },
    ]) {
      const h = harness();
      expect((await h.post(body)).status).toBe(400);
      expect(h.writes).toEqual([]);
    }
  });
  test('keeps the authentication and entitlement gates', async () => {
    const h = harness();
    expect(
      (
        await h.post(
          {},
          {
            requireCurrentUser: async () => {
              throw new AuthRequiredError('Sign in required.');
            },
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await h.post(
          { mode: 'byok', provider: 'openrouter' },
          { getAiBillingEntitlement: async () => ({ plan: 'free' }) },
        )
      ).status,
    ).toBe(402);
    expect(h.writes).toEqual([]);
  });
});
