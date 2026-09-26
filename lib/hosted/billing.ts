import { auth } from '@clerk/nextjs/server';
import { api, convexMutation, convexQuery } from './convex';
import { aiCreditDefaults, isClerkConfigured, isConvexConfigured } from './env';

export type AiBillingPlan = 'free' | 'byok' | 'pro' | 'admin';

export interface AiBillingEntitlement {
  plan: AiBillingPlan;
  status: 'active';
  monthlyCredits: number;
  // 'clerk' is a live read of the signed-in session. 'snapshot' is the stored
  // copy that background work (brief jobs, Jev, narrative) reads by userId.
  source: 'clerk' | 'snapshot';
}

/** The stored per-user entitlement row (`aiEntitlements`), as read by background work. */
export interface StoredEntitlementSnapshot {
  plan?: string | null;
  status?: string | null;
  monthlyCredits?: number | null;
  updatedAt?: number | null;
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
      status: 'active',
      source: 'clerk',
      monthlyCredits: entitlement.monthlyCredits,
    });
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
    const entitlement = await entitlementFromClerk(has, defaults);
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
  };
}

async function rememberEntitlement(
  userId: string,
  entitlement: AiBillingEntitlement,
  deps: Pick<BillingDependencies, 'persist' | 'now'>,
) {
  const key = `${entitlement.plan}:${entitlement.monthlyCredits}`;
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
