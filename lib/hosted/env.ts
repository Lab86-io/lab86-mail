import { isSubscriptionServiceDisabled } from './controls';

export function isClerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export function isConvexConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL);
}

export function isNylasConfigured() {
  return Boolean(process.env.NYLAS_API_KEY && process.env.NYLAS_CLIENT_ID);
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRO_PRICE_ID);
}

export function isClerkBillingConfigured() {
  if (isSubscriptionServiceDisabled()) return false;
  return isClerkConfigured();
}

export function hostedPublicUrl() {
  return (
    process.env.LAB86_MAIL_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.MAIL_OS_PUBLIC_URL ||
    'http://127.0.0.1:18837'
  ).replace(/\/$/, '');
}

export function nylasRedirectUri() {
  return process.env.NYLAS_REDIRECT_URI || `${hostedPublicUrl()}/api/nylas/callback`;
}

export function convexUrl() {
  return process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL || '';
}

export function convexInternalSecret() {
  return process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
}

export function aiCreditDefaults() {
  const numberFromEnv = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    freeMonthlyCredits: numberFromEnv(process.env.LAB86_AI_FREE_MONTHLY_CREDITS, 0),
    proMonthlyCredits: numberFromEnv(process.env.LAB86_AI_PRO_MONTHLY_CREDITS, 500),
  };
}
