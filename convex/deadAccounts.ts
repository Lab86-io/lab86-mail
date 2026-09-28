// @ts-nocheck
import { v } from 'convex/values';
import { bodyHashHasBody } from '../lib/mail/corpus-body';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { now } from './lib';
import schema from './schema';

// Dead-account purge (connections audit, section 4 item 2). A mailbox whose
// sign-in stays broken still holds its whole corpus: in production 81% of the
// stored mail belonged to four dead grants. After 30 days in `error`, the
// daily cron deletes the corpus of the account in bounded batches. The
// account row stays, so Settings still shows "Reconnect", and a reconnect
// starts a fresh backfill (the purge deletes the sync states first).

const DAY_MS = 86_400_000;
export const DEAD_ACCOUNT_PURGE_AFTER_MS = 30 * DAY_MS;

/**
 * Tables that hold the corpus of one mailbox, each read through a
 * `(userId, accountId)` prefix index. `cap` bounds the rows of one table in
 * one pass: a message row can hold a large body. A table that is not in the
 * schema is skipped, so `mailCorpusBodies` (the body table of the io-core
 * branch) is purged as soon as it exists, with a `by_user_account` index.
 */
export const DEAD_ACCOUNT_TABLES = [
  { table: 'mailCorpusBodies', index: 'by_user_account', cap: 25 },
  { table: 'mailCorpusMessages', index: 'by_user_account', cap: 40 },
  { table: 'mailCorpusThreads', index: 'by_user_account', cap: 200 },
  { table: 'mailLabelMembership', index: 'by_user_account', cap: 250 },
  { table: 'calendarEvents', index: 'by_user_account', cap: 250 },
  { table: 'mailWebhookEvents', index: 'by_user_account', cap: 50 },
  { table: 'mailSnoozes', index: 'by_user_account', cap: 250 },
  { table: 'mailOneTimeCodes', index: 'by_user_account', cap: 250 },
] as const;

/** Small per-account state rows. They go first, so a reconnect during the purge backfills fresh. */
export const DEAD_ACCOUNT_STATE_TABLES = ['mailSyncStates', 'calendarSyncStates', 'calendars'] as const;

// Documents deleted in one pass, over all tables.
const PASS_LIMIT = 250;
// A content item takes up to ~34 vector chunks with it.
const CONTENT_ITEMS_PER_PASS = 5;
// Rows read for each table by the dry-run report.
const REPORT_SAMPLE = 100;
// Accounts in `error` read by one page of each scan. The tick and the
// backfill chain their pages; the report returns a cursor. A backfill row
// costs one query and one patch, and a report row reads a message sample.
const TICK_PAGE = 100;
const BACKFILL_PAGE = 50;
const REPORT_PAGE = 2;
const REPORT_PAGE_MAX = 10;

const presentTables = new Set(Object.keys(schema.tables));

function corpusTables() {
  return DEAD_ACCOUNT_TABLES.filter((entry) => presentTables.has(entry.table));
}

/** When the account became dead: `errorSince`, else the row's last update. */
export function deadSince(account: { errorSince?: number; updatedAt: number }) {
  return account.errorSince ?? account.updatedAt;
}

/** True when the account is in `error`, not purged yet, and dead for the purge time. */
export function isPurgeDue(
  account: { status: string; errorSince?: number; updatedAt: number; corpusPurgedAt?: number },
  ts: number,
) {
  return (
    account.status === 'error' &&
    !account.corpusPurgedAt &&
    ts - deadSince(account) >= DEAD_ACCOUNT_PURGE_AFTER_MS
  );
}

async function accountRow(ctx, userId: string, accountId: string) {
  return ctx.db
    .query('connectedAccounts')
    .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', accountId))
    .unique();
}

function byAccount(ctx, table: string, index: string, userId: string, accountId: string) {
  return ctx.db.query(table).withIndex(index, (q) => q.eq('userId', userId).eq('accountId', accountId));
}

function errorAccountPage(ctx, cursor: string | null | undefined, numItems: number) {
  return ctx.db
    .query('connectedAccounts')
    .withIndex('by_status', (q) => q.eq('status', 'error'))
    .paginate({ cursor: cursor ?? null, numItems });
}

function contentRows(ctx, userId: string, accountId: string) {
  return ctx.db
    .query('contentItems')
    .withIndex('by_user_connection', (q) => q.eq('userId', userId).eq('connectionId', accountId));
}

/**
 * One bounded purge pass for one dead account. The chain belongs to one
 * error period: `errorSince` as the tick saw it (null for a row from before
 * the field). A manual first call pins the current period. A pass stops
 * when the account is no longer in `error` (a reconnect), or when its error
 * period changed (a reconnect and a new error while the chain waited), so a
 * new period gets its own 30 days. The last pass marks the account row with
 * `corpusPurgedAt` and removes the account's share of the recipient counts.
 * Each pass that deletes rows schedules the next one for the same period.
 */
export const purgeDeadAccountBatch = internalMutation({
  args: {
    userId: v.string(),
    accountId: v.string(),
    errorSince: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const account = await accountRow(ctx, args.userId, args.accountId);
    if (!account || account.status !== 'error') return { deleted: 0, stopped: 'not_dead' };
    const period = args.errorSince === undefined ? (account.errorSince ?? null) : args.errorSince;
    if ((account.errorSince ?? null) !== period) return { deleted: 0, stopped: 'error_period_changed' };
    let deleted = 0;
    const byTable: Record<string, number> = {};
    const note = (table: string, count: number) => {
      if (!count) return;
      byTable[table] = (byTable[table] ?? 0) + count;
      deleted += count;
    };

    for (const table of DEAD_ACCOUNT_STATE_TABLES) {
      const rows = await byAccount(ctx, table, 'by_user_account', args.userId, args.accountId).collect();
      for (const row of rows) await ctx.db.delete(row._id);
      note(table, rows.length);
    }

    for (const entry of corpusTables()) {
      if (deleted >= PASS_LIMIT) break;
      const rows = await byAccount(ctx, entry.table, entry.index, args.userId, args.accountId).take(
        Math.min(entry.cap, PASS_LIMIT - deleted),
      );
      for (const row of rows) await ctx.db.delete(row._id);
      note(entry.table, rows.length);
    }

    if (deleted < PASS_LIMIT) {
      const items = await contentRows(ctx, args.userId, args.accountId).take(CONTENT_ITEMS_PER_PASS);
      for (const item of items) {
        const chunks = await ctx.db
          .query('contentChunks')
          .withIndex('by_item', (q) => q.eq('itemId', item._id))
          .collect();
        for (const chunk of chunks) await ctx.db.delete(chunk._id);
        await ctx.db.delete(item._id);
        note('contentChunks', chunks.length);
        note('contentItems', 1);
      }
    }

    if (deleted > 0) {
      await ctx.scheduler.runAfter(0, internal.deadAccounts.purgeDeadAccountBatch, {
        userId: args.userId,
        accountId: args.accountId,
        errorSince: period,
      });
      return { deleted, byTable, done: false };
    }
    await ctx.db.patch(account._id, { corpusPurgedAt: now() });
    await ctx.scheduler.runAfter(0, internal.correspondents.purgeAccountCorrespondents, {
      userId: args.userId,
      accountId: args.accountId,
    });
    return { deleted: 0, byTable, done: true };
  },
});

/**
 * Daily: start one purge chain for each account that has been dead for 30
 * days. It reads the accounts in `error` in pages; each page schedules the
 * next one. With `dryRun`, it lists the due accounts of one page, returns
 * the cursor of the next page, and changes nothing.
 */
export const purgeDeadAccountsTick = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const ts = args.now ?? now();
    const page = await errorAccountPage(ctx, args.cursor, TICK_PAGE);
    const due = page.page.filter((row) => isPurgeDue(row, ts));
    if (!args.dryRun) {
      for (const row of due)
        await ctx.scheduler.runAfter(0, internal.deadAccounts.purgeDeadAccountBatch, {
          userId: row.userId,
          accountId: row.accountId,
          errorSince: row.errorSince ?? null,
        });
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, internal.deadAccounts.purgeDeadAccountsTick, {
          cursor: page.continueCursor,
          ...(args.now === undefined ? {} : { now: args.now }),
        });
    }
    return {
      dryRun: Boolean(args.dryRun),
      scheduled: args.dryRun ? 0 : due.length,
      accounts: due.map((row) => ({
        userId: row.userId,
        accountId: row.accountId,
        email: row.email,
        deadSince: deadSince(row),
        errorSinceKnown: row.errorSince !== undefined,
        errorSinceSource: row.errorSinceSource ?? null,
      })),
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Dry-run report: for each account in `error`, whether the purge is due, and
 * how many rows each table holds. It reads a page of accounts (2 by default,
 * at most 10) and returns the cursor of the next page. Counts read at most
 * 100 rows a table, so a count of 100 means "100 or more". It reads no body
 * document: the body count is the number of sampled messages whose body
 * hash names a body. It changes nothing.
 */
export const deadAccountReport = internalQuery({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ts = args.now ?? now();
    const numItems = Math.min(Math.max(Math.floor(args.numItems ?? REPORT_PAGE), 1), REPORT_PAGE_MAX);
    const page = await errorAccountPage(ctx, args.cursor, numItems);
    const accounts = [];
    for (const row of page.page) {
      const counts: Record<string, number> = {};
      for (const entry of corpusTables()) {
        if (entry.table === 'mailCorpusBodies') continue;
        const rows = await byAccount(ctx, entry.table, entry.index, row.userId, row.accountId).take(
          REPORT_SAMPLE,
        );
        counts[entry.table] = rows.length;
        if (entry.table === 'mailCorpusMessages')
          counts.mailCorpusBodies = rows.filter((message) => bodyHashHasBody(message.bodyHash)).length;
      }
      counts.contentItems = (await contentRows(ctx, row.userId, row.accountId).take(REPORT_SAMPLE)).length;
      const since = deadSince(row);
      accounts.push({
        userId: row.userId,
        accountId: row.accountId,
        email: row.email,
        deadSince: since,
        deadDays: Math.floor((ts - since) / DAY_MS),
        errorSinceKnown: row.errorSince !== undefined,
        errorSinceSource: row.errorSinceSource ?? null,
        purgeDue: isPurgeDue(row, ts),
        corpusPurgedAt: row.corpusPurgedAt ?? null,
        counts,
        countCap: REPORT_SAMPLE,
      });
    }
    return { accounts, isDone: page.isDone, continueCursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * One-time, run by hand only (no cron calls it): set `errorSince` on
 * accounts that went to `error` before the field existed. Production set
 * those rows to `error` on 2026-09-27, but their mail sync failed 55 to 108
 * days before, and the owner chose to purge them now. So the time comes from
 * the last successful mail sync (the newest of `lastIncrementalSyncAt` and
 * `lastBackfillAt` on the mail sync state), and never later than the row's
 * `updatedAt`. With no sync record, `updatedAt` stays the time. It reads
 * only accounts that are in `error` now, skips rows that have `errorSince`,
 * and records the source in `errorSinceSource`. It works in pages that
 * chain. A dry run reports one page and its cursor, and changes nothing.
 */
export const backfillErrorSince = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await errorAccountPage(ctx, args.cursor, BACKFILL_PAGE);
    const updates = [];
    for (const row of page.page) {
      if (row.status !== 'error' || row.errorSince !== undefined) continue;
      const state = await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user_account', (q) => q.eq('userId', row.userId).eq('accountId', row.accountId))
        .unique();
      const lastGood = Math.max(
        Number(state?.lastIncrementalSyncAt) || 0,
        Number(state?.lastBackfillAt) || 0,
      );
      const errorSince = lastGood > 0 ? Math.min(lastGood, row.updatedAt) : row.updatedAt;
      const source = lastGood > 0 ? ('last_mail_sync' as const) : ('updated_at' as const);
      updates.push({ userId: row.userId, accountId: row.accountId, email: row.email, errorSince, source });
      if (!args.dryRun) await ctx.db.patch(row._id, { errorSince, errorSinceSource: source });
    }
    if (!args.dryRun && !page.isDone)
      await ctx.scheduler.runAfter(0, internal.deadAccounts.backfillErrorSince, {
        cursor: page.continueCursor,
      });
    return {
      dryRun: Boolean(args.dryRun),
      updated: args.dryRun ? 0 : updates.length,
      accounts: updates,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
