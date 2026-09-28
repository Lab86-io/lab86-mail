import { api, convexQuery } from '@/lib/hosted/convex';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { RateLimitError } from '@/lib/rate-limit';
import { stripLoneSurrogates, truncateText } from '@/lib/shared/text';
import { type ContactSource, contactSourcePlan } from './model';
import type { RecipientSuggestion } from './recipients';

// Server-side reads of the contact features: recipient search (web compose,
// native compose, and the assistant tools) and the per-mailbox contact status
// (Settings and native). One Convex query each.

type Query = typeof convexQuery;

export interface RecipientSearchInput {
  query: string;
  fromAccountId?: string;
  limit?: number;
  exclude?: string[];
}

export async function suggestRecipients(
  userId: string,
  input: RecipientSearchInput,
  query: Query = convexQuery,
): Promise<{ query: string; items: RecipientSuggestion[] }> {
  const result = await query<{ query: string; items: RecipientSuggestion[] }>(
    api.correspondents.suggestRecipients,
    {
      userId,
      query: truncateText(stripLoneSurrogates(String(input.query || '')), 200),
      ...(input.fromAccountId ? { fromAccountId: input.fromAccountId } : {}),
      limit: input.limit,
      exclude: (input.exclude || []).slice(0, 50),
    },
  );
  return { query: result?.query ?? '', items: result?.items ?? [] };
}

// Recipient search runs on each keystroke, so its limit lives in memory: a
// Convex write for each keystroke would cost more than the search itself.
const RECIPIENT_LIMIT = 240;
const RECIPIENT_WINDOW_MS = 60_000;
const recipientWindows = new Map<string, { start: number; count: number }>();

export function checkRecipientRateLimit(userId: string, now = Date.now()) {
  const window = recipientWindows.get(userId);
  if (!window || now - window.start >= RECIPIENT_WINDOW_MS) {
    if (recipientWindows.size > 10_000) recipientWindows.clear();
    recipientWindows.set(userId, { start: now, count: 1 });
    return;
  }
  window.count += 1;
  if (window.count > RECIPIENT_LIMIT) {
    throw new RateLimitError(
      'Too many requests. Try again shortly.',
      RECIPIENT_WINDOW_MS - (now - window.start),
      RECIPIENT_LIMIT,
    );
  }
}

export function __resetRecipientRateLimitForTest() {
  recipientWindows.clear();
}

/** A split query-string list: repeated keys and comma-separated values. */
export function readExcludeParam(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
}

// ---- Contact status ---------------------------------------------------------------

export type ContactAccountState =
  | 'ready'
  | 'syncing'
  | 'pending'
  | 'needsReconnect'
  | 'unsupported'
  | 'error'
  | 'paused';

export interface ContactAccountStatus {
  accountId: string;
  email: string;
  provider: NylasAccountRow['provider'];
  state: ContactAccountState;
  needsReconnect: boolean;
  contactCount: number;
  lastSyncedAt?: number;
  sources: Array<{
    source: ContactSource;
    state: 'ok' | 'missing_scope' | 'unsupported' | 'capped' | 'error';
    count?: number;
  }>;
  message?: string;
}

interface StoredContactState {
  accountId: string;
  status: 'idle' | 'syncing' | 'ready' | 'needs_reconnect' | 'unsupported' | 'error';
  sources: ContactAccountStatus['sources'];
  contactCount?: number;
  lastFullSyncAt?: number;
  lastAttemptAt?: number;
  syncing?: boolean;
}

export const CONTACT_STATUS_MESSAGES: Partial<Record<ContactAccountState, string>> = {
  needsReconnect: 'Reconnect this mailbox to add its contacts.',
  paused: 'This mailbox needs to sign in again.',
  unsupported: 'This mailbox has no contacts to sync.',
  error: 'Contact sync failed. It will try again.',
  pending: 'The first contact sync has not finished.',
  syncing: 'Contacts are syncing.',
};

function stateFor(account: NylasAccountRow & { updatedAt?: number }, stored?: StoredContactState) {
  if (account.status !== 'connected') return 'paused' as const;
  const plan = contactSourcePlan(account);
  const missing = plan.some((entry) => entry.scope === 'missing');
  if (!stored) return missing ? ('needsReconnect' as const) : ('pending' as const);
  if (stored.syncing) return 'syncing' as const;
  switch (stored.status) {
    case 'ready':
      return 'ready' as const;
    case 'needs_reconnect':
      // A reconnect after the last pass may have added the scopes; the pass
      // that the reconnect started will say.
      return !missing && (account.updatedAt ?? 0) > (stored.lastAttemptAt ?? 0)
        ? ('pending' as const)
        : ('needsReconnect' as const);
    case 'unsupported':
      return 'unsupported' as const;
    case 'error':
      return 'error' as const;
    default:
      return 'pending' as const;
  }
}

/** The contact state of each mailbox that is connected or needs a reconnect. */
export async function loadContactStatuses(userId: string, query: Query = convexQuery) {
  const [accounts, states] = await Promise.all([
    query<Array<NylasAccountRow & { updatedAt?: number }>>(api.accounts.listConnectedAccounts, { userId }),
    query<StoredContactState[]>(api.contacts.listContactStates, { userId }).catch(() => []),
  ]);
  const byAccount = new Map((states || []).map((state) => [state.accountId, state]));
  const out: ContactAccountStatus[] = [];
  for (const account of accounts || []) {
    if (account.status !== 'connected' && account.status !== 'error') continue;
    const stored = byAccount.get(account.accountId);
    const state = stateFor(account, stored);
    // Before a pass, only what the stored scopes prove is shown.
    const sources: ContactAccountStatus['sources'] =
      stored?.sources?.length && state !== 'pending'
        ? stored.sources.map((entry) => ({ source: entry.source, state: entry.state, count: entry.count }))
        : contactSourcePlan(account)
            .filter((entry) => entry.scope === 'missing' || entry.scope === 'unsupported')
            .map((entry) => ({
              source: entry.source,
              state: entry.scope === 'missing' ? ('missing_scope' as const) : ('unsupported' as const),
            }));
    out.push({
      accountId: account.accountId,
      email: account.email,
      provider: account.provider,
      state,
      needsReconnect: state === 'needsReconnect',
      contactCount: Math.max(0, Math.floor(stored?.contactCount ?? 0)),
      lastSyncedAt: stored?.lastFullSyncAt,
      sources,
      message: CONTACT_STATUS_MESSAGES[state],
    });
  }
  return out;
}
