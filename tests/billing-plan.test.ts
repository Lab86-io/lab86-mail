import { expect, test } from 'bun:test';
import { PAID_PLANS } from '../lib/hosted/plans';
import { billingSummary } from '../lib/shell/billing-plan';

const prices = { monthlyUsd: 12, annualUsd: 120, byokMonthlyUsd: 5, byokAnnualUsd: 50 };

test('paid plans show the plan and Manage, never Upgrade or prices', () => {
  for (const [plan, label] of [
    ['pro', 'Pro'],
    ['byok', 'Own key'],
  ] as const) {
    const summary = billingSummary({ plan, paidPlan: prices });
    expect(summary).toEqual({
      line: `Plan: ${label}.`,
      planLabel: label,
      showUpgrade: false,
      showManage: true,
    });
    expect(summary.line).not.toContain('$');
  }
  expect(billingSummary({ plan: 'admin' })).toMatchObject({ showUpgrade: false, showManage: false });
  expect(billingSummary({ plan: 'pro', usageStatus: 'exhausted' }).line).toBe(
    'Plan: Pro. Chat is paused for this billing period. Mail sorting continues.',
  );
});

test('the free plan shows prices and Upgrade', () => {
  expect(billingSummary({ plan: 'free', paidPlan: prices })).toEqual({
    line: 'Plan: Free. Pro (hosted models) is $12/mo or $120/yr. Own key is $5/mo or $50/yr.',
    planLabel: null,
    showUpgrade: true,
    showManage: true,
  });
  // The real prices come from the plan constants, cents only when a price has them.
  const real = {
    monthlyUsd: PAID_PLANS.pro.monthlyUsd,
    annualUsd: PAID_PLANS.pro.annualUsd,
    byokMonthlyUsd: PAID_PLANS.byok.monthlyUsd,
    byokAnnualUsd: PAID_PLANS.byok.annualUsd,
  };
  expect(billingSummary({ plan: 'free', paidPlan: real }).line).toBe(
    'Plan: Free. Pro (hosted models) is $15/mo or $150/yr. Own key is $12/mo or $50.40/yr.',
  );
  expect(billingSummary({}).line).toBe(
    'Plan: Free. Upgrade for hosted models, or bring your own key for less.',
  );
  expect(billingSummary({ plan: 'unknown', usageStatus: 'reduced_cost' }).line).toBe(
    'Plan: Free. Models use reduced-cost routing for the rest of this billing period.',
  );
});

test('paused subscriptions hide every billing action', () => {
  expect(billingSummary({ plan: 'pro', subscriptionsDisabled: true })).toMatchObject({
    showUpgrade: false,
    showManage: false,
  });
});
