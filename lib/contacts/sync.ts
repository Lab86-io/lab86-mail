import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { isGrantGoneError, noteGrantFailure } from '@/lib/nylas/grant-health';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import {
  describeNylasError,
  isNylasRateLimited,
  nylasErrorStatus,
  retryAfterMs,
  withNylasRetry,
} from '@/lib/nylas/retry';
import {
  CONTACT_FULL_SYNC_INTERVAL_MS,
  type ContactInput,
  type ContactScopeState,
  type ContactSource,
  contactSourcePlan,
  DEAD_ACCOUNT_CONTACT_RETENTION_MS,
  normalizeNylasContact,
} from './model';

// Contact sync for one mailbox (Nylas v3 Contacts API). A full pass reads
// each source the grant can read, saved contacts first; the Convex writer
// skips rows whose hash is equal, and a completed source pass deletes rows the
// provider no longer lists. Webhooks (contact.updated, contact.deleted) apply
// single changes between the daily passes.
//
// A 403 means the grant lacks a contact scope. That is a per-source state
// ("Reconnect to add contacts"), never a dead grant: the mail grant still
// works. Only an error that says the grant itself is gone marks the account.

export type ContactSourceState = 'ok' | 'missing_scope' | 'unsupported' | 'capped' | 'error';
export type ContactSyncStatus = 'idle' | 'syncing' | 'ready' | 'needs_reconnect' | 'unsupported' | 'error';

export interface ContactSourceResult {
  source: ContactSource;
  state: ContactSourceState;
  count?: number;
  syncedAt?: number;
  error?: string;
}

export interface ContactSyncResult {
  ok: boolean;
  accountId: string;
  status?: ContactSyncStatus;
  skipped?: boolean;
  reason?: string;
  contacts?: number;
  sources?: ContactSourceResult[];
  retryAt?: number;
}

const PAGE_LIMIT = 100;
// Rows a source may write in one pass. The work directory can be very large,
// so it gets the smallest cap; saved contacts and people the user wrote to
// come first in the pass.
export const CONTACT_SOURCE_CAPS: Record<ContactSource, number> = {
  address_book: 10_000,
  inbox: 10_000,
  domain: 5_000,
};
const LEASE_MS = 20 * 60_000;
const UPSERT_BATCH = 100;
const DELETE_BATCH = 200;
// A pass that sees no rows while many are stored is more likely a provider
// fault than an empty address book, so it does not prune.
const EMPTY_PASS_PRUNE_GUARD = 50;
const RATE_LIMIT_WAIT_MS = 15 * 60_000;
const KICK_DEBOUNCE_MS = 60_000;

type Query = typeof convexQuery;
type Mutate = typeof convexMutation;

interface ContactSyncDeps {
  query: Query;
  mutate: Mutate;
  nylas: typeof requireNylas;
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
  now: () => number;
  leaseId: () => string;
}

const defaultDeps: ContactSyncDeps = {
  query: convexQuery,
  mutate: convexMutation,
  nylas: requireNylas,
  retry: (fn) => withNylasRetry(fn),
  now: () => Date.now(),
  leaseId: () => randomUUID(),
};

let deps = defaultDeps;

export function setContactSyncDependenciesForTest(overrides: Partial<ContactSyncDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = defaultDeps;
  };
}

async function readAccount(userId: string, accountId: string) {
  return await deps.query<NylasAccountRow | null>(api.accounts.getConnectedAccount, { userId, accountId });
}

function sameScopes(a: string[], b: string[]) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * Reads the grant's current scopes from Nylas and stores them when they
 * changed, so a re-auth that added contact scopes is seen at once.
 */
export async function refreshGrantScopes(row: NylasAccountRow): Promise<NylasAccountRow> {
  const grant = await deps.retry(() => deps.nylas().grants.find({ grantId: row.grantId }));
  const scopes = Array.isArray((grant.data as any)?.scope)
    ? ((grant.data as any).scope as unknown[]).filter((scope): scope is string => typeof scope === 'string')
    : null;
  if (!scopes || sameScopes(scopes, row.scopes || [])) return row;
  await deps.mutate(api.accounts.updateGrantScopes, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    scopes,
  });
  return { ...row, scopes };
}

interface SourcePass {
  ids: string[];
  capped: boolean;
}

async function readSource(row: NylasAccountRow, source: ContactSource): Promise<SourcePass> {
  const cap = CONTACT_SOURCE_CAPS[source];
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const token = pageToken;
    const page = await deps.retry(() =>
      deps.nylas().contacts.list({
        identifier: row.grantId,
        queryParams: { source, limit: PAGE_LIMIT, ...(token ? { pageToken: token } : {}) } as any,
      }),
    );
    const contacts = (page.data || [])
      .map((raw) => normalizeNylasContact(raw, source))
      .filter((contact): contact is ContactInput => Boolean(contact))
      // One provider id is one row; a repeated id is written once.
      .filter((contact) => {
        if (seen.has(contact.providerContactId)) return false;
        seen.add(contact.providerContactId);
        return true;
      });
    for (let i = 0; i < contacts.length; i += UPSERT_BATCH) {
      await deps.mutate(api.contacts.upsertContactBatch, {
        userId: row.userId,
        accountId: row.accountId,
        provider: row.provider,
        contacts: contacts.slice(i, i + UPSERT_BATCH),
      });
    }
    for (const contact of contacts) ids.push(contact.providerContactId);
    pageToken = (page as any).nextCursor || undefined;
    if (pageToken && ids.length >= cap) return { ids, capped: true };
  } while (pageToken);
  return { ids, capped: false };
}

/** Deletes the stored rows of one source that a complete pass did not see. */
async function pruneSource(row: NylasAccountRow, source: ContactSource, keepIds: string[]) {
  const keep = new Set(keepIds);
  const stale: string[] = [];
  let stored = 0;
  let cursor: string | null = null;
  do {
    const page: { ids: string[]; isDone: boolean; continueCursor: string } = await deps.query(
      api.contacts.listContactIds,
      { userId: row.userId, accountId: row.accountId, source, cursor, numItems: 500 },
    );
    stored += page.ids.length;
    for (const id of page.ids) if (!keep.has(id)) stale.push(id);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  if (!keep.size && stored > EMPTY_PASS_PRUNE_GUARD) {
    console.warn(`[contacts] ${source} pass for ${row.accountId} saw no rows; kept ${stored} stored rows`);
    return 0;
  }
  for (let i = 0; i < stale.length; i += DELETE_BATCH) {
    await deps.mutate(api.contacts.deleteContacts, {
      userId: row.userId,
      accountId: row.accountId,
      providerContactIds: stale.slice(i, i + DELETE_BATCH),
    });
  }
  return stale.length;
}

function overallStatus(results: ContactSourceResult[], grantGone: boolean): ContactSyncStatus {
  if (grantGone) return 'error';
  if (results.some((entry) => entry.state === 'missing_scope')) return 'needs_reconnect';
  if (results.some((entry) => entry.state === 'ok' || entry.state === 'capped')) return 'ready';
  if (results.every((entry) => entry.state === 'unsupported')) return 'unsupported';
  return 'error';
}

// A 403 with the scope granted is the provider refusing this source (a
// directory the administrator turned off, for example). A reconnect does not
// help, so it is not a missing scope.
function forbiddenState(scope: ContactScopeState): ContactSourceState {
  return scope === 'granted' ? 'unsupported' : 'missing_scope';
}

/** One full pass over the contacts of one connected mailbox. */
export async function syncAccountContacts({
  userId,
  accountId,
  force = false,
  reason = 'cron',
}: {
  userId: string;
  accountId: string;
  force?: boolean;
  reason?: string;
}): Promise<ContactSyncResult> {
  let row = await readAccount(userId, accountId);
  if (!row || row.status !== 'connected') {
    return { ok: false, accountId, skipped: true, reason: 'not_connected' };
  }
  const leaseId = deps.leaseId();
  const claim = await deps.mutate<{
    claimed: boolean;
    reason: string;
    retryAt?: number;
    previous: { sources: ContactSourceResult[]; contactCount?: number } | null;
  }>(api.contacts.claimContactSync, {
    userId,
    accountId,
    grantId: row.grantId,
    provider: row.provider,
    leaseId,
    leaseMs: LEASE_MS,
    minIntervalMs: force ? 0 : CONTACT_FULL_SYNC_INTERVAL_MS,
    force,
  });
  if (!claim.claimed)
    return { ok: true, accountId, skipped: true, reason: claim.reason, retryAt: claim.retryAt };

  const previous = new Map((claim.previous?.sources || []).map((entry) => [entry.source, entry]));
  const results: ContactSourceResult[] = [];
  let grantGone = false;
  let retryAt: number | undefined;
  let failure: string | undefined;
  try {
    try {
      row = await refreshGrantScopes(row);
    } catch (err) {
      if (await noteGrantFailure(row.grantId, err, deps.mutate)) throw err;
      // The stored scopes still decide; the provider answers each source.
      console.warn(`[contacts] grant scope read failed for ${accountId}:`, describeNylasError(err));
    }
    for (const { source, scope } of contactSourcePlan(row)) {
      const kept = previous.get(source);
      if (grantGone || retryAt) {
        // Nothing was read: the stored rows and their count stay.
        results.push({ source, state: kept?.state ?? 'error', count: kept?.count, syncedAt: kept?.syncedAt });
        continue;
      }
      if (scope === 'unsupported') {
        results.push({ source, state: 'unsupported' });
        continue;
      }
      if (scope === 'missing') {
        results.push({ source, state: 'missing_scope', count: kept?.count });
        continue;
      }
      try {
        const pass = await readSource(row, source);
        if (!pass.capped) await pruneSource(row, source, pass.ids);
        results.push({
          source,
          state: pass.capped ? 'capped' : 'ok',
          count: pass.ids.length,
          syncedAt: deps.now(),
        });
      } catch (err) {
        const detail = describeNylasError(err, 'contact sync failed');
        if (isGrantGoneError(err)) {
          grantGone = true;
          failure = detail;
          await noteGrantFailure(row.grantId, err, deps.mutate);
          results.push({ source, state: 'error', count: kept?.count, error: detail });
          continue;
        }
        if (isNylasRateLimited(err)) {
          retryAt = deps.now() + Math.max(retryAfterMs(err) ?? 0, RATE_LIMIT_WAIT_MS);
          failure = detail;
          results.push({ source, state: kept?.state ?? 'error', count: kept?.count, error: detail });
          continue;
        }
        const status = nylasErrorStatus(err);
        if (status === 401 || status === 403) {
          results.push({ source, state: forbiddenState(scope), count: kept?.count, error: detail });
          continue;
        }
        if (status === 400 || status === 404 || status === 501) {
          // For example iCloud "IMAP contact persistence feature is not enabled".
          results.push({ source, state: 'unsupported', error: detail });
          continue;
        }
        results.push({ source, state: 'error', count: kept?.count, error: detail });
      }
    }
  } catch (err) {
    grantGone = grantGone || isGrantGoneError(err);
    failure = describeNylasError(err, 'contact sync failed');
    for (const entry of claim.previous?.sources || []) {
      if (!results.some((result) => result.source === entry.source)) results.push(entry);
    }
  }

  const status = overallStatus(results, grantGone);
  const contactCount = results.reduce((sum, entry) => sum + (entry.count || 0), 0);
  await deps.mutate(api.contacts.finishContactSync, {
    userId,
    accountId,
    leaseId,
    status,
    sources: results,
    contactCount,
    // A rate-limited pass waits for retryAt and then runs again.
    lastFullSyncAt: retryAt || grantGone ? undefined : deps.now(),
    retryAt,
    error: failure,
  });
  return { ok: !grantGone, accountId, status, contacts: contactCount, sources: results, retryAt, reason };
}

/**
 * The cron pass for one user: every connected mailbox that is due, and the
 * dead-source cleanup for mailboxes that need a reconnect.
 */
export async function syncUserContacts(userId: string, options: { force?: boolean; reason?: string } = {}) {
  const accounts = await deps.query<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId });
  const states = await deps
    .query<Array<{ accountId: string; lastFullSyncAt?: number }>>(api.contacts.listContactStates, { userId })
    .catch(() => []);
  const stateByAccount = new Map(states.map((state) => [state.accountId, state]));
  const results: ContactSyncResult[] = [];
  for (const account of accounts || []) {
    if (account.status !== 'connected') {
      const state = stateByAccount.get(account.accountId);
      const lastGood = state?.lastFullSyncAt ?? 0;
      if (state && deps.now() - lastGood >= DEAD_ACCOUNT_CONTACT_RETENTION_MS) {
        await deps
          .mutate(api.contacts.retireAccountContacts, { userId, accountId: account.accountId })
          .catch((err) => console.warn('[contacts] retire failed', account.accountId, err?.message || err));
        results.push({ ok: true, accountId: account.accountId, skipped: true, reason: 'retired' });
      }
      continue;
    }
    try {
      results.push(
        await syncAccountContacts({
          userId,
          accountId: account.accountId,
          force: options.force,
          reason: options.reason,
        }),
      );
    } catch (err: any) {
      results.push({
        ok: false,
        accountId: account.accountId,
        reason: err?.message || 'contact sync failed',
      });
    }
  }
  return results;
}

const kickedAt = new Map<string, number>();

/**
 * Fire-and-forget first sync after a connect or reconnect, and the manual
 * resync. A second kick for the same mailbox within a minute does nothing.
 */
export function maybeKickContactSync(
  row: Pick<NylasAccountRow, 'userId' | 'accountId'>,
  options: { force?: boolean; reason?: string } = {},
) {
  const key = `${row.userId}:${row.accountId}`;
  const last = kickedAt.get(key) || 0;
  if (deps.now() - last < KICK_DEBOUNCE_MS) return false;
  kickedAt.set(key, deps.now());
  if (kickedAt.size > 5_000) kickedAt.delete(kickedAt.keys().next().value as string);
  void syncAccountContacts({
    userId: row.userId,
    accountId: row.accountId,
    force: options.force ?? true,
    reason: options.reason ?? 'kick',
  }).catch((err) => {
    kickedAt.delete(key);
    console.error(`[contacts] background sync failed for ${row.accountId}:`, err?.message || err);
  });
  return true;
}

export function __resetContactKicksForTest() {
  kickedAt.clear();
}

// ---- Webhooks ----------------------------------------------------------------

export function isContactWebhookType(type: string) {
  return /^contact\./.test(type);
}

function webhookObject(payload: unknown): any {
  const root = (payload || {}) as any;
  return root.data?.object || root.object || {};
}

/**
 * One contact change from a Nylas webhook. `contact.deleted` removes the row.
 * An update carries the contact; when it does not carry the addresses, the
 * contact is read again. A contact that lost every address is removed.
 */
export async function applyContactWebhookDelta(row: NylasAccountRow, type: string, payload: unknown) {
  const object = webhookObject(payload);
  const id = typeof object.id === 'string' && object.id ? object.id : undefined;
  if (!id) return { applied: false, reason: 'missing_id' };
  const remove = async () =>
    deps.mutate(api.contacts.deleteContacts, {
      userId: row.userId,
      accountId: row.accountId,
      providerContactIds: [id],
    });
  if (/deleted/i.test(type)) {
    await remove();
  } else {
    let raw: any = Array.isArray(object.emails) ? object : null;
    if (!raw) {
      try {
        const found = await deps.retry(() =>
          deps.nylas().contacts.find({ identifier: row.grantId, contactId: id, queryParams: {} }),
        );
        raw = found.data;
      } catch (err) {
        const status = nylasErrorStatus(err);
        if ((status === 404 || status === 410) && !isGrantGoneError(err)) {
          await remove();
          raw = undefined;
        } else {
          await noteGrantFailure(row.grantId, err, deps.mutate);
          throw err;
        }
      }
    }
    if (raw !== undefined) {
      // Contact webhooks come for saved contacts; the payload names its source when it can.
      const contact = raw ? normalizeNylasContact(raw, 'address_book') : null;
      if (contact) {
        await deps.mutate(api.contacts.upsertContactBatch, {
          userId: row.userId,
          accountId: row.accountId,
          provider: row.provider,
          contacts: [contact],
        });
      } else {
        await remove();
      }
    }
  }
  await deps
    .mutate(api.contacts.markContactWebhook, { userId: row.userId, accountId: row.accountId })
    .catch(() => undefined);
  return { applied: true };
}
