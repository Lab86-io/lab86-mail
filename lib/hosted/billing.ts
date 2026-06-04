import { auth } from '@clerk/nextjs/server';
import { aiCreditDefaults, isClerkConfigured } from './env';

export interface AiBillingEntitlement {
  plan: 'free' | 'pro' | 'admin';
  status: 'active';
  monthlyCredits: number;
  source: 'clerk' | 'fallback';
}

export async function getAiBillingEntitlement(): Promise<AiBillingEntitlement> {
  const defaults = aiCreditDefaults();
  if (!isClerkConfigured()) return freeEntitlement(defaults.freeMonthlyCredits);

  const session = await auth().catch(() => null);
  const has = (session as any)?.has;
  if (typeof has !== 'function') return freeEntitlement(defaults.freeMonthlyCredits);

  const admin = await Promise.resolve(has({ plan: process.env.CLERK_ADMIN_PLAN_SLUG || 'admin' })).catch(
    () => false,
  );
  if (admin) {
    return {
      plan: 'admin',
      status: 'active',
      monthlyCredits: Number(process.env.LAB86_AI_ADMIN_MONTHLY_CREDITS || defaults.proMonthlyCredits),
      source: 'clerk',
    };
  }

  const proPlan = process.env.CLERK_PRO_PLAN_SLUG || 'pro';
  const proFeature = process.env.CLERK_PRO_AI_FEATURE_SLUG || 'ai_credits_2m';
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

  return freeEntitlement(defaults.freeMonthlyCredits);
}

export function clerkBillingCheckoutUrl() {
  return process.env.CLERK_BILLING_CHECKOUT_URL || process.env.NEXT_PUBLIC_CLERK_BILLING_CHECKOUT_URL || '';
}

export function clerkBillingPortalUrl() {
  return process.env.CLERK_BILLING_PORTAL_URL || process.env.NEXT_PUBLIC_CLERK_BILLING_PORTAL_URL || '';
}

function freeEntitlement(monthlyCredits: number): AiBillingEntitlement {
  return { plan: 'free', status: 'active', monthlyCredits, source: 'fallback' };
}
