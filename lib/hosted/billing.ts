import { auth } from '@clerk/nextjs/server';
import { api, convexMutation, convexQuery } from './convex';
import { aiCreditDefaults, isClerkConfigured, isConvexConfigured } from './env';
import { TRIAL_DAYS } from './plans';

export type AiBillingPlan = 'free' | 'byok' | 'pro' | 'admin';

export interface AiBillingEntitlement {
  plan: AiBillingPlan;
  status: 'active';
  monthlyCredits: number;
  // 'clerk' is a live read of the signed-in session. 'snapshot' is the stored
  // copy that background work (brief jobs, Jev, narrative) reads by userId.
  source: 'clerk' | 'snapshot';
  /** Set while the app-level trial, not a subscription, gives this Pro plan. */
  trialEndsAt?: number;
}

/** The stored per-user entitlement row (`aiEntitlements`), as read by background work. */
export interface StoredEntitlementSnapshot {
  plan?: string | null;
  status?: string | null;
  monthlyCredits?: number | null;
  updatedAt?: number | null;
  /** The one Pro trial this user gets. Set once; never cleared. */
  trialStartedAt?: number | null;
  trialEndsAt?: number | null;
}

export interface TrialGrant {
  granted: boolean;
  trialStartedAt: number | null;
  trialEndsAt: number | null;
}

// Each signed-in request that resolves billing refreshes the stored snapshot.
// A snapshot that no signed-in request refreshed for this long no longer
// proves a paid plan: a canceled subscription must not fund background work
// forever.
export const ENTITLEMENT_SNAPSHOT_MAX_AGE_MS = 45 * 86_400_000;
// The snapshot is rewritten when the plan changes, and otherwise at most this
// often for each user, so an AI call does not always pay for a mutation.
const SNAPSHOT_REFRESH_MS = 6 * 3600_000;
const PLANS = new Set<AiBillingPlan>(['free', 'byok', 'pro', 'admin']);

type HasCheck = (params: { plan?: string; feature?: string }) => boolean | Promise<boolean>;

const billingDefaults = {
  configured: isClerkConfigured,
  auth: async (): Promise<{ userId?: string | null; has?: HasCheck } | null> =>
    (await auth()) as unknown as { userId?: string | null; has?: HasCheck },
  loadSnapshot: async (userId: string): Promise<StoredEntitlementSnapshot | null> => {
    if (!isConvexConfigured()) return null;
    const state = await convexQuery<{ entitlement?: StoredEntitlementSnapshot | null } | null>(
      api.ai.getRuntimeState,
      { userId },
    );
    return state?.entitlement ?? null;
  },
  persist: async (userId: string, entitlement: AiBillingEntitlement) => {
    if (!isConvexConfigured()) return;
    await convexMutation(api.ai.upsertEntitlement, {
      userId,
      plan: entitlement.plan,
      status: entitlement.trialEndsAt ? 'trialing' : 'active',
      source: 'clerk',
      monthlyCredits: entitlement.monthlyCredits,
    });
  },
  // Idempotent on the server: a user who already had a trial gets the same
  // dates back, and a user who had Pro before gets none.
  grantTrial: async (
    userId: string,
    input: { days: number; monthlyCredits: number },
  ): Promise<TrialGrant> => {
    if (!isConvexConfigured()) return { granted: false, trialStartedAt: null, trialEndsAt: null };
    return convexMutation<TrialGrant>((api as any).ai.grantTrial, { userId, ...input });
  },
  now: () => Date.now(),
};
export type BillingDependencies = typeof billingDefaults;

const lastWritten = new Map<string, { key: string; at: number }>();

/** Test hook: forget which snapshots this process already wrote. */
export function resetEntitlementSnapshotCacheForTest() {
  lastWritten.clear();
}

/**
 * The AI plan for a user.
 *
 * A signed-in request reads the plan from the Clerk session and stores it as
 * the user's snapshot. A request with no session (cron, brief jobs, `after()`
 * work) reads that stored snapshot by `userId`. Without either, the plan is
 * Free.
 *
 * `snapshot` lets a caller that already read `api.ai.getRuntimeState` pass the
 * stored row; `null` means "known to be absent".
 */
export async function getAiBillingEntitlement(
  options: { userId?: string | null; snapshot?: StoredEntitlementSnapshot | null } = {},
  deps: Partial<BillingDependencies> = {},
): Promise<AiBillingEntitlement> {
  const d = { ...billingDefaults, ...deps };
  const defaults = aiCreditDefaults();
  if (!d.configured()) {
    throw new Error('Clerk is not configured. Hosted billing requires Clerk.');
  }

  // auth() resolves to Clerk's Auth object, which exposes has() for plan and
  // feature checks. A signed-out object also has has(), which always answers
  // false, so the session user id decides whether the answer is real.
  const authObject = await d.auth().catch(() => null);
  const sessionUserId = authObject?.userId || null;
  const has = authObject?.has;
  const target = options.userId || null;
  if (sessionUserId && typeof has === 'function' && (!target || target === sessionUserId)) {
    let entitlement = await entitlementFromClerk(has, defaults);
    if (entitlement.plan === 'free') entitlement = await withTrial(sessionUserId, entitlement, options, d);
    await rememberEntitlement(sessionUserId, entitlement, d);
    return entitlement;
  }

  if (target) {
    const snapshot =
      options.snapshot !== undefined ? options.snapshot : await d.loadSnapshot(target).catch(() => null);
    const stored = entitlementFromSnapshot(snapshot, d.now(), defaults);
    if (stored) return stored;
  }
  return freeEntitlement(defaults.freeMonthlyCredits);
}

/**
 * A user whose subscription is Free gets Pro while the one app-level trial
 * runs. The first signed-in request of a user who never had a trial (and
 * never had Pro) grants it: new accounts and existing Free users alike.
 */
async function withTrial(
  userId: string,
  free: AiBillingEntitlement,
  options: { snapshot?: StoredEntitlementSnapshot | null },
  d: BillingDependencies,
): Promise<AiBillingEntitlement> {
  const defaults = aiCreditDefaults();
  const snapshot =
    options.snapshot !== undefined ? options.snapshot : await d.loadSnapshot(userId).catch(() => undefined);
  // An unreadable row proves nothing: never grant blind.
  if (snapshot === undefined) return free;
  let endsAt = finite(snapshot?.trialEndsAt);
  if (!finite(snapshot?.trialStartedAt) && trialEligible(snapshot)) {
    const grant = await d
      .grantTrial(userId, { days: TRIAL_DAYS, monthlyCredits: defaults.proMonthlyCredits })
      .catch((err) => {
        console.warn('[billing] could not grant the trial:', err instanceof Error ? err.name : err);
        return null;
      });
    endsAt = finite(grant?.trialEndsAt);
  }
  if (endsAt === null || endsAt <= d.now()) return free;
  return {
    plan: 'pro',
    status: 'active',
    monthlyCredits: defaults.proMonthlyCredits,
    source: 'clerk',
    trialEndsAt: endsAt,
  };
}

/** A user who had Pro or admin before does not get a trial. */
export function trialEligible(snapshot: StoredEntitlementSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  if (finite(snapshot.trialStartedAt) !== null) return false;
  return snapshot.plan !== 'pro' && snapshot.plan !== 'admin';
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** A stored snapshot as an entitlement, or null when it proves nothing. */
export function entitlementFromSnapshot(
  snapshot: StoredEntitlementSnapshot | null | undefined,
  now: number,
  defaults = aiCreditDefaults(),
): AiBillingEntitlement | null {
  if (!snapshot) return null;
  const plan = snapshot.plan as AiBillingPlan;
  if (!PLANS.has(plan)) return null;
  if (snapshot.status !== 'active' && snapshot.status !== 'trialing') return null;
  const updatedAt = Number(snapshot.updatedAt);
  if (Number.isFinite(updatedAt) && now - updatedAt > ENTITLEMENT_SNAPSHOT_MAX_AGE_MS) return null;
  // A trial proves Pro only until it ends; after that the user is Free until a
  // signed-in request stores the next plan.
  const trialEndsAt = finite(snapshot.trialEndsAt);
  const trialing = snapshot.status === 'trialing' && trialEndsAt !== null;
  if (trialing && trialEndsAt <= now) return null;
  const credits = Number(snapshot.monthlyCredits);
  return {
    plan,
    status: 'active',
    monthlyCredits: Number.isFinite(credits)
      ? credits
      : plan === 'free'
        ? defaults.freeMonthlyCredits
        : plan === 'byok'
          ? 0
          : defaults.proMonthlyCredits,
    source: 'snapshot',
    ...(trialing ? { trialEndsAt } : {}),
  };
}

async function rememberEntitlement(
  userId: string,
  entitlement: AiBillingEntitlement,
  deps: Pick<BillingDependencies, 'persist' | 'now'>,
) {
  // The status is part of the key: paying during a trial must store 'active'
  // at once, or background work would read a lapsed trial as Free.
  const key = `${entitlement.plan}:${entitlement.monthlyCredits}:${entitlement.trialEndsAt ?? 'paid'}`;
  const now = deps.now();
  const previous = lastWritten.get(userId);
  if (previous && previous.key === key && now - previous.at < SNAPSHOT_REFRESH_MS) return;
  try {
    await deps.persist(userId, entitlement);
    lastWritten.set(userId, { key, at: now });
  } catch (err) {
    // The live answer still stands; the next signed-in request retries the write.
    console.warn(
      '[billing] could not store the entitlement snapshot:',
      err instanceof Error ? err.name : err,
    );
  }
}

async function entitlementFromClerk(
  has: HasCheck,
  defaults: ReturnType<typeof aiCreditDefaults>,
): Promise<AiBillingEntitlement> {
  const admin = await Promise.resolve(has({ plan: process.env.CLERK_ADMIN_PLAN_SLUG || 'admin' })).catch(
    () => false,
  );
  if (admin) {
    const rawAdminMonthlyCredits = process.env.LAB86_AI_ADMIN_MONTHLY_CREDITS;
    const adminMonthlyCredits = Number(rawAdminMonthlyCredits);
    return {
      plan: 'admin',
      status: 'active',
      monthlyCredits:
        rawAdminMonthlyCredits && Number.isFinite(adminMonthlyCredits)
          ? adminMonthlyCredits
          : defaults.proMonthlyCredits,
      source: 'clerk',
    };
  }

  const proPlan = process.env.CLERK_PRO_PLAN_SLUG || 'mail_pro';
  const proFeature = process.env.CLERK_PRO_AI_FEATURE_SLUG || 'b2c_mail';
  const pro = await Promise.resolve(has({ plan: proPlan })).catch(() => false);
  const proFeatureAccess = await Promise.resolve(has({ feature: proFeature })).catch(() => false);
  if (pro || proFeatureAccess) {
    return {
      plan: 'pro',
      status: 'active',
      monthlyCredits: defaults.proMonthlyCredits,
      source: 'clerk',
    };
  }

  // BYOK tier: full feature set with the subscriber's own model key — no
  // Lab86-hosted AI budget.
  const byokPlan = process.env.CLERK_BYOK_PLAN_SLUG || 'mail_byok';
  const byok = await Promise.resolve(has({ plan: byokPlan })).catch(() => false);
  if (byok) {
    return { plan: 'byok', status: 'active', monthlyCredits: 0, source: 'clerk' };
  }

  return freeEntitlement(defaults.freeMonthlyCredits);
}

export function clerkBillingCheckoutUrl() {
  return process.env.CLERK_BILLING_CHECKOUT_URL || process.env.NEXT_PUBLIC_CLERK_BILLING_CHECKOUT_URL || '';
}

export function clerkBillingPortalUrl() {
  return process.env.CLERK_BILLING_PORTAL_URL || process.env.NEXT_PUBLIC_CLERK_BILLING_PORTAL_URL || '';
}

function freeEntitlement(monthlyCredits: number): AiBillingEntitlement {
  return { plan: 'free', status: 'active', monthlyCredits, source: 'clerk' };
}
