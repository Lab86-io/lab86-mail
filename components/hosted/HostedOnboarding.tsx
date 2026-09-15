'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ONBOARDING_DISMISSED_STORAGE_KEY } from './onboarding-state';

interface NylasAccount {
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
  displayName?: string;
}

interface NylasCapability {
  provider: NylasAccount['provider'];
  label: string;
  visible: boolean;
  connectable: boolean;
  reason?: string;
}

interface NylasStatus {
  accounts?: NylasAccount[];
  capabilities?: NylasCapability[];
}

// First run no longer blocks the product. A new account lands in Albatross and
// can capture straight away; connecting a mailbox is an offer inside the app,
// not a gate in front of it. This component only records that the user has
// mailboxes, so the setup screen stops offering itself.
export function RecordMailboxesConnected() {
  const {
    data: nylas,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['nylas-status'],
    queryFn: async () => fetchJson('/api/nylas/status') as Promise<NylasStatus>,
    retry: false,
  });
  useEffect(() => {
    if (isLoading || isError) return;
    if (!(nylas?.accounts || []).length) return;
    // Private browsing and storage-blocking extensions both throw here. Failing
    // to record the flag is not worth taking the app down for.
    try {
      if (window.localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === '1') return;
      window.localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
    } catch {
      // No storage available. The welcome screen simply asks again.
    }
  }, [isLoading, isError, nylas]);
  return null;
}

async function fetchJson(url: string) {
  return check(await fetch(url, { cache: 'no-store' }));
}

async function check(res: Response) {
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
