/**
 * The billing line in Settings, Intelligence. The settings API returns the
 * user's plan; a paid plan shows the plan and Manage, never Upgrade and the
 * price list.
 */
export type BillingPlan = 'free' | 'byok' | 'pro' | 'admin';

export type BillingSummaryInput = {
  plan?: BillingPlan | string | null;
  usageStatus?: string | null;
  subscriptionsDisabled?: boolean;
  paidPlan?: { monthlyUsd?: number; annualUsd?: number; byokMonthlyUsd?: number; byokAnnualUsd?: number };
};

export type BillingSummary = {
  line: string;
  planLabel: string | null;
  showUpgrade: boolean;
  showManage: boolean;
};

const PLAN_LABELS: Record<string, string> = {
  byok: 'Your own key',
  pro: 'Pro',
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
    ? `Plan: Free. Pro (hosted models) is $${p?.monthlyUsd}/mo or $${p?.annualUsd}/yr. Your own key is $${p?.byokMonthlyUsd}/mo or $${p?.byokAnnualUsd}/yr.`
    : 'Plan: Free. Upgrade for hosted models, or bring your own key for less.';
  return {
    line: usageLine ? `Plan: Free. ${usageLine}` : priceLine,
    planLabel,
    showUpgrade: true,
    showManage: true,
  };
}
