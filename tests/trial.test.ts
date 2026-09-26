import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { createBillingPlanGet } from '../app/api/billing/plan/route';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  entitlementFromSnapshot,
  getAiBillingEntitlement,
  resetEntitlementSnapshotCacheForTest,
  trialEligible,
} from '../lib/hosted/billing';
import { billingPlanView, DAY_MS, TRIAL_DAYS } from '../lib/hosted/plans';
import { billingSummary } from '../lib/shell/billing-plan';

const NOW = 1_800_000_000_000;

function deps(plans: string[], snapshot: any, grant: any = null) {
  const persist = mock(async (..._args: any[]) => undefined);
  const loadSnapshot = mock(async (_userId: string) => snapshot);
  const grantTrial = mock(async (..._args: any[]) => grant);
  return {
    persist,
    loadSnapshot,
    grantTrial,
    deps: {
      configured: () => true,
      now: () => NOW,
      persist,
      loadSnapshot,
      grantTrial,
      auth: async () => ({
        userId: 'user-1',
        has: ({ plan }: { plan?: string; feature?: string }) => Boolean(plan && plans.includes(plan)),
      }),
    },
  };
}

describe('the 14-day trial', () => {
  beforeEach(() => resetEntitlementSnapshotCacheForTest());

  test('a Free user who never had a trial gets 14 days of Pro, stored as trialing', async () => {
    const endsAt = NOW + TRIAL_DAYS * DAY_MS;
    const d = deps([], null, { granted: true, trialStartedAt: NOW, trialEndsAt: endsAt });
    const entitlement = await getAiBillingEntitlement({}, d.deps);
    expect(entitlement).toMatchObject({ plan: 'pro', monthlyCredits: 500, trialEndsAt: endsAt });
    expect(d.grantTrial).toHaveBeenCalledWith('user-1', { days: 14, monthlyCredits: 500 });
    expect(d.persist.mock.calls[0][1]).toMatchObject({ plan: 'pro', trialEndsAt: endsAt });
  });

  test('a running trial gives Pro without a new grant; an ended one gives Free', async () => {
    const running = deps([], {
      plan: 'pro',
      status: 'trialing',
      trialStartedAt: NOW - DAY_MS,
      trialEndsAt: NOW + DAY_MS,
    });
    expect((await getAiBillingEntitlement({}, running.deps)).plan).toBe('pro');
    expect(running.grantTrial).not.toHaveBeenCalled();
    resetEntitlementSnapshotCacheForTest();
    const ended = deps([], {
      plan: 'pro',
      status: 'trialing',
      trialStartedAt: NOW - 20 * DAY_MS,
      trialEndsAt: NOW - 1,
    });
    const free = await getAiBillingEntitlement({}, ended.deps);
    expect(free).toMatchObject({ plan: 'free' });
    expect(free.trialEndsAt).toBeUndefined();
    expect(ended.grantTrial).not.toHaveBeenCalled();
  });

  test('a passed snapshot skips the read; an unreadable row never grants', async () => {
    const passed = deps([], 'unused');
    await getAiBillingEntitlement(
      { snapshot: { plan: 'free', status: 'active', trialStartedAt: 1, trialEndsAt: 2 } },
      passed.deps,
    );
    expect(passed.loadSnapshot).not.toHaveBeenCalled();
    resetEntitlementSnapshotCacheForTest();
    const failing = deps([], null);
    failing.deps.loadSnapshot = mock(async () => {
      throw new Error('offline');
    });
    expect((await getAiBillingEntitlement({}, failing.deps)).plan).toBe('free');
    expect(failing.grantTrial).not.toHaveBeenCalled();
  });

  test('a failed grant leaves the user on Free', async () => {
    const d = deps([], null);
    d.deps.grantTrial = mock(async () => {
      throw new Error('offline');
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect((await getAiBillingEntitlement({}, d.deps)).plan).toBe('free');
    } finally {
      console.warn = warn;
    }
  });

  test('paid subscribers and former Pro users get no trial', async () => {
    const paying = deps(['mail_pro'], null);
    expect((await getAiBillingEntitlement({}, paying.deps)).trialEndsAt).toBeUndefined();
    expect(paying.grantTrial).not.toHaveBeenCalled();
    expect(trialEligible(null)).toBe(true);
    expect(trialEligible({ plan: 'free', status: 'active' })).toBe(true);
    expect(trialEligible({ plan: 'byok', status: 'active' })).toBe(true);
    expect(trialEligible({ plan: 'pro', status: 'active' })).toBe(false);
    expect(trialEligible({ plan: 'admin', status: 'active' })).toBe(false);
    expect(trialEligible({ plan: 'free', status: 'active', trialStartedAt: 5 })).toBe(false);
  });

  test('paying during a trial stores the paid plan at once', async () => {
    const d = deps([], { plan: 'pro', status: 'trialing', trialStartedAt: NOW, trialEndsAt: NOW + DAY_MS });
    await getAiBillingEntitlement({}, d.deps);
    const paid = {
      ...d.deps,
      auth: async () => ({ userId: 'user-1', has: ({ plan }: any) => plan === 'mail_pro' }),
    };
    await getAiBillingEntitlement({}, paid);
    expect(d.persist).toHaveBeenCalledTimes(2);
    expect(d.persist.mock.calls[1][1].trialEndsAt).toBeUndefined();
  });

  test('background work reads a trial only until it ends', () => {
    const snapshot = { plan: 'pro', status: 'trialing', monthlyCredits: 500, trialEndsAt: NOW + 1000 };
    expect(entitlementFromSnapshot(snapshot, NOW)).toMatchObject({ plan: 'pro', trialEndsAt: NOW + 1000 });
    expect(entitlementFromSnapshot(snapshot, NOW + 1000)).toBeNull();
    // A paid row keeps its history fields but is not a trial.
    expect(
      entitlementFromSnapshot(
        { plan: 'pro', status: 'active', monthlyCredits: 500, trialEndsAt: NOW - 5 },
        NOW,
      ),
    ).toEqual({ plan: 'pro', status: 'active', monthlyCredits: 500, source: 'snapshot' });
  });
});

describe('what the user sees', () => {
  test('the plan view names the trial and notes the last five days', () => {
    const early = billingPlanView({ plan: 'pro', trialEndsAt: NOW + 10 * DAY_MS }, NOW);
    expect(early).toMatchObject({ plan: 'pro', planName: 'Pro trial', note: null, trialDays: 14 });
    expect(early.trial).toMatchObject({ active: true, daysLeft: 10 });
    expect(early.prices.byok).toEqual({
      name: 'Own key',
      monthlyUsd: 12,
      annualUsd: 50.4,
      line: '$12/month or $50.40/year',
    });
    const late = billingPlanView({ plan: 'pro', trialEndsAt: NOW + 2 * DAY_MS }, NOW);
    expect(late.note).toBe('2 days left in your Pro trial. After that, your account moves to Free.');
    expect(billingPlanView({ plan: 'pro' }, NOW).planName).toBe('Pro');
    expect(billingPlanView({ plan: 'byok', trialEndsAt: NOW + DAY_MS }, NOW).trial.active).toBe(false);
    expect(billingPlanView({ plan: 'admin' }, NOW).planName).toBe('Admin');
    expect(billingPlanView({ plan: 'gold' }, NOW)).toMatchObject({ plan: 'free', planName: 'Free' });
  });

  test('Settings shows the trial with days left, and Upgrade instead of Manage', () => {
    expect(billingSummary({ plan: 'pro', trialEndsAt: NOW + 3 * DAY_MS, now: NOW })).toEqual({
      line: 'Plan: Pro trial, 3 days left. No card is on file. After the trial, your account moves to Free.',
      planLabel: 'Pro trial',
      showUpgrade: true,
      showManage: false,
    });
    expect(billingSummary({ plan: 'pro', trialEndsAt: NOW + 1, now: NOW }).line).toContain('1 day left');
    expect(billingSummary({ plan: 'pro', trialEndsAt: NOW - 1, now: NOW }).line).toBe('Plan: Pro.');
  });

  test('the plan route returns the view, and asks for sign-in', async () => {
    const get = createBillingPlanGet({
      requireCurrentUser: async () => ({ userId: 'u', email: '', name: '', source: 'clerk' }),
      getAiBillingEntitlement: async () =>
        ({
          plan: 'pro',
          status: 'active',
          monthlyCredits: 500,
          source: 'clerk',
          trialEndsAt: NOW + DAY_MS,
        }) as any,
      isSubscriptionServiceDisabled: () => false,
      now: () => NOW,
    });
    expect(await (await get()).json()).toMatchObject({
      ok: true,
      planName: 'Pro trial',
      note: '1 day left in your Pro trial. After that, your account moves to Free.',
      subscriptionsDisabled: false,
    });
    const { AuthRequiredError } = await import('../lib/auth/current-user');
    const signedOut = createBillingPlanGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError();
      },
    });
    expect((await signedOut()).status).toBe(401);
    const error = console.error;
    console.error = () => undefined;
    try {
      const broken = createBillingPlanGet({
        requireCurrentUser: async () => ({ userId: 'u', email: '', name: '', source: 'clerk' }),
        getAiBillingEntitlement: async () => {
          throw new Error('clerk down');
        },
      });
      expect((await broken()).status).toBe(500);
    } finally {
      console.error = error;
    }
  });
});

describe('Convex trial grant', () => {
  const SECRET = 'trial-secret';
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });
  const harness = () =>
    convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/ai.ts': () => import('../convex/ai'),
    });

  test('the first grant starts the trial and later grants return the same dates', async () => {
    const t = harness();
    const first = await t.mutation(api.ai.grantTrial, {
      internalSecret: SECRET,
      userId: 'u1',
      days: 14,
      monthlyCredits: 500,
    });
    expect(first.granted).toBe(true);
    expect(first.trialEndsAt! - first.trialStartedAt!).toBe(14 * DAY_MS);
    const again = await t.mutation(api.ai.grantTrial, {
      internalSecret: SECRET,
      userId: 'u1',
      days: 14,
      monthlyCredits: 500,
    });
    expect(again).toEqual({
      granted: false,
      trialStartedAt: first.trialStartedAt,
      trialEndsAt: first.trialEndsAt,
    });
    const state = await t.query(api.ai.getRuntimeState, { internalSecret: SECRET, userId: 'u1' });
    expect(state.entitlement).toMatchObject({ plan: 'pro', status: 'trialing', monthlyCredits: 500 });
    // The stored plan write keeps the trial dates.
    await t.mutation(api.ai.upsertEntitlement, {
      internalSecret: SECRET,
      userId: 'u1',
      plan: 'free',
      status: 'active',
      source: 'clerk',
      monthlyCredits: 0,
    });
    const after = await t.query(api.ai.getRuntimeState, { internalSecret: SECRET, userId: 'u1' });
    expect(after.entitlement?.trialStartedAt).toBe(first.trialStartedAt);
  });

  test('a former Pro user gets none, and a Free row is upgraded in place', async () => {
    const t = harness();
    for (const [userId, plan] of [
      ['paid', 'pro'],
      ['free', 'free'],
    ] as const)
      await t.mutation(api.ai.upsertEntitlement, {
        internalSecret: SECRET,
        userId,
        plan,
        status: 'active',
        source: 'clerk',
        monthlyCredits: 0,
      });
    expect(
      await t.mutation(api.ai.grantTrial, {
        internalSecret: SECRET,
        userId: 'paid',
        days: 14,
        monthlyCredits: 500,
      }),
    ).toEqual({ granted: false, trialStartedAt: null, trialEndsAt: null });
    const granted = await t.mutation(api.ai.grantTrial, {
      internalSecret: SECRET,
      userId: 'free',
      days: 400,
      monthlyCredits: 500,
    });
    // The server caps the length.
    expect(granted.trialEndsAt! - granted.trialStartedAt!).toBe(30 * DAY_MS);
    await expect(
      t.mutation(api.ai.grantTrial, { internalSecret: 'wrong', userId: 'x', days: 14, monthlyCredits: 1 }),
    ).rejects.toThrow();
  });
});
