import { v } from 'convex/values';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import { internalMutation, mutation } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Google Cross-Account Protection (RISC), the Convex side (docs/google-risc.md).
//
// The app verifies each Security Event Token (lib/google/risc.ts) and sends
// its events here. This module:
// - records one row for each `jti`, so a second delivery does nothing;
// - finds the Google connections of the subject: direct mail grants
//   (providerGrants) and Google Drive connections (cloudFileConnections), by
//   the Google account id (`sub`), by email when there is no `sub`, or by a
//   refresh token identifier for `token-revoked`;
// - with `apply` (LAB86_GOOGLE_RISC=1 in the app), changes those
//   connections and writes one audit row for each change. Without it, it
//   records the number of matches only.
//
// Albatross does not revoke a token here: Google revoked it already.

const GOOGLE_GRANT_PREFIX = 'google:';
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MATCH_LIMIT = 20;
const SWEEP_BATCH = 100;

// The reconnect reason format of lib/nylas/grant-health.ts. Settings and the
// Rail show "Reconnect" for an error that starts with this prefix.
const RECONNECT = 'Reconnect needed';

/** The text that the user sees on a connection after each action. */
export const SECURITY_REASONS = {
  revoke: `${RECONNECT}: Google stopped the access to this account. Reconnect it to use it again.`,
  hold: `${RECONNECT}: Google locked this account because of a risk. Reconnect it after Google unlocks the account.`,
  release: `${RECONNECT}: Google unlocked this account. Reconnect it to use it again.`,
  reconnect: `${RECONNECT}: Google tells you to change the password of this account. Change it, then reconnect the account.`,
} as const;

const actionValidator = v.union(
  v.literal('revoke'),
  v.literal('hold'),
  v.literal('release'),
  v.literal('reconnect'),
  v.literal('log'),
);

type Action = 'revoke' | 'hold' | 'release' | 'reconnect' | 'log';

const subjectValidator = v.object({
  sub: v.optional(v.string()),
  email: v.optional(v.string()),
  tokenPrefixHash: v.optional(v.string()),
  tokenDoubleHash: v.optional(v.string()),
});

type Subject = {
  sub?: string;
  email?: string;
  tokenPrefixHash?: string;
  tokenDoubleHash?: string;
};

function isDirectGrant(grantId: unknown): grantId is string {
  return typeof grantId === 'string' && grantId.startsWith(GOOGLE_GRANT_PREFIX);
}

function addresses(email: string) {
  const trimmed = email.trim();
  return [...new Set([trimmed, trimmed.toLowerCase()])].filter(Boolean);
}

/** The direct mail token rows of the subject. Each row must be the live grant of its account. */
async function mailTargets(ctx: any, subject: Subject) {
  const rows = new Map<string, any>();
  const add = async (row: any) => {
    if (!row || !isDirectGrant(row.grantId) || rows.has(String(row._id))) return;
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q: any) => q.eq('userId', row.userId).eq('accountId', row.accountId))
      .unique();
    if (!account || account.grantId !== row.grantId || account.status === 'disconnected') return;
    rows.set(String(row._id), { grant: row, account });
  };
  const byIndex = async (index: string, field: string, value: string | undefined) => {
    if (!value) return;
    const found = await ctx.db
      .query('providerGrants')
      .withIndex(index, (q: any) => q.eq(field, value))
      .take(MATCH_LIMIT);
    for (const row of found) await add(row);
  };
  if (subject.tokenPrefixHash || subject.tokenDoubleHash) {
    await byIndex('by_refresh_prefix_hash', 'refreshTokenPrefixHash', subject.tokenPrefixHash);
    await byIndex('by_refresh_double_hash', 'refreshTokenDoubleHash', subject.tokenDoubleHash);
    return [...rows.values()];
  }
  if (subject.sub) {
    await byIndex('by_google_sub', 'googleSub', subject.sub);
  } else if (subject.email) {
    // Email only when the event has no `sub`: an address can move to another
    // Google account, a `sub` cannot.
    for (const value of addresses(subject.email)) {
      const accounts = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_email', (q: any) => q.eq('email', value))
        .take(MATCH_LIMIT);
      for (const account of accounts) {
        if (account.provider !== 'google' || !isDirectGrant(account.grantId)) continue;
        const grant = await ctx.db
          .query('providerGrants')
          .withIndex('by_user_account', (q: any) =>
            q.eq('userId', account.userId).eq('accountId', account.accountId),
          )
          .unique();
        await add(grant);
      }
    }
  }
  return [...rows.values()];
}

/** The Google Drive connections of the subject, with their credential rows. */
async function driveTargets(ctx: any, subject: Subject) {
  const rows = new Map<string, any>();
  const add = async (connection: any) => {
    if (!connection || connection.provider !== 'google_drive' || connection.status === 'disconnected') return;
    if (rows.has(String(connection._id))) return;
    const credentials = await ctx.db
      .query('cloudFileCredentials')
      .withIndex('by_user_connection', (q: any) =>
        q.eq('userId', connection.userId).eq('connectionId', connection.connectionId),
      )
      .unique();
    rows.set(String(connection._id), { connection, credentials });
  };
  if (subject.tokenPrefixHash || subject.tokenDoubleHash) {
    for (const [index, field, value] of [
      ['by_refresh_prefix_hash', 'refreshTokenPrefixHash', subject.tokenPrefixHash],
      ['by_refresh_double_hash', 'refreshTokenDoubleHash', subject.tokenDoubleHash],
    ] as const) {
      if (!value) continue;
      const credentials = await ctx.db
        .query('cloudFileCredentials')
        .withIndex(index, (q: any) => q.eq(field, value))
        .take(MATCH_LIMIT);
      for (const row of credentials) {
        if (row.provider !== 'google_drive') continue;
        const connection = await ctx.db
          .query('cloudFileConnections')
          .withIndex('by_user_connection', (q: any) =>
            q.eq('userId', row.userId).eq('connectionId', row.connectionId),
          )
          .unique();
        await add(connection);
      }
    }
    return [...rows.values()];
  }
  if (subject.sub) {
    const found = await ctx.db
      .query('cloudFileConnections')
      .withIndex('by_google_sub', (q: any) => q.eq('googleSub', subject.sub))
      .take(MATCH_LIMIT);
    for (const connection of found) await add(connection);
  } else if (subject.email) {
    for (const value of addresses(subject.email)) {
      const found = await ctx.db
        .query('cloudFileConnections')
        .withIndex('by_account_email', (q: any) => q.eq('accountEmail', value))
        .take(MATCH_LIMIT);
      for (const connection of found) await add(connection);
    }
  }
  return [...rows.values()];
}

/** Puts a mail account in "Reconnect needed" with the reason. Sync skips an account in `error`. */
async function markAccount(ctx: any, account: any, reason: string, ts: number) {
  await ctx.db.patch(account._id, {
    status: 'error' as const,
    error: reason,
    ...(account.status === 'connected' && account.errorSince === undefined
      ? { errorSince: ts, errorSinceSource: 'status_change' as const }
      : {}),
    updatedAt: ts,
  });
}

/** Applies one action to one mail target. Returns the audit action, or null for no change. */
async function applyMail(ctx: any, target: any, action: Action, eventName: string, ts: number) {
  const { grant, account } = target;
  if (action === 'revoke' || action === 'hold') {
    await ctx.db.patch(grant._id, {
      accessTokenEncrypted: undefined,
      refreshTokenEncrypted: undefined,
      expiresAt: undefined,
      refreshTokenPrefixHash: undefined,
      refreshTokenDoubleHash: undefined,
      securityEvent: eventName,
      ...(action === 'hold' ? { securityHoldAt: ts } : {}),
      updatedAt: ts,
    });
    await markAccount(ctx, account, SECURITY_REASONS[action], ts);
    return action === 'hold' ? 'tokens_deleted_hold_set' : 'tokens_deleted';
  }
  if (action === 'reconnect') {
    await ctx.db.patch(grant._id, { securityEvent: eventName, updatedAt: ts });
    await markAccount(ctx, account, SECURITY_REASONS.reconnect, ts);
    return 'reconnect_marked';
  }
  if (action === 'release') {
    if (grant.securityHoldAt === undefined) return null;
    await ctx.db.patch(grant._id, { securityHoldAt: undefined, securityEvent: eventName, updatedAt: ts });
    if (account.status === 'error' && account.error === SECURITY_REASONS.hold) {
      await ctx.db.patch(account._id, { error: SECURITY_REASONS.release, updatedAt: ts });
    }
    return 'hold_cleared';
  }
  return null;
}

/** Applies one action to one Drive target. Returns the audit action, or null for no change. */
async function applyDrive(ctx: any, target: any, action: Action, eventName: string, ts: number) {
  const { connection, credentials } = target;
  if (action === 'revoke' || action === 'hold') {
    if (credentials) await ctx.db.delete(credentials._id);
    await ctx.db.patch(connection._id, {
      status: 'error' as const,
      error: SECURITY_REASONS[action],
      lastError: SECURITY_REASONS[action],
      securityEvent: eventName,
      ...(action === 'hold' ? { securityHoldAt: ts } : {}),
      updatedAt: ts,
    });
    return action === 'hold' ? 'tokens_deleted_hold_set' : 'tokens_deleted';
  }
  if (action === 'reconnect') {
    await ctx.db.patch(connection._id, {
      status: 'error' as const,
      error: SECURITY_REASONS.reconnect,
      lastError: SECURITY_REASONS.reconnect,
      securityEvent: eventName,
      updatedAt: ts,
    });
    return 'reconnect_marked';
  }
  if (action === 'release') {
    if (connection.securityHoldAt === undefined) return null;
    await ctx.db.patch(connection._id, {
      securityHoldAt: undefined,
      securityEvent: eventName,
      ...(connection.status === 'error' && connection.error === SECURITY_REASONS.hold
        ? { error: SECURITY_REASONS.release, lastError: SECURITY_REASONS.release }
        : {}),
      updatedAt: ts,
    });
    return 'hold_cleared';
  }
  return null;
}

/**
 * Records one verified Security Event Token and, with `apply`, acts on it.
 * Idempotent by `jti`: a second delivery returns `duplicate: true` and
 * changes nothing.
 */
export const recordSecurityEvent = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    jti: v.string(),
    issuedAt: v.optional(v.number()),
    apply: v.boolean(),
    events: v.array(
      v.object({
        type: v.string(),
        name: v.string(),
        action: actionValidator,
        reason: v.optional(v.string()),
        subject: subjectValidator,
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const jti = truncateText(args.jti.trim(), 256);
    const seen = await ctx.db
      .query('googleSecurityEvents')
      .withIndex('by_jti', (q) => q.eq('jti', jti))
      .first();
    if (seen) {
      return { duplicate: true, matchedMail: 0, matchedDrive: 0, applied: 0, forgetGrantIds: [] as string[] };
    }
    const ts = now();
    const expiresAt = ts + RETENTION_MS;
    let matchedMail = 0;
    let matchedDrive = 0;
    let applied = 0;
    const forgetGrantIds = new Set<string>();
    for (const event of args.events.slice(0, 10)) {
      const mail = await mailTargets(ctx, event.subject);
      const drive = await driveTargets(ctx, event.subject);
      matchedMail += mail.length;
      matchedDrive += drive.length;
      if (!args.apply || event.action === 'log') continue;
      for (const target of mail) {
        const done = await applyMail(ctx, target, event.action, event.name, ts);
        if (!done) continue;
        applied += 1;
        if (event.action === 'revoke' || event.action === 'hold') forgetGrantIds.add(target.grant.grantId);
        await ctx.db.insert('googleSecurityAudit', {
          userId: target.grant.userId,
          jti,
          eventName: event.name,
          target: 'mail',
          accountId: target.grant.accountId,
          action: done,
          createdAt: ts,
          expiresAt,
        });
      }
      for (const target of drive) {
        const done = await applyDrive(ctx, target, event.action, event.name, ts);
        if (!done) continue;
        applied += 1;
        await ctx.db.insert('googleSecurityAudit', {
          userId: target.connection.userId,
          jti,
          eventName: event.name,
          target: 'drive',
          connectionId: target.connection.connectionId,
          action: done,
          createdAt: ts,
          expiresAt,
        });
      }
    }
    await ctx.db.insert('googleSecurityEvents', {
      jti,
      eventNames: args.events.slice(0, 10).map((event) => truncateText(event.name, 64)),
      ...(args.issuedAt !== undefined ? { issuedAt: args.issuedAt } : {}),
      receivedAt: ts,
      mode: args.apply ? 'applied' : 'logged',
      matchedMail,
      matchedDrive,
      applied,
      expiresAt,
    });
    return { duplicate: false, matchedMail, matchedDrive, applied, forgetGrantIds: [...forgetGrantIds] };
  },
});

/** Deletes expired event and audit rows in batches. A daily cron runs it (convex/crons.ts). */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    let deleted = 0;
    let more = false;
    for (const table of ['googleSecurityEvents', 'googleSecurityAudit'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_expires', (q) => q.lte('expiresAt', ts))
        .take(SWEEP_BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
      if (rows.length === SWEEP_BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.googleSecurity.sweepExpired, {});
    return { deleted };
  },
});

const BACKFILL_PAGE = 100;

/**
 * One-time fill of `googleSub` on Google Drive connections from before the
 * field. The Drive `accountKey` is the `id` of Google's userinfo, which is
 * the same Google account id as `sub`. Idempotent; a dry run writes nothing.
 * Token refreshes fill the field too (cloudFiles.updateCredentials).
 *   npx convex run googleSecurity:backfillDriveGoogleSub '{"dryRun": true}'
 */
export const backfillDriveGoogleSub = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    scanned: v.optional(v.number()),
    changed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = Boolean(args.dryRun);
    let scanned = args.scanned ?? 0;
    let changed = args.changed ?? 0;
    const page = await ctx.db
      .query('cloudFileConnections')
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_PAGE });
    for (const row of page.page) {
      scanned += 1;
      const sub = driveGoogleSub(row);
      if (!sub || row.googleSub) continue;
      changed += 1;
      if (!dryRun) await ctx.db.patch(row._id, { googleSub: sub });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.googleSecurity.backfillDriveGoogleSub, {
        dryRun: args.dryRun,
        cursor: page.continueCursor,
        scanned,
        changed,
      });
      return { scanned, changed, dryRun, done: false };
    }
    console.log(`[drive google sub] scanned ${scanned}, changed ${changed}${dryRun ? ' (dry run)' : ''}`);
    return { scanned, changed, dryRun, done: true };
  },
});

/** The Google account id of a Drive connection: its `accountKey` when that is a Google numeric id. */
export function driveGoogleSub(row: { provider?: string; accountKey?: string }) {
  return row.provider === 'google_drive' && /^\d{5,64}$/.test(row.accountKey || '')
    ? row.accountKey
    : undefined;
}
