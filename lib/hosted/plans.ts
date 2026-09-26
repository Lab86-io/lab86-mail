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

export type PlanId = 'free' | PaidPlanId | 'admin';

/** What a client shows about the user's plan. GET /api/billing/plan returns it. */
export interface BillingPlanView {
  plan: PlanId;
  /** "Free", "Pro", "Pro trial", "Own key", or "Admin". */
  planName: string;
  trial: TrialState;
  /** The quiet "days left" note, only during the last days of a trial. */
  note: string | null;
  trialDays: number;
  prices: Record<PaidPlanId, { name: string; monthlyUsd: number; annualUsd: number; line: string }>;
}

export function billingPlanView(
  entitlement: { plan?: string | null; trialEndsAt?: number | null },
  now: number,
): BillingPlanView {
  const plan: PlanId =
    entitlement.plan === 'pro' || entitlement.plan === 'byok' || entitlement.plan === 'admin'
      ? entitlement.plan
      : 'free';
  const trial = plan === 'pro' ? trialState(entitlement.trialEndsAt, now) : trialState(null, now);
  const planName =
    plan === 'free'
      ? FREE_PLAN_NAME
      : plan === 'admin'
        ? 'Admin'
        : trial.active
          ? `${PAID_PLANS.pro.name} trial`
          : PAID_PLANS[plan].name;
  return {
    plan,
    planName,
    trial,
    note: trial.showNote ? trialNoteText(trial.daysLeft) : null,
    trialDays: TRIAL_DAYS,
    prices: {
      pro: { ...pick(PAID_PLANS.pro), line: planPriceLine('pro') },
      byok: { ...pick(PAID_PLANS.byok), line: planPriceLine('byok') },
    },
  };
}

function pick(plan: PaidPlan) {
  return { name: plan.name, monthlyUsd: plan.monthlyUsd, annualUsd: plan.annualUsd };
}

/** One row of the plan table on the pricing page: a feature and what each plan gives. */
export interface PlanTableRow {
  feature: string;
  free: string;
  pro: string;
  byok: string;
}

export function planTableRows(): PlanTableRow[] {
  return [
    {
      feature: 'Price',
      free: '$0',
      pro: planPriceLine('pro'),
      byok: planPriceLine('byok'),
    },
    {
      feature: 'Daily Brief',
      free: 'A plain edition, built without models',
      pro: 'Written every morning',
      byok: 'Written every morning',
    },
    {
      feature: 'Mail, calendar, and search',
      free: 'Included',
      pro: 'Included, with sorting and drafts',
      byok: 'Included, with sorting and drafts',
    },
    {
      feature: 'Chat and Albatrosses',
      free: 'Not included',
      pro: 'Included, with a monthly budget',
      byok: 'Included, paid to your provider',
    },
    {
      feature: 'Models',
      free: 'None',
      pro: 'Hosted by Lab86',
      byok: 'Your OpenRouter, OpenAI, or Anthropic key',
    },
    {
      feature: 'Standing orders, Activity, and Undo',
      free: 'Included',
      pro: 'Included',
      byok: 'Included',
    },
    {
      feature: 'Export and deletion',
      free: 'Any time',
      pro: 'Any time',
      byok: 'Any time',
    },
  ];
}

/** The pricing page questions, from the same constants. */
export function pricingFaq(): Array<{ question: string; answer: string }> {
  return [
    {
      question: 'What happens when the trial ends?',
      answer: `A new account gets ${TRIAL_DAYS} days of ${PAID_PLANS.pro.name} with no card. When the trial ends, the account moves to ${FREE_PLAN_NAME}. Nothing is charged, and nothing is deleted.`,
    },
    {
      question: 'Can I cancel at any time?',
      answer: `Yes. Open Settings, Intelligence, and choose Manage. Your plan stays until the end of the period you paid for.`,
    },
    {
      question: `What is ${PAID_PLANS.byok.name}?`,
      answer: `Everything in ${PAID_PLANS.pro.name}, with your own OpenRouter, OpenAI, or Anthropic key. You pay your provider for model use, and ${PAID_PLANS.byok.name} costs ${planPriceLine('byok')} for ${PRODUCT_NAME}.`,
    },
    {
      question: `Does ${PRODUCT_NAME} send email for me?`,
      answer: `Only after you approve it. Sending, invitations, and changes that cannot be undone always ask you first. Other changes show in Activity, and Settings, Standing orders can pause any of them.`,
    },
    {
      question: 'Which mail accounts work?',
      answer: 'Gmail and Google Workspace, Microsoft 365 and Outlook, iCloud, and other IMAP mail.',
    },
    {
      question: 'Can I take my data with me?',
      answer:
        'Yes. Settings, Account, Export my data downloads everything as a ZIP. Deleting your account removes it from our systems; the mail in your provider stays where it is.',
    },
  ];
}
