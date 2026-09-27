'use client';

// The plan line in Settings, Account. It reads the same plan as the trial
// notes (useBillingPlan, GET /api/billing/plan); billing itself is in
// Settings, Intelligence.

import type { MouseEvent } from 'react';
import { useBillingPlan } from '@/components/billing/TrialNote';
import { Button } from '@/components/ui/button';
import { accountPlanLine } from '@/lib/shell/billing-plan';
import { SettingsRow } from './primitives';

export const BILLING_SETTINGS_HREF = '/settings?tab=ai';

export function AccountPlanRow({ onOpenBilling }: { onOpenBilling: () => void }) {
  const { data } = useBillingPlan();
  // A deployment with subscriptions off has no billing to open.
  if (!data || data.subscriptionsDisabled) return null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // A new tab or window still follows the link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onOpenBilling();
  };
  return (
    <SettingsRow
      label="Plan"
      description={`${accountPlanLine(data)} Billing is in Intelligence.`}
      control={
        <Button asChild size="sm" variant="outline">
          <a href={BILLING_SETTINGS_HREF} onClick={open} data-account-plan-billing>
            Open billing
          </a>
        </Button>
      }
    />
  );
}
