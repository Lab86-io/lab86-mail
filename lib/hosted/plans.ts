// The one source of truth for the product name, the plan names, the prices,
// and the trial. Terms, Pricing, Support, Settings, and the server read these
// constants, so a price or a name cannot drift between surfaces.
//
// Pure module: client components import it, so it must not import server code.

/** The product. "Lab86" is the company, never the product. */
export const PRODUCT_NAME = 'Albatross';
export const COMPANY_NAME = 'Lab86';
export const SUPPORT_EMAIL = 'support@lab86.io';

export type PaidPlanId = 'pro' | 'byok';

export interface PaidPlan {
  id: PaidPlanId;
  /** The name a user reads. The Clerk slug stays mail_pro / mail_byok. */
  name: string;
  monthlyUsd: number;
  annualUsd: number;
  /** One line: what the plan gives. No "AI" in user copy. */
  summary: string;
}

// Clerk Billing (production) charges these amounts. Change them here and in
// the Clerk dashboard together.
export const PAID_PLANS: Readonly<Record<PaidPlanId, PaidPlan>> = {
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyUsd: 15,
    annualUsd: 150,
    summary: 'Everything, with hosted models and a monthly budget included.',
  },
  byok: {
    id: 'byok',
    name: 'Own key',
    monthlyUsd: 12,
    annualUsd: 50.4,
    summary: 'Everything, with your own OpenRouter, OpenAI, or Anthropic key. You pay your provider.',
  },
};

export const FREE_PLAN_NAME = 'Free';

/** Days of Pro that a new account gets, with no card. */
export const TRIAL_DAYS = 14;
/** The "days left" note shows during the last this-many days of the trial. */
export const TRIAL_NOTE_DAYS = 5;
export const DAY_MS = 86_400_000;

/** "$15" or "$50.40": whole dollars drop the cents. */
export function formatUsd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** "$15/month or $150/year". */
export function planPriceLine(id: PaidPlanId): string {
  const plan = PAID_PLANS[id];
  return `${formatUsd(plan.monthlyUsd)}/month or ${formatUsd(plan.annualUsd)}/year`;
}

/** "$15/mo or $150/yr", for tight rows. */
export function planPriceShort(id: PaidPlanId): string {
  const plan = PAID_PLANS[id];
  return `${formatUsd(plan.monthlyUsd)}/mo or ${formatUsd(plan.annualUsd)}/yr`;
}

export interface TrialState {
  /** True while the trial gives Pro. */
  active: boolean;
  endsAt: number | null;
  /** Whole days left, rounded up. 0 once the trial ended. */
  daysLeft: number;
  /** True during the last TRIAL_NOTE_DAYS days of an active trial. */
  showNote: boolean;
}

/** The trial as the user sees it. `endsAt` null means the user never had a trial. */
export function trialState(endsAt: number | null | undefined, now: number): TrialState {
  if (typeof endsAt !== 'number' || !Number.isFinite(endsAt))
    return { active: false, endsAt: null, daysLeft: 0, showNote: false };
  const remaining = endsAt - now;
  if (remaining <= 0) return { active: false, endsAt, daysLeft: 0, showNote: false };
  const daysLeft = Math.ceil(remaining / DAY_MS);
  return { active: true, endsAt, daysLeft, showNote: daysLeft <= TRIAL_NOTE_DAYS };
}

/** "3 days left in your Pro trial." */
export function trialNoteText(daysLeft: number): string {
  const days = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
  return `${days} left in your ${PAID_PLANS.pro.name} trial. After that, your account moves to ${FREE_PLAN_NAME}.`;
}
