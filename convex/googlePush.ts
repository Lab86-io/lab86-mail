import { v } from 'convex/values';
import {
  calendarAccountPushHealthy,
  drivePageToken,
  type GooglePushTiming,
  gmailPushHealthy,
  pushMessageWriteDue,
} from '../lib/google/push/rules';
import { internal } from './_generated/api';
import { internalAction, internalQuery, mutation, type QueryCtx, query } from './_generated/server';
import { contentPreferences } from './content';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

// Direct Google push (docs/google-direct-transport.md, "Push"): the state of
// the Gmail watches and the Calendar and Drive channels, the lookups of the
// push routes, the poll health, and the renewal cron. The app makes all
// Google calls; Convex keeps the rows. The channel token is stored only as a
// SHA-256 hash, and no function here returns the hash except the one lookup
// that the push route uses to check a message.

const GOOGLE_GRANT_PREFIX = 'google:';
// The first string after every `google:...` id in index order (':' + 1).
const GOOGLE_GRANT_END = 'google;';
const MAX_USER_ROWS = 500;
const MAX_TARGET_ROWS = 5000;
const ERROR_MAX_LENGTH = 300;

const kindValidator = v.union(v.literal('gmail'), v.literal('calendar'), v.literal('drive'));

function isDirectGrant(grantId: string | undefined): grantId is string {
  return typeof grantId === 'string' && grantId.startsWith(GOOGLE_GRANT_PREFIX);
}

/** The fields of a row that leave Convex. The token hash stays. */
function planRow(row: any) {
  const { _id, _creationTime, tokenHash: _tokenHash, ...rest } = row;
  return rest;
}

type ReadCtx = Pick<QueryCtx, 'db'>;

async function channelRow(ctx: ReadCtx, channelId: string) {
  return await ctx.db
    .query('googlePushChannels')
    .withIndex('by_channel', (q) => q.eq('channelId', channelId))
    .first();
}

async function gmailRow(ctx: ReadCtx, userId: string, accountId: string) {
  const rows = await ctx.db
    .query('googlePushChannels')
    .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', accountId))
    .take(MAX_USER_ROWS);
  return rows.find((row) => row.kind === 'gmail') ?? null;
}

async function directAccounts(ctx: ReadCtx, userId: string) {
  const rows = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  return rows.filter((row) => row.provider === 'google' && isDirectGrant(row.grantId));
}

// ---------------------------------------------------------------------------
// Renewal plan and registration
// ---------------------------------------------------------------------------

/**
 * What the renewal of one user needs: the direct Google accounts, the
 * calendars of the connected ones, the Google Drive connections with their
 * stored change position, and the push rows.
 */
export const userPlan = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const accounts = (await directAccounts(ctx, args.userId)).map((row) => ({
      accountId: row.accountId,
      grantId: row.grantId,
      email: row.email,
      status: row.status,
    }));
    const live = new Set(accounts.filter((row) => row.status === 'connected').map((row) => row.accountId));
    const calendars = live.size
      ? (
          await ctx.db
            .query('calendars')
            .withIndex('by_user', (q) => q.eq('userId', args.userId))
            .collect()
        )
          .filter((row) => live.has(row.accountId))
          .map((row) => ({ accountId: row.accountId, calendarId: row.providerCalendarId }))
      : [];
    const driveConnections = (
      await ctx.db
        .query('cloudFileConnections')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect()
    ).filter((row) => row.provider === 'google_drive');
    const drives = await Promise.all(
      driveConnections.map(async (row) => {
        const sync = await ctx.db
          .query('contentSync')
          .withIndex('by_user_connection', (q) =>
            q.eq('userId', args.userId).eq('connectionId', row.connectionId),
          )
          .unique();
        const pageToken = drivePageToken(sync?.cursor);
        return { connectionId: row.connectionId, status: row.status, ...(pageToken ? { pageToken } : {}) };
      }),
    );
    const channels = await ctx.db
      .query('googlePushChannels')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(MAX_USER_ROWS);
    return {
      accounts,
      calendars,
      drives,
      contentEnabled: (await contentPreferences(ctx, args.userId)).enabled,
      channels: channels.map(planRow),
    };
  },
});

/**
 * Writes the row of a watch call before the call. Google can send the first
 * message before the call returns, and the push route must find the row. A
 * Gmail mailbox keeps one row: a renewal moves its request time. A Calendar
 * or Drive channel gets a new row with a new id and a new token hash.
 */
export const beginRegistration = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: kindValidator,
    channelId: v.string(),
    accountId: v.optional(v.string()),
    grantId: v.optional(v.string()),
    calendarId: v.optional(v.string()),
    connectionId: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    if (args.kind === 'gmail') {
      if (!args.accountId) throw new Error('A Gmail watch needs an account.');
      const existing = await gmailRow(ctx, args.userId, args.accountId);
      if (existing) {
        // The old watch keeps working until the new call returns, but only
        // for the same grant.
        const keep = existing.status === 'active' && existing.grantId === args.grantId;
        await ctx.db.patch(existing._id, {
          grantId: args.grantId,
          requestedAt: ts,
          status: keep ? 'active' : 'pending',
          updatedAt: ts,
        });
        return { channelId: existing.channelId, requestedAt: ts };
      }
    } else if (!args.tokenHash || !/^[a-f0-9]{64}$/.test(args.tokenHash)) {
      throw new Error('A channel needs the SHA-256 hash of its token.');
    }
    if (await channelRow(ctx, args.channelId)) throw new Error('The channel id is in use.');
    const { internalSecret: _secret, ...fields } = args;
    await ctx.db.insert('googlePushChannels', {
      ...fields,
      status: 'pending',
      requestedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
    return { channelId: args.channelId, requestedAt: ts };
  },
});

/** Writes the result of a watch call. */
export const finishRegistration = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    channelId: v.string(),
    outcome: v.union(v.literal('active'), v.literal('failed')),
    resourceId: v.optional(v.string()),
    expiration: v.optional(v.number()),
    historyId: v.optional(v.string()),
    error: v.optional(v.string()),
    retryAfter: v.optional(v.number()),
    unsupported: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await channelRow(ctx, args.channelId);
    if (!row || row.userId !== args.userId) return { updated: false };
    const ts = now();
    if (args.outcome === 'active') {
      if (typeof args.expiration !== 'number') throw new Error('An active watch needs its expiration.');
      await ctx.db.patch(row._id, {
        status: 'active',
        expiration: args.expiration,
        renewedAt: ts,
        failures: 0,
        lastError: undefined,
        retryAfter: undefined,
        unsupported: undefined,
        ...(args.resourceId ? { resourceId: args.resourceId } : {}),
        ...(args.historyId ? { historyId: args.historyId } : {}),
        updatedAt: ts,
      });
      return { updated: true };
    }
    // A failed Gmail renewal keeps a watch that still works.
    const stillLive =
      row.kind === 'gmail' &&
      row.status === 'active' &&
      typeof row.expiration === 'number' &&
      row.expiration > ts;
    await ctx.db.patch(row._id, {
      status: stillLive ? 'active' : 'failed',
      failures: (row.failures ?? 0) + 1,
      lastError: args.error?.slice(0, ERROR_MAX_LENGTH),
      retryAfter: args.retryAfter,
      ...(args.unsupported ? { unsupported: true } : {}),
      updatedAt: ts,
    });
    return { updated: true };
  },
});

/** Deletes rows of one user by channel id. The caller stops the channels at Google first. */
export const removeChannels = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), channelIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    let removed = 0;
    for (const channelId of new Set(args.channelIds.slice(0, MAX_USER_ROWS))) {
      const row = await channelRow(ctx, channelId);
      if (!row || row.userId !== args.userId) continue;
      await ctx.db.delete(row._id);
      removed += 1;
    }
    return { removed };
  },
});

// ---------------------------------------------------------------------------
// Push routes
// ---------------------------------------------------------------------------

/** The row of a Calendar or Drive channel, with the token hash, for the check of a message. */
export const channelForPush = query({
  args: { internalSecret: v.optional(v.string()), channelId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await channelRow(ctx, args.channelId);
    if (!row || row.kind === 'gmail' || !row.tokenHash) return null;
    return {
      userId: row.userId,
      kind: row.kind,
      channelId: row.channelId,
      accountId: row.accountId,
      calendarId: row.calendarId,
      connectionId: row.connectionId,
      resourceId: row.resourceId,
      tokenHash: row.tokenHash,
      status: row.status,
    };
  },
});

function messageWrite(row: any, ts: number) {
  return pushMessageWriteDue(row as GooglePushTiming, ts) ? { lastMessageAt: ts, updatedAt: ts } : null;
}

/** Notes a checked message of a Calendar or Drive channel. Writes at most every few minutes. */
export const recordChannelMessage = mutation({
  args: { internalSecret: v.optional(v.string()), channelId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await channelRow(ctx, args.channelId);
    if (!row) return { recorded: false };
    const patch = messageWrite(row, now());
    if (patch) await ctx.db.patch(row._id, patch);
    return { recorded: Boolean(patch) };
  },
});

/** The connected direct Google accounts of one Gmail address, of all users. */
export const gmailPushTargets = query({
  args: { internalSecret: v.optional(v.string()), email: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const email = args.email.trim();
    if (!email) return [];
    const out = new Map<string, { userId: string; accountId: string }>();
    for (const value of new Set([email, email.toLowerCase()])) {
      const rows = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_email', (q) => q.eq('email', value))
        .take(50);
      for (const row of rows) {
        if (row.provider !== 'google' || row.status !== 'connected' || !isDirectGrant(row.grantId)) continue;
        out.set(`${row.userId}\n${row.accountId}`, { userId: row.userId, accountId: row.accountId });
      }
    }
    return [...out.values()];
  },
});

/** Notes a checked Gmail push for one mailbox. Writes at most every few minutes. */
export const recordGmailPush = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await gmailRow(ctx, args.userId, args.accountId);
    if (!row) return { recorded: false };
    const patch = messageWrite(row, now());
    if (patch) await ctx.db.patch(row._id, patch);
    return { recorded: Boolean(patch) };
  },
});

// ---------------------------------------------------------------------------
// Stop on disconnect
// ---------------------------------------------------------------------------

/**
 * The Gmail watch and Calendar channels of one direct grant, before the grant
 * goes. `sharedMailbox` is true when another connected direct account (of any
 * user) has the same address: a Gmail stop ends the watch of the mailbox for
 * this project, so it would end the push of that account too.
 */
export const stopPlanForGrant = query({
  args: { internalSecret: v.optional(v.string()), grantId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!isDirectGrant(args.grantId)) return null;
    const channels = await ctx.db
      .query('googlePushChannels')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .take(MAX_USER_ROWS);
    if (!channels.length) return null;
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .first();
    let sharedMailbox = false;
    if (account?.email) {
      for (const value of new Set([account.email, account.email.toLowerCase()])) {
        const others = await ctx.db
          .query('connectedAccounts')
          .withIndex('by_email', (q) => q.eq('email', value))
          .take(50);
        sharedMailbox ||= others.some(
          (row) =>
            row.grantId !== args.grantId &&
            row.provider === 'google' &&
            row.status === 'connected' &&
            isDirectGrant(row.grantId),
        );
      }
    }
    return { userId: channels[0].userId, sharedMailbox, channels: channels.map(planRow) };
  },
});

/** The Drive channels of one connection, before the connection goes. */
export const channelsForConnection = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), connectionId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('googlePushChannels')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(MAX_USER_ROWS);
    return rows.filter((row) => row.kind === 'drive' && row.connectionId === args.connectionId).map(planRow);
  },
});

// ---------------------------------------------------------------------------
// Poll back-off
// ---------------------------------------------------------------------------

/**
 * The connected direct accounts of one user, with their calendar push health
 * and calendar sync state. The calendar cron skips the hot poll of a healthy
 * account (lib/google/push/calendar-poll.ts).
 */
export const calendarPollPlan = query({
  // The caller passes the time: a query result must not depend on a clock
  // that Convex does not see (a cached result would get old).
  args: { internalSecret: v.optional(v.string()), userId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = args.now;
    const accounts = (await directAccounts(ctx, args.userId)).filter((row) => row.status === 'connected');
    if (!accounts.length) return [];
    const channels = (
      await ctx.db
        .query('googlePushChannels')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(MAX_USER_ROWS)
    ).filter((row) => row.kind === 'calendar');
    return await Promise.all(
      accounts.map(async (account) => {
        const calendars = await ctx.db
          .query('calendars')
          .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', account.accountId))
          .collect();
        const state = await ctx.db
          .query('calendarSyncStates')
          .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', account.accountId))
          .unique();
        const rows = channels.filter(
          (row) => row.accountId === account.accountId && row.grantId === account.grantId,
        );
        return {
          accountId: account.accountId,
          healthy: calendarAccountPushHealthy(
            calendars.map((row) => row.providerCalendarId),
            rows,
            ts,
          ),
          state: state
            ? {
                lastSyncedAt: state.lastSyncedAt,
                lastFullSyncAt: state.lastFullSyncAt,
                windowEnd: state.windowEnd,
              }
            : null,
        };
      }),
    );
  },
});

/**
 * `userId:accountId` of each mailbox whose Gmail push is healthy. The History
 * cron reads these mailboxes only on their fallback tick.
 */
export const healthyGmailAccounts = internalQuery({
  // The caller passes the time, for the same reason as calendarPollPlan.
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const ts = args.now;
    const rows = await ctx.db
      .query('googlePushChannels')
      .withIndex('by_kind_status', (q) => q.eq('kind', 'gmail').eq('status', 'active'))
      .take(MAX_TARGET_ROWS);
    return rows.filter((row) => gmailPushHealthy(row, ts)).map((row) => `${row.userId}:${row.accountId}`);
  },
});

// ---------------------------------------------------------------------------
// Renewal cron
// ---------------------------------------------------------------------------

/**
 * The users that the renewal looks at: users with a connected direct Google
 * account, users with a connected Google Drive connection, and users with
 * push rows. `hasChannels` lets the app skip a user when all push flags are
 * off and the user has no rows to stop.
 */
export const renewalTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = new Map<string, boolean>();
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.gte('grantId', GOOGLE_GRANT_PREFIX).lt('grantId', GOOGLE_GRANT_END))
      .take(MAX_TARGET_ROWS);
    for (const row of accounts) if (row.status === 'connected') users.set(row.userId, false);
    const drives = await ctx.db
      .query('cloudFileConnections')
      .withIndex('by_status', (q) => q.eq('status', 'connected'))
      .take(MAX_TARGET_ROWS);
    for (const row of drives) if (row.provider === 'google_drive') users.set(row.userId, false);
    const channels = await ctx.db.query('googlePushChannels').take(MAX_TARGET_ROWS);
    for (const row of channels) users.set(row.userId, true);
    return [...users].map(([userId, hasChannels]) => ({ userId, hasChannels }));
  },
});

/** Every hour: ask the app to make, renew, and stop the push of each target user. */
export const renewalTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ requested: number; ok: number }> => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[google-push cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return { requested: 0, ok: 0 };
    }
    const targets: Array<{ userId: string; hasChannels: boolean }> = await ctx.runQuery(
      internal.googlePush.renewalTargets,
      {},
    );
    if (!targets.length) return { requested: 0, ok: 0 };
    const ok = await fanOutInternalPost(`${appUrl}/api/cron/google-push`, secret, targets, {
      label: 'google-push cron',
    });
    return { requested: targets.length, ok };
  },
});
