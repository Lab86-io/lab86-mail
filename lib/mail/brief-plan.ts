import { api, convexQuery } from '../hosted/convex';
import type { BriefPlanTier } from './brief-score';

// Resolves the plan tier that sizes the brief budget. The lookup reads the
// stored per-user entitlement, so it works from the cron path where no Clerk
// session exists. Unknown or missing plans default to `pro`.

export type EntitlementPlan = 'free' | 'byok' | 'pro' | 'admin';

export function briefTierForPlan(plan: string | null | undefined): BriefPlanTier {
  switch (plan) {
    case 'free':
      return 'free';
    case 'admin':
      return 'team';
    case 'byok':
    case 'pro':
      return 'pro';
    default:
      return 'pro';
  }
}

export async function resolveBriefPlanTier(
  userId: string | null | undefined,
  deps: {
    query?: (userId: string) => Promise<{ entitlement?: { plan?: string | null } | null } | null>;
  } = {},
): Promise<BriefPlanTier> {
  if (!userId) return 'pro';
  const query =
    deps.query ??
    ((id: string) =>
      convexQuery<{ entitlement?: { plan?: string | null } | null } | null>(api.ai.getRuntimeState, {
        userId: id,
      }));
  try {
    const state = await query(userId);
    const plan = state?.entitlement?.plan;
    if (!plan) return 'pro';
    return briefTierForPlan(plan);
  } catch {
    return 'pro';
  }
}
