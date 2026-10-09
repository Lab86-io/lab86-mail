// Atlassian personal data reporting for the Atlassian OAuth (3LO) app
// (developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide).
//
// The only Atlassian personal data that Albatross keeps is the profile of the
// user who connected (the email in the sync state). Jira items keep no names
// of other people. So each Atlassian connection reports its own account once
// a day. Atlassian answers which accounts are closed (erase the data) or
// updated (read the profile again).

import { truncateText } from '../shared/text';
import {
  disconnectConnection,
  getConnectionToken,
  listUserConnections,
  type McpConnectionRow,
} from './connections';
import { syncConnection } from './sync';

const ATLASSIAN_API = 'https://api.atlassian.com';
export const ATLASSIAN_REPORT_URL = `${ATLASSIAN_API}/app/report-accounts/`;
const REQUEST_TIMEOUT_MS = 15_000;

export type AtlassianAccountReport = 'ok' | 'closed' | 'updated';

export interface AtlassianPrivacyResult {
  connectionId: string;
  outcome: 'reported' | 'erased' | 'refreshed' | 'skipped' | 'failed';
  detail?: string;
}

const defaultDeps = {
  listUserConnections,
  getConnectionToken,
  disconnectConnection,
  syncConnection,
  fetchFn: ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
  now: () => Date.now(),
};

export type AtlassianPrivacyDeps = typeof defaultDeps;

async function readAccountId(token: string, fetchFn: typeof fetch): Promise<string | null> {
  const response = await fetchFn(`${ATLASSIAN_API}/me`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { account_id?: unknown } | null;
  return typeof body?.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : null;
}

/**
 * Reports one account. `updatedAt` is when Albatross last read the account's
 * profile. A 204 means no action; a 200 names the accounts to erase or
 * refresh.
 */
export async function reportAtlassianAccount(input: {
  token: string;
  accountId: string;
  updatedAt: number;
  fetchFn?: typeof fetch;
}): Promise<AtlassianAccountReport> {
  const response = await (input.fetchFn || fetch)(ATLASSIAN_REPORT_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      accounts: [{ accountId: input.accountId, updatedAt: new Date(input.updatedAt).toISOString() }],
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 204) return 'ok';
  if (response.status === 200) {
    const body = (await response.json().catch(() => null)) as {
      accounts?: Array<{ accountId?: string; status?: string }>;
    } | null;
    const row = body?.accounts?.find((account) => account.accountId === input.accountId);
    if (row?.status === 'closed') return 'closed';
    if (row?.status === 'updated') return 'updated';
    return 'ok';
  }
  const text = await response.text().catch(() => '');
  throw new Error(
    `Atlassian account report failed with HTTP ${response.status}${text.trim() ? `: ${truncateText(text.trim(), 200)}` : ''}`,
  );
}

function isAtlassianSignIn(row: McpConnectionRow) {
  return row.server === 'jira' && row.authKind === 'oauth' && row.status !== 'disconnected';
}

/** Reports every Atlassian sign-in of one user and acts on the answer. */
export async function reportAtlassianPersonalData(
  userId: string,
  overrides: Partial<AtlassianPrivacyDeps> = {},
): Promise<AtlassianPrivacyResult[]> {
  const deps = { ...defaultDeps, ...overrides };
  const results: AtlassianPrivacyResult[] = [];
  for (const row of (await deps.listUserConnections(userId)).filter(isAtlassianSignIn)) {
    const connectionId = row.connectionId;
    try {
      const credentials = await deps.getConnectionToken(userId, connectionId);
      // No working token: the connection already asks for a reconnect, and
      // the next sign-in reports again.
      if (!credentials) {
        results.push({ connectionId, outcome: 'skipped', detail: 'no working sign-in' });
        continue;
      }
      const accountId = await readAccountId(credentials.token, deps.fetchFn);
      if (!accountId) {
        results.push({ connectionId, outcome: 'skipped', detail: 'profile not readable' });
        continue;
      }
      const status = await reportAtlassianAccount({
        token: credentials.token,
        accountId,
        updatedAt: row.lastSyncOkAt || row.lastSyncedAt || deps.now(),
        fetchFn: deps.fetchFn,
      });
      if (status === 'closed') {
        // The account is closed: remove the connection and its data.
        await deps.disconnectConnection(userId, connectionId);
        results.push({ connectionId, outcome: 'erased' });
      } else if (status === 'updated') {
        // The profile changed: a sync reads it again.
        await deps.syncConnection(userId, connectionId);
        results.push({ connectionId, outcome: 'refreshed' });
      } else {
        results.push({ connectionId, outcome: 'reported' });
      }
    } catch (error) {
      results.push({
        connectionId,
        outcome: 'failed',
        detail: truncateText(String((error as Error)?.message || 'report failed'), 200),
      });
    }
  }
  return results;
}
