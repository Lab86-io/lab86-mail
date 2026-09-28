import { describe, expect, mock, test } from 'bun:test';

// GET /api/ai/settings reads its collaborators from modules, so this file
// mocks them in a child process and keeps the mocks out of other test files.
if (process.env.AI_SETTINGS_USAGE_STATUS_TEST !== '1') {
  test('the settings usage status runs with isolated module fixtures', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, AI_SETTINGS_USAGE_STATUS_TEST: '1' },
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
  }, 20000);
} else {
  let entitlement: Record<string, unknown> = {};
  let creditsUsed = 0;
  let required = false;
  const auth = await import('../lib/auth/current-user');
  mock.module('../lib/auth/current-user', () => ({
    ...auth,
    requireCurrentUser: async () => ({ userId: 'user-1', email: 'test@example.test', source: 'clerk' }),
  }));
  const convex = await import('../lib/hosted/convex');
  mock.module('../lib/hosted/convex', () => ({
    ...convex,
    convexQuery: async () => ({ period: '2026-09', lab86Usage: { creditsUsed } }),
  }));
  const billing = await import('../lib/hosted/billing');
  mock.module('../lib/hosted/billing', () => ({
    ...billing,
    getAiBillingEntitlement: async () => entitlement,
  }));
  const controls = await import('../lib/hosted/controls');
  mock.module('../lib/hosted/controls', () => ({
    ...controls,
    isLab86AiDisabled: () => false,
    isSubscriptionServiceDisabled: () => false,
    isUserOpenRouterKeyRequired: () => required,
  }));
  const options = await import('../lib/ai/model-options');
  mock.module('../lib/ai/model-options', () => ({
    ...options,
    fetchOpenRouterCatalog: async () => ({ data: [], live: false }),
  }));
  const { GET } = await import('../app/api/ai/settings/route');
  const status = async () => ((await (await GET()).json()) as any).usage.status;

  describe('the usage status in Settings, Intelligence', () => {
    test('Pro has no credit limit: far over the old limit it stays available', async () => {
      entitlement = { plan: 'pro', status: 'active', source: 'clerk', monthlyCredits: 500, unlimited: true };
      creditsUsed = 50_000;
      expect(await status()).toBe('available');
    });

    test('a plan with a limit still shows reduced cost and exhausted', async () => {
      entitlement = {
        plan: 'admin',
        status: 'active',
        source: 'clerk',
        monthlyCredits: 500,
        unlimited: false,
      };
      creditsUsed = 450;
      expect(await status()).toBe('reduced_cost');
      creditsUsed = 500;
      expect(await status()).toBe('exhausted');
    });

    test('when hosted models are paused, Pro is not unlimited', async () => {
      required = true;
      entitlement = { plan: 'pro', status: 'active', source: 'clerk', monthlyCredits: 500, unlimited: true };
      creditsUsed = 0;
      expect(await status()).toBe('exhausted');
      required = false;
    });
  });
}
