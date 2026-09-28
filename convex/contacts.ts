import { v } from 'convex/values';
import {
  CONTACT_FULL_SYNC_INTERVAL_MS,
  CONTACT_SOURCE_WEIGHT,
  type ContactSource,
  DEAD_ACCOUNT_CONTACT_RETENTION_MS,
  isWeakHeaderName,
  NAMED_CONTACT_SOURCES,
  normalizeContactEmail,
  normalizeSearchText,
} from '../lib/contacts/model';
import { isNoReplyLike } from '../lib/mail/smart-categories';
import { emailFromHeader, shortFrom } from '../lib/shared/format';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';
import { contactSourceValidator } from './schema';

// Contact storage for the Nylas contact sync (lib/contacts/sync.ts runs the
// provider calls in the Next.js app). Writers skip equal rows by contentHash,
// readers see only mailboxes that are connected now, and every read returns a
// small shape.

const providerValidator = v.union(
  v.literal('google'),
  v.literal('microsoft'),
  v.literal('icloud'),
  v.literal('imap'),
);

const contactInputValidator = v.object({
  providerContactId: v.string(),
  source: contactSourceValidator,
  displayName: v.optional(v.string()),
  givenName: v.optional(v.string()),
  familyName: v.optional(v.string()),
  nickname: v.optional(v.string()),
  emails: v.array(v.object({ email: v.string(), type: v.optional(v.string()) })),
  phones: v.optional(v.array(v.object({ number: v.string(), type: v.optional(v.string()) }))),
  company: v.optional(v.string()),
  jobTitle: v.optional(v.string()),
  photoUrl: v.optional(v.string()),
  groups: v.optional(v.array(v.string())),
  searchText: v.string(),
  contentHash: v.string(),
});

const sourceResultValidator = v.object({
  source: contactSourceValidator,
  state: v.union(
    v.literal('ok'),
    v.literal('missing_scope'),
    v.literal('unsupported'),
    v.literal('capped'),
    v.literal('error'),
  ),
  count: v.optional(v.number()),
  syncedAt: v.optional(v.number()),
  error: v.optional(v.string()),
});

const statusValidator = v.union(
  v.literal('idle'),
  v.literal('syncing'),
  v.literal('ready'),
  v.literal('needs_reconnect'),
  v.literal('unsupported'),
  v.literal('error'),
);

// Bounds for one call, so no transaction nears the Convex limits.
const MAX_BATCH = 200;
const PURGE_BATCH = 200;

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function syncState(ctx: any, userId: string, accountId: string) {
  return (await ctx.db
    .query('contactSyncStates')
    .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
    .unique()) as Doc<'contactSyncStates'> | null;
}

async function userAccounts(ctx: any, userId: string): Promise<Doc<'connectedAccounts'>[]> {
  return await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q: any) => q.eq('userId', userId))
    .collect();
}

/** Account ids whose grant works now. Reads leave out contacts of other accounts. */
async function liveAccountIds(ctx: any, userId: string) {
  return new Set(
    (await userAccounts(ctx, userId))
      .filter((account) => account.status === 'connected')
      .map((account) => account.accountId),
  );
}

async function deleteEmailRows(ctx: any, contactId: Id<'contacts'>) {
  const rows = await ctx.db
    .query('contactEmails')
    .withIndex('by_contact', (q: any) => q.eq('contactId', contactId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** Deletes one contact with its address rows. Returns the number of rows removed. */
export async function deleteContactRow(ctx: any, contactId: Id<'contacts'>) {
  const removed = await deleteEmailRows(ctx, contactId);
  await ctx.db.delete(contactId);
  return removed + 1;
}

async function writeEmailRows(
  ctx: any,
  contactId: Id<'contacts'>,
  contact: Pick<Doc<'contacts'>, 'userId' | 'accountId' | 'source' | 'emails' | 'displayName'>,
) {
  await deleteEmailRows(ctx, contactId);
  const weight = CONTACT_SOURCE_WEIGHT[contact.source as ContactSource] ?? 0;
  for (const item of contact.emails) {
    await ctx.db.insert('contactEmails', {
      userId: contact.userId,
      accountId: contact.accountId,
      contactId,
      email: item.email,
      source: contact.source,
      weight,
      name: contact.displayName,
    });
  }
}

/**
 * True when the address is in one of the user's address books. Saved
 * contacts are a "real person" signal for the mail sort (convex/smart.ts).
 */
export async function isSavedContactEmail(ctx: any, userId: string, email: string) {
  const rows = await ctx.db
    .query('contactEmails')
    .withIndex('by_user_email', (q: any) => q.eq('userId', userId).eq('email', email))
    .take(8);
  return rows.some((row: Doc<'contactEmails'>) => row.source === 'address_book');
}

function contactSummary(row: Doc<'contacts'>) {
  return {
    id: row._id as string,
    accountId: row.accountId,
    source: row.source,
    name: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    nickname: row.nickname,
    emails: row.emails.slice(0, 10).map((item) => item.email),
    company: row.company,
    jobTitle: row.jobTitle,
    photoUrl: row.photoUrl,
  };
}

// ---- Sync lease and state ----------------------------------------------------

export const claimContactSync = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: providerValidator,
    leaseId: v.string(),
    leaseMs: v.number(),
    minIntervalMs: v.number(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const state = await syncState(ctx, args.userId, args.accountId);
    if (state?.leaseUntil && state.leaseUntil > ts && state.leaseId !== args.leaseId) {
      return { claimed: false, reason: 'leased' as const };
    }
    if (!args.force && state?.retryAt && state.retryAt > ts) {
      return { claimed: false, reason: 'backoff' as const, retryAt: state.retryAt };
    }
    if (!args.force && state?.lastFullSyncAt && ts - state.lastFullSyncAt < args.minIntervalMs) {
      return { claimed: false, reason: 'fresh' as const };
    }
    const patch = {
      grantId: args.grantId,
      provider: args.provider,
      status: 'syncing' as const,
      leaseId: args.leaseId,
      leaseUntil: ts + args.leaseMs,
      lastAttemptAt: ts,
      updatedAt: ts,
    };
    if (state) await ctx.db.patch(state._id, patch);
    else
      await ctx.db.insert('contactSyncStates', {
        userId: args.userId,
        accountId: args.accountId,
        ...patch,
        createdAt: ts,
      });
    return {
      claimed: true,
      reason: 'claimed' as const,
      previous: state
        ? { status: state.status, sources: state.sources ?? [], contactCount: state.contactCount }
        : null,
    };
  },
});

export const finishContactSync = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    leaseId: v.string(),
    status: statusValidator,
    sources: v.array(sourceResultValidator),
    contactCount: v.optional(v.number()),
    lastFullSyncAt: v.optional(v.number()),
    retryAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const state = await syncState(ctx, args.userId, args.accountId);
    // A newer worker owns the lease: its result wins.
    if (!state || state.leaseId !== args.leaseId) return { ok: false };
    await ctx.db.patch(state._id, {
      status: args.status,
      sources: args.sources.map((entry) => ({
        ...entry,
        error: entry.error ? truncateText(entry.error, 300) : undefined,
      })),
      contactCount: args.contactCount,
      ...(args.lastFullSyncAt ? { lastFullSyncAt: args.lastFullSyncAt } : {}),
      retryAt: args.retryAt,
      error: args.error ? truncateText(args.error, 300) : undefined,
      leaseId: undefined,
      leaseUntil: undefined,
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const markContactWebhook = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const state = await syncState(ctx, args.userId, args.accountId);
    if (!state) return { ok: false };
    await ctx.db.patch(state._id, { lastWebhookAt: now() });
    return { ok: true };
  },
});

export const listContactStates = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('contactSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId))
      .collect();
    return rows.map((row) => ({
      accountId: row.accountId,
      provider: row.provider,
      status: row.status,
      sources: row.sources ?? [],
      contactCount: row.contactCount,
      lastFullSyncAt: row.lastFullSyncAt,
      lastAttemptAt: row.lastAttemptAt,
      lastWebhookAt: row.lastWebhookAt,
      retryAt: row.retryAt,
      error: row.error,
      syncing: Boolean(row.leaseUntil && row.leaseUntil > now()),
    }));
  },
});

// ---- Contact rows --------------------------------------------------------------

export const upsertContactBatch = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    provider: providerValidator,
    contacts: v.array(contactInputValidator),
    // A webhook payload may not name its source. Then an existing row keeps
    // its stored source, so an `inbox` row never turns into a saved contact.
    preferStoredSource: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.contacts.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} contacts in one batch.`);
    const ts = now();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const contact of args.contacts) {
      const existing = await ctx.db
        .query('contacts')
        .withIndex('by_user_account_provider_id', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', args.accountId)
            .eq('providerContactId', contact.providerContactId),
        )
        .first();
      const source = args.preferStoredSource && existing ? existing.source : contact.source;
      if (existing && existing.contentHash === contact.contentHash && existing.source === source) {
        unchanged += 1;
        continue;
      }
      // Replace every optional field: a field the provider cleared must go.
      const fields = {
        userId: args.userId,
        accountId: args.accountId,
        provider: args.provider,
        source,
        providerContactId: contact.providerContactId,
        displayName: contact.displayName,
        givenName: contact.givenName,
        familyName: contact.familyName,
        nickname: contact.nickname,
        emails: contact.emails.slice(0, 20),
        phones: contact.phones,
        company: contact.company,
        jobTitle: contact.jobTitle,
        photoUrl: contact.photoUrl,
        groups: contact.groups,
        searchText: contact.searchText,
        contentHash: contact.contentHash,
        updatedAt: ts,
      };
      let id: Id<'contacts'>;
      if (existing) {
        await ctx.db.replace(existing._id, { ...fields, createdAt: existing.createdAt });
        id = existing._id;
        updated += 1;
      } else {
        id = await ctx.db.insert('contacts', { ...fields, createdAt: ts });
        inserted += 1;
      }
      await writeEmailRows(ctx, id, fields);
    }
    return { inserted, updated, unchanged };
  },
});

export const deleteContacts = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerContactIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.providerContactIds.length > MAX_BATCH) {
      throw new Error(`At most ${MAX_BATCH} contacts in one batch.`);
    }
    let deleted = 0;
    for (const providerContactId of args.providerContactIds) {
      const rows = await ctx.db
        .query('contacts')
        .withIndex('by_user_account_provider_id', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', args.accountId)
            .eq('providerContactId', providerContactId),
        )
        .collect();
      for (const row of rows) {
        await deleteContactRow(ctx, row._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

/** One page of the stored provider ids of one source, for the prune after a full pass. */
export const listContactIds = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    source: contactSourceValidator,
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('contacts')
      .withIndex('by_user_account', (q) =>
        q.eq('userId', args.userId).eq('accountId', args.accountId).eq('source', args.source),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: clampLimit(args.numItems, 500, 1_000) });
    return {
      ids: page.page.map((row) => row.providerContactId),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ---- Account retirement --------------------------------------------------------

/** Drains the contacts of one mailbox in bounded batches. */
export const purgeContactsBatch = internalMutation({
  args: { userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('contacts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .take(PURGE_BATCH);
    let deleted = 0;
    for (const row of rows) deleted += await deleteContactRow(ctx, row._id);
    if (rows.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.contacts.purgeContactsBatch, args);
    }
    return { deleted, done: rows.length < PURGE_BATCH };
  },
});

/**
 * Dead-source rule: the contacts of a mailbox that needs a reconnect stop
 * syncing at once and go after the retention time. Only an account that is
 * not connected can be retired.
 */
export const retireAccountContacts = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const account = (await userAccounts(ctx, args.userId)).find((row) => row.accountId === args.accountId);
    if (account?.status === 'connected') return { retired: false };
    const state = await syncState(ctx, args.userId, args.accountId);
    if (state) await ctx.db.delete(state._id);
    await ctx.scheduler.runAfter(0, internal.contacts.purgeContactsBatch, {
      userId: args.userId,
      accountId: args.accountId,
    });
    return { retired: true };
  },
});

// ---- Reads -------------------------------------------------------------------------

/**
 * Candidate contacts for a name or address query: full-text matches on the
 * normalized name and address words, plus address-prefix matches. The caller
 * ranks them (lib/contacts/lookup.ts).
 */
export const searchContacts = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 20, 50);
    const text = normalizeSearchText(truncateText(args.query, 200));
    if (!text) return { contacts: [] };
    const live = await liveAccountIds(ctx, args.userId);
    if (!live.size) return { contacts: [] };
    const byId = new Map<string, Doc<'contacts'>>();
    const found = await ctx.db
      .query('contacts')
      .withSearchIndex('by_search_text', (q) => q.search('searchText', text).eq('userId', args.userId))
      .take(limit * 3);
    for (const row of found) byId.set(row._id, row);
    const prefix = args.query.trim().toLowerCase();
    if (prefix.length >= 2 && !/\s/.test(prefix)) {
      const emailRows = await ctx.db
        .query('contactEmails')
        .withIndex('by_user_email', (q) =>
          q.eq('userId', args.userId).gte('email', prefix).lt('email', `${prefix}￿`),
        )
        .take(limit * 2);
      for (const row of emailRows) {
        if (byId.has(row.contactId) || !live.has(row.accountId)) continue;
        const contact = await ctx.db.get(row.contactId);
        if (contact) byId.set(contact._id, contact);
      }
    }
    return {
      contacts: [...byId.values()].filter((row) => live.has(row.accountId)).map(contactSummary),
    };
  },
});

/**
 * The best written name for each address: a saved contact first, then the
 * work directory. `inbox` names are guesses and never count.
 */
export const namesForEmails = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const emails = [
      ...new Set(args.emails.map(normalizeContactEmail).filter((email): email is string => Boolean(email))),
    ].slice(0, 300);
    if (!emails.length) return { names: [] };
    const live = await liveAccountIds(ctx, args.userId);
    if (!live.size) return { names: [] };
    const names: Array<{ email: string; name: string; source: string }> = [];
    for (const email of emails) {
      const rows = await ctx.db
        .query('contactEmails')
        .withIndex('by_user_email', (q) => q.eq('userId', args.userId).eq('email', email))
        .take(10);
      const best = rows
        .filter((row) => row.name && NAMED_CONTACT_SOURCES.has(row.source) && live.has(row.accountId))
        .sort((a, b) => b.weight - a.weight)[0];
      if (best?.name) names.push({ email, name: best.name, source: best.source });
    }
    return { names };
  },
});

/**
 * Synced contact photos for the given addresses (https only), so the avatar
 * pipeline asks Nylas only for the rest. Saved contacts win over the
 * directory, and the directory over `inbox` rows.
 */
export const photosForEmails = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const emails = [
      ...new Set(args.emails.map(normalizeContactEmail).filter((email): email is string => Boolean(email))),
    ].slice(0, 200);
    if (!emails.length) return { photos: [] };
    const live = await liveAccountIds(ctx, args.userId);
    if (!live.size) return { photos: [] };
    const photos: Array<{ email: string; url: string }> = [];
    for (const email of emails) {
      const rows = (
        await ctx.db
          .query('contactEmails')
          .withIndex('by_user_email', (q) => q.eq('userId', args.userId).eq('email', email))
          .take(5)
      )
        .filter((row) => live.has(row.accountId))
        .sort((a, b) => b.weight - a.weight);
      for (const row of rows) {
        const contact = await ctx.db.get(row.contactId);
        if (contact?.photoUrl?.startsWith('https://')) {
          photos.push({ email, url: contact.photoUrl });
          break;
        }
      }
    }
    return { photos };
  },
});

const CORRESPONDENT_SCAN = 300;

/**
 * People who wrote to the user recently, from the newest corpus threads.
 * Noise and no-reply senders are left out. Callers cache the result.
 */
export const recentCorrespondents = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 150, 300);
    const accounts = await userAccounts(ctx, args.userId);
    const self = new Set(accounts.map((account) => String(account.email || '').toLowerCase()));
    const live = new Set(
      accounts.filter((account) => account.status === 'connected').map((account) => account.accountId),
    );
    if (!live.size) return { correspondents: [] };
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(CORRESPONDENT_SCAN);
    const byEmail = new Map<string, { email: string; name?: string; lastAt: number; count: number }>();
    for (const row of rows) {
      if (!live.has(row.accountId) || row.smartPrimary === 'noise') continue;
      const header = row.fromAddress || '';
      const email = emailFromHeader(header);
      if (!email || self.has(email) || isNoReplyLike(header)) continue;
      const entry = byEmail.get(email) ?? { email, lastAt: 0, count: 0 };
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, Number(row.lastDate) || 0);
      if (!entry.name && !isWeakHeaderName(header)) entry.name = truncateText(shortFrom(header), 200);
      byEmail.set(email, entry);
    }
    return {
      correspondents: [...byEmail.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit),
    };
  },
});

// ---- Cron ----------------------------------------------------------------------------

/**
 * Users with a mailbox that is due for its daily pass, or with contacts of a
 * dead mailbox past the retention time.
 */
export const syncTargets = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ts = args.now ?? now();
    const accounts = await ctx.db.query('connectedAccounts').collect();
    const userIds = new Set<string>();
    for (const account of accounts) {
      if (userIds.has(account.userId)) continue;
      const state = await syncState(ctx, account.userId, account.accountId);
      if (account.status === 'connected') {
        const leased = Boolean(state?.leaseUntil && state.leaseUntil > ts);
        const waiting = Boolean(state?.retryAt && state.retryAt > ts);
        const fresh = Boolean(
          state?.lastFullSyncAt && ts - state.lastFullSyncAt < CONTACT_FULL_SYNC_INTERVAL_MS,
        );
        if (!leased && !waiting && !fresh) userIds.add(account.userId);
      } else if (state) {
        const lastGood = state.lastFullSyncAt ?? state.createdAt;
        if (ts - lastGood >= DEAD_ACCOUNT_CONTACT_RETENTION_MS) userIds.add(account.userId);
      }
    }
    return [...userIds];
  },
});

// Hourly. Only users with due work get a call; the app route then runs the
// pass for each due mailbox (the Nylas calls live in the app).
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[contacts-sync cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const userIds = await ctx.runQuery(internal.contacts.syncTargets, {});
    if (!userIds.length) return;
    const ok = await fanOutInternalPost(
      `${appUrl}/api/cron/contacts-sync`,
      secret,
      userIds.map((userId) => ({ userId })),
      { label: 'contacts-sync cron', concurrency: 4 },
    );
    console.log(`[contacts-sync cron] started ${ok}/${userIds.length} users`);
  },
});
