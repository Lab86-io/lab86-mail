import { describe, expect, mock, test } from 'bun:test';

if (process.env.CHAT_RUNTIME_SELECTION_TEST !== '1') {
  test('runtime provider selection runs with isolated provider fixtures', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHAT_RUNTIME_SELECTION_TEST: '1',
        LAB86_MAIL_OPENAI_MODEL: 'z-ai/glm-5.3-flash',
        LAB86_MAIL_OPENAI_FAST_MODEL: 'z-ai/glm-5.3-flash',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 10000);
} else {
  let state: any;
  let required = false;
  const model = (id: string) => ({ modelId: id });
  mock.module('../lib/ai/client', () => ({
    openrouter: { chat: model },
    openai: Object.assign(model, { chat: model }),
    anthropic: model,
  }));
  mock.module('../lib/hosted/convex', () => ({
    api: { ai: { getRuntimeState: 'state' } },
    convexQuery: async () => state,
    convexMutation: async () => ({}),
  }));
  const billingCalls: any[] = [];
  mock.module('../lib/hosted/billing', () => ({
    getAiBillingEntitlement: async (options?: unknown) => {
      billingCalls.push(options);
      return { plan: 'pro', status: 'active', monthlyCredits: 100000 };
    },
  }));
  const controls = await import('../lib/hosted/controls');
  mock.module('../lib/hosted/controls', () => ({
    ...controls,
    isLab86AiDisabled: () => false,
    isUserOpenRouterKeyRequired: () => required,
  }));
  mock.module('../lib/security/crypto', () => ({ decryptSecret: () => 'fixture-key' }));
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'openai/gpt-5.5' },
          { id: 'openai/gpt-5-nano' },
          { id: 'openai/gpt-5.4-mini' },
          { id: 'anthropic/claude-sonnet-4.6' },
          { id: 'anthropic/claude-haiku-4.5' },
        ],
      }),
    )) as typeof fetch;
  const { resolveAiRuntime } = await import('../lib/ai/gateway');
  describe('actual runtime state resolution', () => {
    test('a direct OpenAI key uses native defaults when hosted defaults are GLM', async () => {
      const { defaultModelsFor } = await import('../lib/ai/model-catalog');
      const { toDirectModelId } = await import('../lib/ai/model-router');
      state = {
        settings: { enabled: true, mode: 'byok', provider: 'openai' },
        key: { provider: 'openai', encryptedKey: 'fixture' },
      };
      for (const speed of ['primary', 'fast'] as const) {
        const result = await resolveAiRuntime({ userId: 'fixture-user', speed, feature: 'agent' });
        const expected = toDirectModelId(defaultModelsFor('openai')[speed === 'primary' ? 'normal' : 'fast']);
        expect(result).toMatchObject({ source: 'byok', provider: 'openai', modelName: expected });
        expect(result.model.modelId).toBe(expected);
        expect(result.modelName).not.toContain('glm');
      }
    });
    for (const provider of ['openrouter', 'openai', 'anthropic'] as const) {
      test(`honors both saved slots with a ${provider} key`, async () => {
        const anthropic = provider === 'anthropic';
        state = {
          settings: {
            enabled: true,
            mode: 'byok',
            provider,
            model: anthropic ? 'anthropic/claude-sonnet-4.6' : 'openai/gpt-5.5',
            fastModel: anthropic ? 'anthropic/claude-haiku-4.5' : 'openai/gpt-5.4-mini',
          },
          key: { provider, encryptedKey: 'fixture' },
        };
        for (const speed of ['primary', 'fast'] as const) {
          const result = await resolveAiRuntime({ userId: 'fixture-user', speed, feature: 'agent' });
          const expected =
            provider === 'openrouter'
              ? state.settings[speed === 'primary' ? 'model' : 'fastModel']
              : anthropic
                ? speed === 'primary'
                  ? 'claude-sonnet-4-6'
                  : 'claude-haiku-4-5'
                : speed === 'primary'
                  ? 'gpt-5.5'
                  : 'gpt-5.4-mini';
          expect(result).toMatchObject({ source: 'byok', provider, modelName: expected });
          expect(result.model.modelId).toBe(expected);
        }
      });
    }
    test('hosted mode honors a selected vendor and migrates retired saved ids', async () => {
      state = {
        settings: {
          enabled: true,
          mode: 'lab86',
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4.6',
          fastModel: 'openai/gpt-5.1-chat',
        },
        lab86Usage: { creditsUsed: 0 },
      };
      const normal = await resolveAiRuntime({ userId: 'fixture-user', speed: 'primary', feature: 'agent' });
      expect(normal.modelName).toBe('anthropic/claude-sonnet-4.6');
      expect(normal.model.modelId).toBe(normal.modelName);
      const fast = await resolveAiRuntime({ userId: 'fixture-user', speed: 'fast', feature: 'agent' });
      expect(fast.modelName).toBe('openai/gpt-5.5');
    });
    test('a background BYOK call reads the stored plan snapshot for its user', async () => {
      const entitlement = { plan: 'byok', status: 'active', monthlyCredits: 0, updatedAt: 1 };
      state = {
        settings: { enabled: true, mode: 'byok', provider: 'openrouter' },
        key: { provider: 'openrouter', encryptedKey: 'fixture' },
        entitlement,
      };
      billingCalls.length = 0;
      await resolveAiRuntime({ userId: 'fixture-user', speed: 'primary', feature: 'daily_brief_layout' });
      expect(billingCalls).toEqual([{ userId: 'fixture-user', snapshot: entitlement }]);
      state = { settings: { enabled: true, mode: 'lab86' }, lab86Usage: { creditsUsed: 0 } };
      billingCalls.length = 0;
      await resolveAiRuntime({ userId: 'fixture-user', speed: 'primary', feature: 'daily_brief_layout' });
      expect(billingCalls).toEqual([{ userId: 'fixture-user', snapshot: null }]);
    });
    test('required OpenRouter mode uses the key route despite stale direct-provider settings', async () => {
      required = true;
      state = {
        settings: { enabled: true, mode: 'byok', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        key: { provider: 'openrouter', encryptedKey: 'fixture' },
      };
      expect(
        (await resolveAiRuntime({ userId: 'fixture-user', speed: 'primary', feature: 'agent' })).modelName,
      ).toBe('anthropic/claude-sonnet-4.6');
    });
  });
}
