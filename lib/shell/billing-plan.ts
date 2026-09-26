import { FREE_PLAN_NAME, formatUsd, PAID_PLANS, trialState } from '../hosted/plans';

/**
 * The billing line in Settings, Intelligence. The settings API returns the
 * user's plan; a paid plan shows the plan and Manage, never Upgrade and the
 * price list. Names and price formats come from lib/hosted/plans.ts.
 */
export type BillingPlan = 'free' | 'byok' | 'pro' | 'admin';

export type BillingSummaryInput = {
  plan?: BillingPlan | string | null;
  usageStatus?: string | null;
  subscriptionsDisabled?: boolean;
  paidPlan?: { monthlyUsd?: number; annualUsd?: number; byokMonthlyUsd?: number; byokAnnualUsd?: number };
  /** Set while the app-level Pro trial gives the plan. */
  trialEndsAt?: number | null;
  now?: number;
};

export type BillingSummary = {
  line: string;
  planLabel: string | null;
  showUpgrade: boolean;
  showManage: boolean;
};

const PLAN_LABELS: Record<string, string> = {
  byok: PAID_PLANS.byok.name,
  pro: PAID_PLANS.pro.name,
  admin: 'Admin',
};

export function billingSummary(input: BillingSummaryInput): BillingSummary {
  const plan = input.plan && PLAN_LABELS[input.plan] ? input.plan : 'free';
  const paid = plan !== 'free';
  const planLabel = paid ? PLAN_LABELS[plan] : null;
  if (input.subscriptionsDisabled)
    return {
      line: 'Subscriptions are paused. Add your OpenRouter key to use models.',
      planLabel,
      showUpgrade: false,
      showManage: false,
    };
  // A trial is Pro with no subscription behind it: offer Upgrade, not Manage.
  const trial = plan === 'pro' ? trialState(input.trialEndsAt, input.now ?? Date.now()) : null;
  if (trial?.active) {
    const days = trial.daysLeft === 1 ? '1 day' : `${trial.daysLeft} days`;
    return {
      line: `Plan: ${PAID_PLANS.pro.name} trial, ${days} left. No card is on file. After the trial, your account moves to ${FREE_PLAN_NAME}.`,
      planLabel: `${PAID_PLANS.pro.name} trial`,
      showUpgrade: true,
      showManage: false,
    };
  }
  const p = input.paidPlan;
  const pricesPresent =
    typeof p?.monthlyUsd === 'number' &&
    typeof p?.annualUsd === 'number' &&
    typeof p?.byokMonthlyUsd === 'number' &&
    typeof p?.byokAnnualUsd === 'number';
  const usageLine =
    input.usageStatus === 'reduced_cost'
      ? 'Models use reduced-cost routing for the rest of this billing period.'
      : input.usageStatus === 'exhausted'
        ? 'Chat is paused for this billing period. Mail sorting continues.'
        : null;
  if (paid)
    return {
      line: usageLine ? `Plan: ${planLabel}. ${usageLine}` : `Plan: ${planLabel}.`,
      planLabel,
      showUpgrade: false,
      showManage: plan !== 'admin',
    };
  const priceLine = pricesPresent
    ? `Plan: ${FREE_PLAN_NAME}. ${PAID_PLANS.pro.name} (hosted models) is ${formatUsd(p?.monthlyUsd ?? 0)}/mo or ${formatUsd(p?.annualUsd ?? 0)}/yr. ${PAID_PLANS.byok.name} is ${formatUsd(p?.byokMonthlyUsd ?? 0)}/mo or ${formatUsd(p?.byokAnnualUsd ?? 0)}/yr.`
    : `Plan: ${FREE_PLAN_NAME}. Upgrade for hosted models, or bring your own key for less.`;
  return {
    line: usageLine ? `Plan: ${FREE_PLAN_NAME}. ${usageLine}` : priceLine,
    planLabel,
    showUpgrade: true,
    showManage: true,
  };
}
