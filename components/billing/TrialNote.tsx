'use client';

// The quiet trial notes. Today shows "N days left" during the last days of
// the 14-day Pro trial; the welcome page says the trial started. Both read
// GET /api/billing/plan, which native clients read too.

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { BillingPlanView } from '@/lib/hosted/plans';
import { cn } from '@/lib/utils';

export const BILLING_PLAN_QUERY_KEY = ['billing-plan'];

export function useBillingPlan() {
  return useQuery<BillingPlanView & { subscriptionsDisabled?: boolean }>({
    queryKey: BILLING_PLAN_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/billing/plan', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Could not load your plan.');
      return data;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** "3 days left in your Pro trial…" — only during the last days of the trial. */
export function TrialDaysLeftNote({ className }: { className?: string }) {
  const { data } = useBillingPlan();
  if (!data?.note || data.subscriptionsDisabled) return null;
  return (
    <p
      role="status"
      data-slot="trial-note"
      className={cn('text-[12px] leading-relaxed text-[var(--color-text-muted)]', className)}
    >
      {data.note}{' '}
      <Link href="/pricing" className="underline underline-offset-2 hover:text-[var(--color-text)]">
        Choose a plan
      </Link>
    </p>
  );
}

/** On the welcome page: the trial is on, and no card is needed. */
export function TrialStartedNote({ className }: { className?: string }) {
  const { data } = useBillingPlan();
  if (!data?.trial.active || data.subscriptionsDisabled) return null;
  return (
    <p
      data-slot="trial-started"
      className={cn('text-center text-[12px] text-[var(--color-text-muted)]', className)}
    >
      Your {data.trialDays}-day {data.planName} is on. No card is needed, and nothing is charged when it ends.
    </p>
  );
}
