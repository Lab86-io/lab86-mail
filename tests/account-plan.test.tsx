import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { BILLING_PLAN_QUERY_KEY } from '../components/billing/TrialNote';
import { AccountPlanRow, BILLING_SETTINGS_HREF } from '../components/settings/AccountPlan';
import { billingPlanView, DAY_MS } from '../lib/hosted/plans';
import { accountPlanLine } from '../lib/shell/billing-plan';

/* Settings, Account names the plan and the trial days left, and links to
 * Settings, Intelligence, where billing is. */

const NOW = 1_800_000_000_000;

describe('the plan line', () => {
  test('a trial says the days left', () => {
    expect(accountPlanLine(billingPlanView({ plan: 'pro', trialEndsAt: NOW + 14 * DAY_MS }, NOW))).toBe(
      'Pro trial, 14 days left.',
    );
    expect(accountPlanLine(billingPlanView({ plan: 'pro', trialEndsAt: NOW + 1 }, NOW))).toBe(
      'Pro trial, 1 day left.',
    );
  });

  test('a plan without a trial says only its name', () => {
    expect(accountPlanLine(billingPlanView({ plan: 'pro' }, NOW))).toBe('Pro.');
    expect(accountPlanLine(billingPlanView({ plan: 'byok' }, NOW))).toBe('Own key.');
    expect(accountPlanLine(billingPlanView({ plan: null }, NOW))).toBe('Free.');
    // An ended trial is no longer a trial.
    expect(accountPlanLine(billingPlanView({ plan: 'pro', trialEndsAt: NOW - DAY_MS }, NOW))).toBe('Pro.');
  });
});

function renderRow(data: unknown) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data !== undefined) query.setQueryData(BILLING_PLAN_QUERY_KEY, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={query}>
      <AccountPlanRow onOpenBilling={() => {}} />
    </QueryClientProvider>,
  );
}

describe('the Account row', () => {
  test('it reads the plan API and links to Intelligence for billing', () => {
    const view = billingPlanView({ plan: 'pro', trialEndsAt: Date.now() + 14 * DAY_MS - 60_000 }, Date.now());
    const doc = new JSDOM(renderRow({ ok: true, ...view })).window.document;
    expect(doc.body.textContent).toContain('Plan');
    expect(doc.body.textContent).toContain('Pro trial, 14 days left. Billing is in Intelligence.');
    const link = doc.querySelector('a[data-account-plan-billing]');
    expect(link?.getAttribute('href')).toBe(BILLING_SETTINGS_HREF);
    expect(BILLING_SETTINGS_HREF).toBe('/settings?tab=ai');
    expect(link?.textContent).toBe('Open billing');
  });

  test('it stays out while the plan loads, and where subscriptions are off', () => {
    expect(renderRow(undefined)).toBe('');
    expect(
      renderRow({ ok: true, ...billingPlanView({ plan: null }, NOW), subscriptionsDisabled: true }),
    ).toBe('');
  });

  test('Settings, Account shows it and opens the Intelligence tab in place', () => {
    const page = readFileSync(path.join(import.meta.dir, '..', 'app/settings/page.tsx'), 'utf8');
    const account = page.slice(page.indexOf('function AccountSection()'));
    expect(account).toContain('<AccountPlanRow');
    expect(account).toMatch(/onOpenBilling=\{\(\) => \{\s*openTab\('ai'\);/);
    expect(page).toContain('<OpenSettingsTab.Provider value={selectTab}>');
  });
});
