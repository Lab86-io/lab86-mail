import { v } from 'convex/values';
import { isConsumerMailbox, normalizeContactEmail, normalizeSearchText } from '../lib/contacts/model';
import {
  applyCorrespondentEvents,
  type CorrespondentEvent,
  type CorrespondentStats,
  correspondentEvents,
  correspondentScore,
  correspondentSearchText,
  groupEventsByEmail,
  type RecipientContactInput,
  rankRecipients,
} from '../lib/contacts/recipients';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// The correspondent index (see the table comment in convex/schema.ts). Two
// writers fill it, and each message counts once:
// - the corpus writer (mailCorpus.upsertCorpusBatch) counts each message it
//   inserts after the cutoff;
// - the backfill below counts each stored message made before the cutoff.
// The cutoff is set once, by whichever writer runs first.

export const CORRESPONDENT_MIGRATION = 'correspondents-v1';

async function migrationRow(ctx: any): Promise<Doc<'dataMigrations'> | null> {
  return await ctx.db
    .query('dataMigrations')
    .withIndex('by_name', (q: any) => q.eq('name', CORRESPONDENT_MIGRATION))
    .first();
}

/** The cutoff between the backfill and the corpus writer. Sets it when absent. */
export async function ensureCorrespondentCutoff(ctx: any): Promise<number> {
  const row = await migrationRow(ctx);
  const existing = Number(row?.result?.cutoff);
  if (Number.isFinite(existing) && existing > 0) return existing;
  const cutoff = now();
  if (row) await ctx.db.patch(row._id, { result: { ...(row.result || {}), cutoff }, updatedAt: cutoff });
  else
    await ctx.db.insert('dataMigrations', {
      name: CORRESPONDENT_MIGRATION,
      result: { cutoff },
      updatedAt: cutoff,
    });
  return cutoff;
}

async function selfEmails(ctx: any, userId: string): Promise<Set<string>> {
  const accounts: Doc<'connectedAccounts'>[] = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q: any) => q.eq('userId', userId))
    .collect();
  return new Set(accounts.map((account) => String(account.email || '').toLowerCase()).filter(Boolean));
}

function statsOf(row: Doc<'correspondents'>): CorrespondentStats {
  return {
    email: row.email,
    name: row.name,
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
    bulkCount: row.bulkCount,
    lastSentAt: row.lastSentAt,
    lastReceivedAt: row.lastReceivedAt,
    frecency: row.frecency,
    accounts: row.accounts,
  };
}

/** Writes the events of one batch, one row for each address. Returns the rows written. */
async function writeEvents(ctx: any, userId: string, events: CorrespondentEvent[]) {
  let written = 0;
  for (const [email, list] of groupEventsByEmail(events)) {
    const existing: Doc<'correspondents'> | null = await ctx.db
      .query('correspondents')
      .withIndex('by_user_email', (q: any) => q.eq('userId', userId).eq('email', email))
      .first();
    const next = applyCorrespondentEvents(existing ? statsOf(existing) : null, email, list);
    const fields = {
      userId,
      email,
      name: next.name,
      sentCount: next.sentCount,
      receivedCount: next.receivedCount,
      bulkCount: next.bulkCount,
      lastSentAt: next.lastSentAt,
      lastReceivedAt: next.lastReceivedAt,
      frecency: next.frecency,
      score: correspondentScore(next),
      accounts: next.accounts,
      searchText: correspondentSearchText(email, next.name),
      updatedAt: now(),
    };
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert('correspondents', fields);
    written += 1;
  }
  return written;
}

/**
 * The corpus writer's hook: count the messages that this write inserted.
 * Messages of one account only; the caller passes new rows, never updates.
 */
export async function recordInsertedMessages(
  ctx: any,
  userId: string,
  accountId: string,
  messages: Array<{
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    receivedAt?: number;
    labels?: string[];
    headers?: Record<string, unknown>;
  }>,
) {
  if (!messages.length) return 0;
  await ensureCorrespondentCutoff(ctx);
  const self = await selfEmails(ctx, userId);
  const events = messages.flatMap((message) => correspondentEvents(message, accountId, self));
  return await writeEvents(ctx, userId, events);
}

// ---- Backfill -------------------------------------------------------------------------

const totalsValidator = v.object({
  accounts: v.number(),
  messages: v.number(),
  counted: v.number(),
  events: v.number(),
  rows: v.number(),
});

async function nextLiveAccount(ctx: any, after: Doc<'connectedAccounts'> | null, userId?: string) {
  if (userId) {
    const rows: Doc<'connectedAccounts'>[] = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q: any) => q.eq('userId', userId))
      .collect();
    return (
      rows
        .filter((row) => row.status === 'connected' && (!after || row._creationTime > after._creationTime))
        .sort((a, b) => a._creationTime - b._creationTime)[0] ?? null
    );
  }
  return await ctx.db
    .query('connectedAccounts')
    .withIndex('by_status', (q: any) =>
      after
        ? q.eq('status', 'connected').gt('_creationTime', after._creationTime)
        : q.eq('status', 'connected'),
    )
    .first();
}

/**
 * One-time backfill of the correspondent index from the stored mail of
 * connected mailboxes. Each call reads one page (at most 200 messages; 50 by
 * default, because message rows carry bodies), counts the messages made
 * before the cutoff, and schedules the next page, then the next mailbox.
 * Idempotent: the cutoff splits the work with the corpus writer, the cursor
 * moves in the same transaction as the counts, and a completed run does
 * nothing. Run a dry run first (reads and counts, no writes):
 *   npx convex run correspondents:backfillCorrespondents '{"dryRun": true}'
 *   npx convex run correspondents:backfillCorrespondents '{}'
 * Add `"userId": "<clerk user id>"` for one user.
 */
export const backfillCorrespondents = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    userId: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Continuation state. The scheduler sets these; a caller leaves them out.
    accountRowId: v.optional(v.id('connectedAccounts')),
    // The creation time of that mailbox, so the walk goes on after it even
    // when its row is gone.
    accountCreationTime: v.optional(v.number()),
    cursor: v.optional(v.string()),
    totals: v.optional(totalsValidator),
  },
  handler: async (ctx, args) => {
    const dryRun = Boolean(args.dryRun);
    const continuing = Boolean(args.accountRowId);
    const migration = await migrationRow(ctx);
    if (!dryRun && !continuing && !args.userId && migration?.status === 'completed') {
      return { done: true, alreadyCompleted: true, totals: migration.result?.totals ?? null };
    }
    const cutoff = dryRun
      ? Number(migration?.result?.cutoff) > 0
        ? Number(migration?.result?.cutoff)
        : now()
      : await ensureCorrespondentCutoff(ctx);
    const progressRow = dryRun || args.userId ? null : await migrationRow(ctx);
    const totals = args.totals ?? { accounts: 0, messages: 0, counted: 0, events: 0, rows: 0 };
    let account: Doc<'connectedAccounts'> | null = args.accountRowId
      ? await ctx.db.get(args.accountRowId)
      : null;
    // The page cursor belongs to the mailbox in accountRowId only.
    let cursor = args.cursor ?? null;
    if (!account || account.status !== 'connected') {
      // A removed or paused mailbox: go on after it, never from the first
      // mailbox again, and start the next mailbox at its first page.
      const after =
        account ??
        (args.accountCreationTime !== undefined
          ? ({ _creationTime: args.accountCreationTime } as Doc<'connectedAccounts'>)
          : null);
      account = await nextLiveAccount(ctx, after, args.userId);
      cursor = null;
      if (account && args.accountRowId !== account._id) totals.accounts += 1;
    }
    const finish = async () => {
      console.log(
        `[correspondents backfill] ${args.userId ? `user ${args.userId}` : 'all users'}: ${totals.accounts} mailboxes, ${totals.messages} messages, ${totals.counted} before the cutoff, ${totals.events} events, ${totals.rows} row writes${dryRun ? ' (dry run)' : ''}`,
      );
      if (!dryRun && !args.userId) {
        const row = await migrationRow(ctx);
        if (row)
          await ctx.db.patch(row._id, {
            status: 'completed',
            completedAt: now(),
            cursor: undefined,
            result: { ...(row.result || {}), totals },
            updatedAt: now(),
          });
      }
      return { done: true, totals };
    };
    if (!account) return await finish();
    const current = account;

    const page = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_received', (q) =>
        q.eq('userId', current.userId).eq('accountId', current.accountId),
      )
      .paginate({
        cursor,
        numItems: Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200),
      });
    const self = await selfEmails(ctx, current.userId);
    const counted = page.page.filter((message) => message._creationTime < cutoff);
    const events = counted.flatMap((message) => correspondentEvents(message, current.accountId, self));
    totals.messages += page.page.length;
    totals.counted += counted.length;
    totals.events += events.length;
    if (dryRun) totals.rows += groupEventsByEmail(events).size;
    else totals.rows += await writeEvents(ctx, current.userId, events);

    let next: { accountRowId: Id<'connectedAccounts'>; accountCreationTime: number; cursor?: string } | null =
      null;
    if (!page.isDone)
      next = {
        accountRowId: current._id,
        accountCreationTime: current._creationTime,
        cursor: page.continueCursor,
      };
    else {
      const following = await nextLiveAccount(ctx, current, args.userId);
      if (following) {
        totals.accounts += 1;
        next = { accountRowId: following._id, accountCreationTime: following._creationTime };
      }
    }
    if (!next) return await finish();
    if (progressRow) {
      await ctx.db.patch(progressRow._id, { status: 'running', cursor: next.cursor, updatedAt: now() });
    }
    await ctx.scheduler.runAfter(0, internal.correspondents.backfillCorrespondents, {
      dryRun: args.dryRun,
      userId: args.userId,
      limit: args.limit,
      ...next,
      totals,
    });
    return { done: false, totals };
  },
});

// ---- Account removal ------------------------------------------------------------------

/**
 * Removes one mailbox's part of the index after the mailbox is removed. A row
 * that only this mailbox made goes; other rows lose its counts, and their
 * frecency shrinks by the same share.
 */
export const purgeAccountCorrespondents = internalMutation({
  args: { userId: v.string(), accountId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('correspondents')
      .withIndex('by_user_email', (q) => q.eq('userId', args.userId))
      .paginate({ cursor: args.cursor ?? null, numItems: 200 });
    let deleted = 0;
    let updated = 0;
    for (const row of page.page) {
      const part = row.accounts.find((entry) => entry.accountId === args.accountId);
      if (!part) continue;
      const accounts = row.accounts.filter((entry) => entry.accountId !== args.accountId);
      if (!accounts.length) {
        await ctx.db.delete(row._id);
        deleted += 1;
        continue;
      }
      const total = row.sentCount + row.receivedCount;
      const sentCount = Math.max(0, row.sentCount - part.sent);
      const receivedCount = Math.max(0, row.receivedCount - part.received);
      const share = total > 0 ? Math.max(sentCount + receivedCount, 1) / total : 1;
      const next = {
        ...statsOf(row),
        sentCount,
        receivedCount,
        bulkCount: Math.min(row.bulkCount, receivedCount),
        frecency: row.frecency + Math.log(share),
        accounts,
      };
      await ctx.db.patch(row._id, {
        sentCount: next.sentCount,
        receivedCount: next.receivedCount,
        bulkCount: next.bulkCount,
        frecency: next.frecency,
        score: correspondentScore(next),
        accounts,
        updatedAt: now(),
      });
      updated += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.correspondents.purgeAccountCorrespondents, {
        userId: args.userId,
        accountId: args.accountId,
        cursor: page.continueCursor,
      });
    }
    return { deleted, updated, done: page.isDone };
  },
});

// ---- Recipient search -----------------------------------------------------------------

const TOP_SCAN = 150;
const SEARCH_TAKE = 40;
const PREFIX_TAKE = 20;
const CONTACT_LINKS = 60;

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Ranked recipients for the To, Cc, and Bcc fields: the correspondent index
 * and the synced contacts in one query (lib/contacts/recipients.ts ranks).
 * Every read is an index range or a search index with a small take.
 */
export const suggestRecipients = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    query: v.string(),
    fromAccountId: v.optional(v.string()),
    limit: v.optional(v.number()),
    exclude: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = args.now ?? now();
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 8), 1), 20);
    const text = truncateText(args.query.trim(), 200);
    const normalized = normalizeSearchText(text);
    const raw = text.toLowerCase();
    const exclude = (args.exclude || []).slice(0, 50).map((email) => email.trim().toLowerCase());

    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const live = new Set(accounts.filter((row) => row.status === 'connected').map((row) => row.accountId));
    const selfEmails = accounts.map((row) => String(row.email || '').toLowerCase()).filter(Boolean);
    const from = accounts.find((row) => row.accountId === args.fromAccountId);
    const workDomains = (from ? [from] : accounts.filter((row) => row.status === 'connected'))
      .map((row) => String(row.email || '').toLowerCase())
      .filter((email) => email.includes('@') && !isConsumerMailbox(email))
      .map((email) => email.split('@')[1]);

    const rows = new Map<string, Doc<'correspondents'>>();
    const add = (list: Doc<'correspondents'>[]) => {
      for (const row of list) rows.set(row.email, row);
    };
    add(
      await ctx.db
        .query('correspondents')
        .withIndex('by_user_score', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(normalized ? TOP_SCAN : limit * 3 + exclude.length + selfEmails.length),
    );
    const contacts = new Map<string, Doc<'contacts'>>();
    const addContact = (row: Doc<'contacts'> | null) => {
      if (row && live.has(row.accountId)) contacts.set(row._id, row);
    };
    const typed = normalizeContactEmail(text);
    if (normalized) {
      add(
        await ctx.db
          .query('correspondents')
          .withSearchIndex('by_search_text', (q) =>
            q.search('searchText', normalized).eq('userId', args.userId),
          )
          .take(SEARCH_TAKE),
      );
      for (const row of await ctx.db
        .query('contacts')
        .withSearchIndex('by_search_text', (q) =>
          q.search('searchText', normalized).eq('userId', args.userId),
        )
        .take(SEARCH_TAKE))
        addContact(row);
      if (!/\s/.test(raw) && raw.length >= 1) {
        add(
          await ctx.db
            .query('correspondents')
            .withIndex('by_user_email', (q) =>
              q.eq('userId', args.userId).gte('email', raw).lt('email', `${raw}￿`),
            )
            .take(PREFIX_TAKE),
        );
        const emailRows = await ctx.db
          .query('contactEmails')
          .withIndex('by_user_email', (q) =>
            q.eq('userId', args.userId).gte('email', raw).lt('email', `${raw}￿`),
          )
          .take(PREFIX_TAKE);
        for (const row of emailRows)
          if (!contacts.has(row.contactId)) addContact(await ctx.db.get(row.contactId));
      }
    }
    if (typed && !rows.has(typed)) {
      const row = await ctx.db
        .query('correspondents')
        .withIndex('by_user_email', (q) => q.eq('userId', args.userId).eq('email', typed))
        .first();
      if (row) add([row]);
    }

    // Link the best correspondents to their saved contacts, so a frequent
    // person shows the saved name and collapses their other addresses.
    const linkEmails = [...rows.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, CONTACT_LINKS)
      .map((row) => row.email);
    for (const email of linkEmails) {
      const links = await ctx.db
        .query('contactEmails')
        .withIndex('by_user_email', (q) => q.eq('userId', args.userId).eq('email', email))
        .take(4);
      for (const link of links)
        if (!contacts.has(link.contactId)) addContact(await ctx.db.get(link.contactId));
    }
    // Stats for the addresses of matched contacts that the scans missed.
    for (const contact of [...contacts.values()].slice(0, SEARCH_TAKE)) {
      for (const item of contact.emails.slice(0, 5)) {
        if (rows.has(item.email)) continue;
        const row = await ctx.db
          .query('correspondents')
          .withIndex('by_user_email', (q) => q.eq('userId', args.userId).eq('email', item.email))
          .first();
        if (row) add([row]);
      }
    }

    const contactInputs: RecipientContactInput[] = [...contacts.values()].map((row) => ({
      id: row._id,
      accountId: row.accountId,
      source: row.source,
      name: row.displayName,
      emails: row.emails.map((item) => item.email),
      company: row.company,
      jobTitle: row.jobTitle,
      photoUrl: row.photoUrl,
    }));
    const items = rankRecipients({
      query: text,
      now: ts,
      correspondents: [...rows.values()].map(statsOf),
      contacts: contactInputs,
      selfEmails,
      fromAccountId: args.fromAccountId,
      workDomains,
      exclude,
      limit,
    });
    return { query: text, items: items.map(withoutUndefined) };
  },
});
