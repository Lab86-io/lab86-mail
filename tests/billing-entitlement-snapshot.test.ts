import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { directModelIdFor, isTerminalAiError, resolveJevRuntime } from '../lib/ai/gateway';
import {
  ENTITLEMENT_SNAPSHOT_MAX_AGE_MS,
  entitlementFromSnapshot,
  getAiBillingEntitlement,
  resetEntitlementSnapshotCacheForTest,
} from '../lib/hosted/billing';

const NOW = 1_800_000_000_000;

function deps(session: { userId?: string | null; plans?: string[] } | null, snapshot: any = null) {
  const persist = mock(async (..._args: any[]) => undefined);
  const loadSnapshot = mock(async (_userId: string) => snapshot);
  return {
    persist,
    loadSnapshot,
    deps: {
      configured: () => true,
      now: () => NOW,
      persist,
      loadSnapshot,
      auth: async () =>
        session
          ? {
              userId: session.userId ?? null,
              has: ({ plan }: { plan?: string; feature?: string }) =>
                Boolean(plan && session.plans?.includes(plan)),
            }
          : null,
    },
  };
}

describe('billing entitlement snapshot', () => {
  beforeEach(() => resetEntitlementSnapshotCacheForTest());

  test('a signed-in request stores the plan it resolved from Clerk', async () => {
    const d = deps({ userId: 'user-1', plans: ['mail_byok'] });
    const entitlement = await getAiBillingEntitlement({}, d.deps);
    expect(entitlement).toMatchObject({ plan: 'byok', monthlyCredits: 0, source: 'clerk' });
    expect(d.persist).toHaveBeenCalledTimes(1);
    expect(d.persist.mock.calls[0][0]).toBe('user-1');
    expect(d.persist.mock.calls[0][1]).toMatchObject({ plan: 'byok' });
    // The same answer is not rewritten on every call.
    await getAiBillingEntitlement({ userId: 'user-1' }, d.deps);
    expect(d.persist).toHaveBeenCalledTimes(1);
  });

  test('a request with no session reads the stored snapshot by user id', async () => {
    // A signed-out Clerk object still has has(); it must not decide the plan.
    const d = deps(
      { userId: null, plans: [] },
      { plan: 'pro', status: 'active', monthlyCredits: 500, updatedAt: NOW - 1000 },
    );
    const entitlement = await getAiBillingEntitlement({ userId: 'user-1' }, d.deps);
    expect(entitlement).toEqual({ plan: 'pro', status: 'active', monthlyCredits: 500, source: 'snapshot' });
    expect(d.loadSnapshot).toHaveBeenCalledWith('user-1');
    expect(d.persist).not.toHaveBeenCalled();
  });

  test('a passed snapshot skips the lookup, and a session for another user does not answer', async () => {
    const d = deps({ userId: 'someone-else', plans: ['mail_pro'] });
    const entitlement = await getAiBillingEntitlement(
      { userId: 'user-1', snapshot: { plan: 'byok', status: 'active', monthlyCredits: 0, updatedAt: NOW } },
      d.deps,
    );
    expect(entitlement.plan).toBe('byok');
    expect(d.loadSnapshot).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  test('no session and no usable snapshot is the Free plan', async () => {
    const d = deps(null);
    expect((await getAiBillingEntitlement({}, d.deps)).plan).toBe('free');
    expect((await getAiBillingEntitlement({ userId: 'user-1', snapshot: null }, d.deps)).plan).toBe('free');
    expect(
      entitlementFromSnapshot(
        {
          plan: 'pro',
          status: 'active',
          monthlyCredits: 500,
          updatedAt: NOW - ENTITLEMENT_SNAPSHOT_MAX_AGE_MS - 1,
        },
        NOW,
      ),
    ).toBeNull();
    expect(entitlementFromSnapshot({ plan: 'pro', status: 'canceled', monthlyCredits: 500 }, NOW)).toBeNull();
    expect(entitlementFromSnapshot({ plan: 'gold', status: 'active' }, NOW)).toBeNull();
    expect(entitlementFromSnapshot({ plan: 'byok', status: 'trialing' }, NOW)).toMatchObject({
      plan: 'byok',
      monthlyCredits: 0,
    });
  });

  test('a failed snapshot write keeps the live answer', async () => {
    const d = deps({ userId: 'user-1', plans: ['mail_pro'] });
    d.deps.persist = mock(async () => {
      throw new Error('offline');
    });
    expect((await getAiBillingEntitlement({}, d.deps)).plan).toBe('pro');
  });

  test('Jev passes its user and stored snapshot to the plan check', async () => {
    const entitlement = mock(async (..._args: any[]) => ({
      plan: 'byok',
      status: 'active',
      monthlyCredits: 0,
    }));
    const snapshot = { plan: 'byok', status: 'active', monthlyCredits: 0 };
    const runtime = await resolveJevRuntime('user-1', {
      query: async () => ({
        settings: { mode: 'byok' },
        key: { provider: 'openrouter', encryptedKey: 'encrypted' },
        entitlement: snapshot,
      }),
      requiresOwnKey: () => false,
      entitlement,
      decrypt: () => 'key',
      assertBudget: () => undefined,
      platformKey: () => 'platform',
    } as any);
    expect(runtime.source).toBe('byok');
    expect(entitlement.mock.calls[0][0]).toEqual({ userId: 'user-1', snapshot });
  });
});

describe('gateway helpers', () => {
  test('direct Anthropic ids come from the catalog directId', () => {
    expect(directModelIdFor('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(directModelIdFor('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(directModelIdFor('anthropic/claude-future-9.1')).toBe('claude-future-9-1');
    expect(directModelIdFor('openai/gpt-5.5')).toBe('gpt-5.5');
    expect(directModelIdFor('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  test('access, key, and credit failures are terminal; outages are not', () => {
    const access = new Error('plan');
    access.name = 'AiAccessError';
    expect(isTerminalAiError(access)).toBe(true);
    for (const statusCode of [401, 402, 403]) expect(isTerminalAiError({ statusCode })).toBe(true);
    expect(isTerminalAiError({ name: 'AI_RetryError', lastError: { statusCode: 402 } })).toBe(true);
    expect(isTerminalAiError({ cause: { status: 401 } })).toBe(true);
    for (const statusCode of [429, 500, 503]) expect(isTerminalAiError({ statusCode })).toBe(false);
    expect(isTerminalAiError(new Error('network'))).toBe(false);
    expect(isTerminalAiError(null)).toBe(false);
  });
});
