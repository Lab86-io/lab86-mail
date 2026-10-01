import { v } from 'convex/values';
import { gmailPollDue } from '../lib/google/push/rules';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';
import { cancelHeldSends } from './mailOutbox';

// Direct Google transport (docs/google-direct-transport.md): the sign-in
// state, the account switch and rollback, the token row, the History sync
// targets, and scheduled sends for Google accounts that talk to Gmail without
// Nylas. The grant id of such an account is `google:<random UUID>`: one id for
// each (userId, accountId) connection. Two users can share one accountId, so
// the grant id never holds it, and no two rows may share a direct grant id.

const GOOGLE_GRANT_PREFIX = 'google:';
// The first string after every `google:...` id in index order (':' + 1).
const GOOGLE_GRANT_END = 'google;';
const CLEANUP_BATCH_SIZE = 100;

const modeValidator = v.union(v.literal('switch'), v.literal('new'), v.literal('reconnect'));

function isDirectGrant(grantId: string | undefined): grantId is string {
  return typeof grantId === 'string' && grantId.startsWith(GOOGLE_GRANT_PREFIX);
}

const SHARED_GRANT = 'Two connections share one direct Google grant id.';

/**
 * The one token row of a direct grant id, or null. Two rows with one id is a
 * broken state; the call refuses it, so one user never gets another user's
 * token.
 */
async function soleGrantRow(ctx: any, grantId: string) {
  const rows = await ctx.db
    .query('providerGrants')
    .withIndex('by_grant', (q: any) => q.eq('grantId', grantId))
    .take(2);
  if (rows.length > 1) throw new Error(SHARED_GRANT);
  const row = rows[0] ?? null;
  if (!row) return null;
  // The account row of the same connection must name the same grant.
  const account = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user_account', (q: any) => q.eq('userId', row.userId).eq('accountId', row.accountId))
    .unique();
  return account && account.grantId === grantId ? row : null;
}

/** True when a row other than `keep` uses this grant id. */
async function grantIdInUse(ctx: any, grantId: string, keep: { userId: string; accountId: string }) {
  const other = (row: { userId: string; accountId: string }) =>
    row.userId !== keep.userId || row.accountId !== keep.accountId;
  for (const table of ['connectedAccounts', 'providerGrants'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_grant', (q: any) => q.eq('grantId', grantId))
      .take(5);
    if (rows.some(other)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sign-in state
// ---------------------------------------------------------------------------

export const saveOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    mode: modeValidator,
    accountId: v.optional(v.string()),
    redirectTo: v.optional(v.string()),
    nativeCallback: v.optional(v.boolean()),
    codeVerifierEncrypted: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { internalSecret: _secret, ...row } = args;
    await ctx.db.insert('googleMailOAuthStates', { ...row, createdAt: now() });
    await ctx.scheduler.runAfter(
      Math.max(0, args.expiresAt - now()),
      internal.googleDirect.sweepExpiredOAuthStates,
      {},
    );
    return { ok: true };
  },
});

// The callback can arrive without a session cookie. The state is random,
// single use, short lived, and this mutation needs the server secret.
export const consumeOAuthState = mutation({
  args: { internalSecret: v.optional(v.string()), state: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('googleMailOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return {
      userId: row.userId,
      mode: row.mode,
      accountId: row.accountId,
      redirectTo: row.redirectTo,
      nativeCallback: row.nativeCallback,
      codeVerifierEncrypted: row.codeVerifierEncrypted,
    };
  },
});

export const sweepExpiredOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('googleMailOAuthStates')
      .withIndex('by_expires', (q) => q.lte('expiresAt', now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.googleDirect.sweepExpiredOAuthStates, {});
    }
    return { deleted: expired.length };
  },
});

// ---------------------------------------------------------------------------
// Token row
// ---------------------------------------------------------------------------

/** The encrypted Google tokens of one direct grant. */
/**
 * True when another live Google connection of any user in this deployment
 * uses the address: a mail account (Nylas or direct) other than
 * `exceptGrantId`, or a Google Drive connection other than
 * `exceptConnectionId`. A Google revoke ends the access of the whole Google
 * Cloud project for that address, so it would end those connections too
 * (lib/google/shared-grant.ts).
 */
export const googleAccessUsesAddress = query({
  args: {
    internalSecret: v.optional(v.string()),
    email: v.string(),
    exceptGrantId: v.optional(v.string()),
    exceptConnectionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const email = args.email.trim();
    if (!email) return false;
    for (const value of new Set([email, email.toLowerCase()])) {
      const accounts = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_email', (q) => q.eq('email', value))
        .take(50);
      if (
        accounts.some(
          (row) =>
            row.provider === 'google' && row.status !== 'disconnected' && row.grantId !== args.exceptGrantId,
        )
      ) {
        return true;
      }
      const drives = await ctx.db
        .query('cloudFileConnections')
        .withIndex('by_account_email', (q) => q.eq('accountEmail', value))
        .take(50);
      if (
        drives.some(
          (row) =>
            row.provider === 'google_drive' &&
            row.status !== 'disconnected' &&
            row.connectionId !== args.exceptConnectionId,
        )
      ) {
        return true;
      }
    }
    return false;
  },
});

export const getGrantCredentials = query({
  args: { internalSecret: v.optional(v.string()), grantId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!isDirectGrant(args.grantId)) return null;
    const row = await soleGrantRow(ctx, args.grantId);
    if (!row) return null;
    return {
      userId: row.userId,
      accountId: row.accountId,
      email: row.email,
      scopes: row.scopes,
      accessTokenEncrypted: row.accessTokenEncrypted,
      refreshTokenEncrypted: row.refreshTokenEncrypted,
      expiresAt: row.expiresAt,
      previousNylasGrantId: row.previousNylasGrantId,
      googleSub: row.googleSub,
    };
  },
});

/**
 * Stores a refreshed access token (and a rotated refresh token, if any) on the
 * token row of one connection. The row must still hold this grant id.
 */
export const saveGrantAccessToken = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    accessTokenEncrypted: v.string(),
    expiresAt: v.number(),
    refreshTokenEncrypted: v.optional(v.string()),
    // Google Cross-Account Protection (convex/googleSecurity.ts): the Google
    // account id, filled once for a grant from before the field, and the
    // identifiers of the refresh token in use.
    googleSub: v.optional(v.string()),
    refreshTokenPrefixHash: v.optional(v.string()),
    refreshTokenDoubleHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!isDirectGrant(args.grantId)) return { updated: 0 };
    const row = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!row || row.grantId !== args.grantId) return { updated: 0 };
    // A Google security event deleted the tokens during this refresh: the
    // row stays without them until the user signs in again.
    if (!row.refreshTokenEncrypted) return { updated: 0 };
    await ctx.db.patch(row._id, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      expiresAt: args.expiresAt,
      ...(args.refreshTokenEncrypted ? { refreshTokenEncrypted: args.refreshTokenEncrypted } : {}),
      ...(args.googleSub && !row.googleSub ? { googleSub: args.googleSub } : {}),
      ...(args.refreshTokenPrefixHash ? { refreshTokenPrefixHash: args.refreshTokenPrefixHash } : {}),
      ...(args.refreshTokenDoubleHash ? { refreshTokenDoubleHash: args.refreshTokenDoubleHash } : {}),
      updatedAt: now(),
    });
    return { updated: 1 };
  },
});

/**
 * Deletes the token row of one direct grant (grants.destroy), and cancels the
 * held scheduled sends of that connection (`cancelledSends` counts the first
 * batch; scheduled passes cancel the rest). Returns the Nylas grant that the
 * connection used before the switch, so the caller can destroy it too, but
 * only when no other connection still uses that Nylas grant. The connected
 * account row is not touched here.
 */
export const removeGrant = mutation({
  args: { internalSecret: v.optional(v.string()), grantId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const none = { removed: 0, previousNylasGrantIds: [] as string[], cancelledSends: 0 };
    if (!isDirectGrant(args.grantId)) return none;
    const row = await soleGrantRow(ctx, args.grantId);
    if (!row) return none;
    // A held scheduled send of this mailbox goes with the grant: the message
    // must not stay stored after a disconnect. The account removal does the
    // same, for the case where this step fails.
    const cancelledSends = await cancelHeldSends(ctx, row.userId, row.accountId);
    await ctx.db.delete(row._id);
    const previousNylasGrantIds: string[] = [];
    const previous = row.previousNylasGrantId;
    if (previous) {
      const stillUsed =
        (await grantIdInUse(ctx, previous, row)) ||
        (
          await ctx.db
            .query('providerGrants')
            .withIndex('by_previous_nylas_grant', (q) => q.eq('previousNylasGrantId', previous))
            .take(5)
        ).some((other) => other._id !== row._id);
      if (!stillUsed) previousNylasGrantIds.push(previous);
    }
    return { removed: 1, previousNylasGrantIds, cancelledSends };
  },
});

/**
 * The account that used this Nylas grant before it switched to Google. Nylas
 * webhooks for that grant are ignored: the History sync owns the mailbox now.
 */
export const accountForPreviousNylasGrant = query({
  args: { internalSecret: v.optional(v.string()), grantId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('providerGrants')
      .withIndex('by_previous_nylas_grant', (q) => q.eq('previousNylasGrantId', args.grantId))
      .first();
    if (!row || !isDirectGrant(row.grantId)) return null;
    return { userId: row.userId, accountId: row.accountId, grantId: row.grantId };
  },
});

// ---------------------------------------------------------------------------
// Switch, connect, reconnect, and rollback
// ---------------------------------------------------------------------------

async function patchSyncStateGrants(
  ctx: any,
  userId: string,
  accountId: string,
  grantId: string,
  ts: number,
  mailPatch: Record<string, unknown> = {},
) {
  const mail = await ctx.db
    .query('mailSyncStates')
    .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
    .unique();
  if (mail) {
    await ctx.db.patch(mail._id, {
      grantId,
      // A sync error that the dead grant left goes away with the new grant.
      ...(mail.status === 'error'
        ? { status: mail.corpusReady ? ('ready' as const) : ('idle' as const), error: undefined }
        : {}),
      ...mailPatch,
      updatedAt: ts,
    });
  }
  for (const table of ['calendarSyncStates', 'contactSyncStates'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
      .collect();
    for (const row of rows) await ctx.db.patch(row._id, { grantId, updatedAt: ts });
  }
  return mail;
}

/**
 * Makes a Google account talk to Gmail directly. `switch` and `reconnect`
 * name an account; `new` matches an account of the same user by email, and
 * creates one when there is none. An existing account keeps its accountId and
 * its corpus, so nothing is fetched or classified again. The Nylas grant id
 * stays on the token row (`previousNylasGrantId`) for a rollback.
 */
export const activateGoogleAccount = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    mode: modeValidator,
    accountId: v.optional(v.string()),
    // The account id for a new account and the grant id for a new direct
    // connection. The app makes both (random UUIDs).
    newAccountId: v.string(),
    newGrantId: v.string(),
    email: v.string(),
    displayName: v.optional(v.string()),
    scopes: v.array(v.string()),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.string(),
    expiresAt: v.number(),
    historyId: v.string(),
    // Google Cross-Account Protection (convex/googleSecurity.ts).
    googleSub: v.optional(v.string()),
    refreshTokenPrefixHash: v.optional(v.string()),
    refreshTokenDoubleHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const email = args.email.trim().toLowerCase();
    const ts = now();
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    let existing = args.accountId ? accounts.find((row) => row.accountId === args.accountId) : undefined;
    if (args.mode !== 'new') {
      if (!existing) throw new Error('The account to switch was not found.');
      if (existing.provider !== 'google') throw new Error('Only a Google account can use Gmail directly.');
      if (existing.email.toLowerCase() !== email) {
        throw new Error('The Google account does not match the connected account.');
      }
    } else {
      existing = accounts.find((row) => row.provider === 'google' && row.email.toLowerCase() === email);
    }

    const accountId = existing?.accountId ?? args.newAccountId;
    const priorGrantId = existing?.grantId;
    // A reconnect keeps the grant id of the connection; a switch or a new
    // connection gets the new one. Either way no other row may use it.
    const grantId = isDirectGrant(priorGrantId) ? priorGrantId : args.newGrantId;
    if (!isDirectGrant(grantId)) throw new Error('A direct Google grant id is required.');
    if (await grantIdInUse(ctx, grantId, { userId: args.userId, accountId })) throw new Error(SHARED_GRANT);
    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', accountId))
      .unique();
    // Keep the first Nylas grant: a reconnect of a direct account must not
    // lose the way back.
    const previousNylasGrantId =
      priorGrantId && !isDirectGrant(priorGrantId) ? priorGrantId : grant?.previousNylasGrantId;

    const accountPatch = {
      email,
      provider: 'google' as const,
      status: 'connected' as const,
      scopes: args.scopes,
      grantId,
      error: undefined,
      errorSince: undefined,
      errorSinceSource: undefined,
      corpusPurgedAt: undefined,
      updatedAt: ts,
      ...(args.displayName && !existing?.displayName ? { displayName: args.displayName } : {}),
    };
    if (existing) await ctx.db.patch(existing._id, accountPatch);
    else
      await ctx.db.insert('connectedAccounts', {
        userId: args.userId,
        accountId,
        ...accountPatch,
        createdAt: ts,
      });

    // A switch from a Nylas grant starts the age that the Nylas grant cleanup
    // reads. A reconnect keeps the time of the first switch.
    const switchedFromNylas = Boolean(priorGrantId && !isDirectGrant(priorGrantId));
    const grantPatch = {
      provider: 'google',
      grantId,
      email,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      previousNylasGrantId,
      ...(switchedFromNylas ? { switchedToGoogleAt: ts, nylasGrantRevokedAt: undefined } : {}),
      // A new sign-in replaces the token identifiers and ends a security
      // hold: Google let the user sign in.
      ...(args.googleSub ? { googleSub: args.googleSub } : {}),
      refreshTokenPrefixHash: args.refreshTokenPrefixHash,
      refreshTokenDoubleHash: args.refreshTokenDoubleHash,
      securityHoldAt: undefined,
      securityEvent: undefined,
      updatedAt: ts,
    };
    if (grant) await ctx.db.patch(grant._id, grantPatch);
    else
      await ctx.db.insert('providerGrants', {
        userId: args.userId,
        accountId,
        ...grantPatch,
        createdAt: ts,
      });

    // A switch starts the History sync at the current mailbox state. A
    // reconnect keeps the stored point, so the changes of the dead period
    // still come in (a point that is too old makes the sync reconcile).
    const mail = await patchSyncStateGrants(ctx, args.userId, accountId, grantId, ts, {});
    if (mail) {
      if (!mail.historyId || !isDirectGrant(priorGrantId)) {
        await ctx.db.patch(mail._id, { historyId: args.historyId });
      }
    } else {
      await ctx.db.insert('mailSyncStates', {
        userId: args.userId,
        accountId,
        grantId,
        provider: 'google',
        status: 'idle',
        corpusReady: false,
        historyId: args.historyId,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    const outcome = !existing
      ? ('created' as const)
      : isDirectGrant(priorGrantId)
        ? ('reconnected' as const)
        : ('switched' as const);
    return { accountId, grantId, outcome, previousNylasGrantId };
  },
});

/**
 * Puts a switched account back on its Nylas grant. The corpus stays. The
 * Google tokens are deleted from the row; they are not revoked, because
 * Google can revoke the whole project grant, and that would include the Nylas
 * grant. Run it from the Convex dashboard: googleDirect:rollbackToNylas.
 */
export const rollbackToNylas = internalMutation({
  args: { userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    const ts = now();
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!account || !grant) return { ok: false as const, reason: 'The account was not found.' };
    if (!isDirectGrant(account.grantId)) return { ok: false as const, reason: 'The account uses Nylas.' };
    const nylasGrantId = grant.previousNylasGrantId;
    if (!nylasGrantId) {
      return {
        ok: false as const,
        reason: grant.nylasGrantDeletePending
          ? 'The Nylas grant cleanup holds the Nylas grant and can delete it now.'
          : grant.nylasGrantRevokedAt
            ? 'The Nylas grant cleanup deleted the Nylas grant. Connect the account through Nylas again.'
            : 'The account has no Nylas grant to go back to.',
      };
    }
    await ctx.db.patch(account._id, {
      grantId: nylasGrantId,
      status: 'connected',
      error: undefined,
      errorSince: undefined,
      errorSinceSource: undefined,
      updatedAt: ts,
    });
    await ctx.db.patch(grant._id, {
      grantId: nylasGrantId,
      accessTokenEncrypted: undefined,
      refreshTokenEncrypted: undefined,
      expiresAt: undefined,
      previousNylasGrantId: undefined,
      switchedToGoogleAt: undefined,
      updatedAt: ts,
    });
    await patchSyncStateGrants(ctx, args.userId, args.accountId, nylasGrantId, ts, { historyId: undefined });
    return { ok: true as const, grantId: nylasGrantId };
  },
});

// ---------------------------------------------------------------------------
// Nylas grant cleanup (docs/google-direct-transport.md, "Cleanup")
// ---------------------------------------------------------------------------

/** The most token rows that one cleanup plan reads. */
const NYLAS_CLEANUP_PLAN_LIMIT = 500;
/** The most rows that can keep one Nylas grant (one mailbox under a few users). */
const NYLAS_CLEANUP_HOLDER_LIMIT = 20;

type NylasCleanupConnection = {
  userId: string;
  accountId: string;
  email: string;
  grantId: string;
  switchedToGoogleAt: number | null;
};

type NylasCleanupItem = {
  nylasGrantId: string | null;
  eligible: boolean;
  reason?: string;
  connections: NylasCleanupConnection[];
};

/** The fields of a token row that the cleanup report shows. No token. */
function cleanupConnection(row: any): NylasCleanupConnection {
  return {
    userId: row.userId,
    accountId: row.accountId,
    email: row.email,
    grantId: row.grantId,
    switchedToGoogleAt: typeof row.switchedToGoogleAt === 'number' ? row.switchedToGoogleAt : null,
  };
}

/**
 * The reason that the Nylas grant of this token row must stay, or null. The
 * connection must use its direct grant (account row and token row) and be
 * connected: a direct connection in an error state can need the rollback.
 */
async function directConnectionRefusal(ctx: any, row: any) {
  if (!isDirectGrant(row.grantId)) return 'The account does not use a direct Google grant (google:...).';
  const account = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user_account', (q: any) => q.eq('userId', row.userId).eq('accountId', row.accountId))
    .unique();
  if (!account || account.grantId !== row.grantId) {
    return 'The account row does not use the direct Google grant of its token row.';
  }
  if (account.status !== 'connected') {
    return `The direct connection has status "${account.status}". Keep the Nylas grant for a rollback.`;
  }
  return null;
}

/**
 * One Nylas grant and the connections that keep it. The grant can go only
 * when no connection is on it now and every connection that keeps it for a
 * rollback passes `refusal` (it returns the reason to keep the grant).
 */
async function nylasCleanupItem(
  ctx: any,
  nylasGrantId: string,
  refusal: (row: any) => Promise<string | null>,
): Promise<NylasCleanupItem> {
  const rows = await ctx.db
    .query('providerGrants')
    .withIndex('by_previous_nylas_grant', (q: any) => q.eq('previousNylasGrantId', nylasGrantId))
    .take(NYLAS_CLEANUP_HOLDER_LIMIT + 1);
  const holders = rows.slice(0, NYLAS_CLEANUP_HOLDER_LIMIT);
  const item = { nylasGrantId, connections: holders.map(cleanupConnection) };
  // The claim holds at most the limit. A row past it would keep a dead grant
  // for its rollback, so such a grant stays.
  if (rows.length > NYLAS_CLEANUP_HOLDER_LIMIT) {
    return {
      ...item,
      eligible: false,
      reason: `More than ${NYLAS_CLEANUP_HOLDER_LIMIT} connections keep this Nylas grant.`,
    };
  }
  if (isDirectGrant(nylasGrantId)) {
    return { ...item, eligible: false, reason: 'The kept grant id is a direct Google grant id.' };
  }
  for (const table of ['connectedAccounts', 'providerGrants'] as const) {
    const inUse = await ctx.db
      .query(table)
      .withIndex('by_grant', (q: any) => q.eq('grantId', nylasGrantId))
      .first();
    if (inUse) return { ...item, eligible: false, reason: 'A connection still uses this Nylas grant.' };
  }
  for (const holder of holders) {
    const reason = await refusal(holder);
    if (reason) return { ...item, eligible: false, reason };
  }
  return { ...item, eligible: true };
}

const cleanupTargetArgs = {
  userId: v.optional(v.string()),
  accountId: v.optional(v.string()),
  switchedBefore: v.optional(v.number()),
};

type CleanupTarget =
  | { kind: 'account'; userId: string; accountId: string }
  | { kind: 'age'; switchedBefore: number };

/** One account (`userId` and `accountId`), or all switches before `switchedBefore`. Not both. */
function cleanupTarget(args: {
  userId?: string;
  accountId?: string;
  switchedBefore?: number;
}): CleanupTarget {
  if (args.userId !== undefined || args.accountId !== undefined) {
    if (!args.userId || !args.accountId) throw new Error('Name both the userId and the accountId.');
    if (args.switchedBefore !== undefined) throw new Error('Name one account, or a switch time. Not both.');
    return { kind: 'account', userId: args.userId, accountId: args.accountId };
  }
  if (args.switchedBefore === undefined) throw new Error('Name one account, or a switch time.');
  return { kind: 'age', switchedBefore: args.switchedBefore };
}

/**
 * The rule for each connection that keeps a Nylas grant: it returns the
 * reason to keep the grant, or null. The plan and the claim use the same rule.
 */
function cleanupRefusal(ctx: any, target: CleanupTarget) {
  return async (holder: any): Promise<string | null> => {
    if (
      target.kind === 'account' &&
      (holder.userId !== target.userId || holder.accountId !== target.accountId)
    ) {
      return 'Another connection keeps this Nylas grant for its rollback. Use the age mode for all of them.';
    }
    const refused = await directConnectionRefusal(ctx, holder);
    if (refused || target.kind === 'account') return refused;
    if (typeof holder.switchedToGoogleAt !== 'number') {
      return 'The switch time of a connection is not known. Clean it up by account.';
    }
    if (holder.switchedToGoogleAt > target.switchedBefore) return 'A connection switched too recently.';
    return null;
  };
}

/** The token row of the named account, and the reason that it has no grant to clean up (or null). */
async function accountCleanupRow(ctx: any, target: { userId: string; accountId: string }) {
  const row = await ctx.db
    .query('providerGrants')
    .withIndex('by_user_account', (q: any) => q.eq('userId', target.userId).eq('accountId', target.accountId))
    .unique();
  if (!row) return { row: null, reason: 'The account was not found.' };
  const refused = await directConnectionRefusal(ctx, row);
  if (refused) return { row, reason: refused };
  if (row.nylasGrantDeletePending) {
    return {
      row,
      reason:
        'A cleanup run holds this Nylas grant (nylasGrantDeletePending). If no run is active, the last run stopped before its end.',
    };
  }
  if (!row.previousNylasGrantId) {
    return {
      row,
      reason: row.nylasGrantRevokedAt
        ? `The cleanup deleted the Nylas grant at ${new Date(row.nylasGrantRevokedAt).toISOString()}.`
        : 'The account keeps no Nylas grant.',
    };
  }
  return { row, reason: null };
}

/**
 * The Nylas grants that the owner can delete now. A switched Google account
 * keeps its Nylas grant for `rollbackToNylas`, and Nylas bills each grant.
 * Name one account (`userId` and `accountId`), or give `switchedBefore` for
 * all switched accounts whose switch is older than that time. Reads only: the
 * cleanup script (scripts/nylas-grant-cleanup.ts) shows this plan in its dry
 * run, and with --apply it claims each eligible grant
 * (claimNylasGrantCleanup) before it deletes the grant in Nylas.
 */
export const nylasGrantCleanupPlan = query({
  args: { internalSecret: v.optional(v.string()), ...cleanupTargetArgs },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const target = cleanupTarget(args);
    if (target.kind === 'account') {
      const { row, reason } = await accountCleanupRow(ctx, target);
      if (!row)
        return {
          items: [{ nylasGrantId: null, eligible: false, reason, connections: [] }],
          truncated: false,
        };
      if (reason) {
        const nylasGrantId = row.previousNylasGrantId ?? row.nylasGrantDeletePending ?? null;
        return {
          items: [{ nylasGrantId, eligible: false, reason, connections: [cleanupConnection(row)] }],
          truncated: false,
        };
      }
      const item = await nylasCleanupItem(ctx, row.previousNylasGrantId!, cleanupRefusal(ctx, target));
      return { items: [item], truncated: false };
    }

    const rows = await ctx.db
      .query('providerGrants')
      .withIndex('by_previous_nylas_grant', (q) => q.gt('previousNylasGrantId', ''))
      .take(NYLAS_CLEANUP_PLAN_LIMIT + 1);
    const truncated = rows.length > NYLAS_CLEANUP_PLAN_LIMIT;
    const grantIds = [
      ...new Set(rows.slice(0, NYLAS_CLEANUP_PLAN_LIMIT).map((row) => row.previousNylasGrantId!)),
    ];
    const items: NylasCleanupItem[] = [];
    for (const grantId of grantIds)
      items.push(await nylasCleanupItem(ctx, grantId, cleanupRefusal(ctx, target)));
    return { items, truncated };
  },
});

/**
 * Claims one Nylas grant before the cleanup deletes it in Nylas. In one
 * transaction, the claim checks the grant again with the rules of the plan,
 * and moves it on each connection that keeps it from `previousNylasGrantId`
 * to `nylasGrantDeletePending`. From then on, `rollbackToNylas` cannot put an
 * account back on the grant, and a reconnect does not keep it. The claim
 * returns the connections that it holds; finishNylasGrantCleanup takes the
 * same list.
 */
export const claimNylasGrantCleanup = mutation({
  args: { internalSecret: v.optional(v.string()), nylasGrantId: v.string(), ...cleanupTargetArgs },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const target = cleanupTarget(args);
    if (target.kind === 'account') {
      const { row, reason } = await accountCleanupRow(ctx, target);
      if (reason) return { claimed: false as const, reason };
      if (row.previousNylasGrantId !== args.nylasGrantId) {
        return { claimed: false as const, reason: 'The account keeps another Nylas grant.' };
      }
    }
    const item = await nylasCleanupItem(ctx, args.nylasGrantId, cleanupRefusal(ctx, target));
    if (!item.eligible || !item.connections.length) {
      return { claimed: false as const, reason: item.reason ?? 'No connection keeps this Nylas grant.' };
    }
    const ts = now();
    const holders = await ctx.db
      .query('providerGrants')
      .withIndex('by_previous_nylas_grant', (q) => q.eq('previousNylasGrantId', args.nylasGrantId))
      .take(NYLAS_CLEANUP_HOLDER_LIMIT);
    for (const holder of holders) {
      await ctx.db.patch(holder._id, {
        previousNylasGrantId: undefined,
        nylasGrantDeletePending: args.nylasGrantId,
        updatedAt: ts,
      });
    }
    return {
      claimed: true as const,
      holders: holders.map((holder) => ({ userId: holder.userId, accountId: holder.accountId })),
    };
  },
});

/**
 * Ends a claim of claimNylasGrantCleanup, only on the connections that the
 * claim returned and that still hold it. `deleted: true` (Nylas deleted the
 * grant, or had no such grant) records `nylasGrantRevokedAt`: the rollback
 * does not work after this. `deleted: false` (the delete failed) puts the
 * grant back in `previousNylasGrantId`, so the rollback works again.
 */
export const finishNylasGrantCleanup = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    nylasGrantId: v.string(),
    holders: v.array(v.object({ userId: v.string(), accountId: v.string() })),
    deleted: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    let updated = 0;
    for (const holder of args.holders.slice(0, NYLAS_CLEANUP_HOLDER_LIMIT)) {
      const row = await ctx.db
        .query('providerGrants')
        .withIndex('by_user_account', (q) => q.eq('userId', holder.userId).eq('accountId', holder.accountId))
        .unique();
      if (!row || row.nylasGrantDeletePending !== args.nylasGrantId) continue;
      await ctx.db.patch(
        row._id,
        args.deleted
          ? { nylasGrantDeletePending: undefined, nylasGrantRevokedAt: ts, updatedAt: ts }
          : { nylasGrantDeletePending: undefined, previousNylasGrantId: args.nylasGrantId, updatedAt: ts },
      );
      updated += 1;
    }
    return { updated };
  },
});

// ---------------------------------------------------------------------------
// History sync
// ---------------------------------------------------------------------------

/** Connected accounts on a direct Google grant. */
export const listDirectMailAccounts = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.gte('grantId', GOOGLE_GRANT_PREFIX).lt('grantId', GOOGLE_GRANT_END))
      .take(Math.max(1, Math.min(args.limit ?? 2000, 5000)));
    return rows
      .filter((row) => row.status === 'connected')
      .map((row) => ({ userId: row.userId, accountId: row.accountId }));
  },
});

/** History ids are unsigned 64-bit decimal strings. Null when a value is not one. */
function historyNumber(value: string | undefined): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  return BigInt(value);
}

/**
 * Moves the stored History id of one direct connection forward. Two runs can
 * overlap (two app instances); the slower one must not write back an older
 * id, so an id that is not newer than the stored one is not written. A
 * connection that has left the grant (a rollback or a new sign-in) is not
 * written either.
 */
export const advanceHistoryId = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    historyId: v.string(),
    progress: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const next = historyNumber(args.historyId);
    if (next === null) throw new Error('A History id is a decimal number.');
    const state = await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!state || state.grantId !== args.grantId) return { saved: false, reason: 'grant_changed' as const };
    const stored = historyNumber(state.historyId);
    if (stored !== null && next <= stored) {
      return { saved: false, reason: 'not_newer' as const, historyId: state.historyId };
    }
    const ts = now();
    await ctx.db.patch(state._id, {
      historyId: args.historyId,
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
      lastIncrementalSyncAt: ts,
      updatedAt: ts,
    });
    return { saved: true, historyId: args.historyId };
  },
});

/**
 * Every 2 minutes: ask the app to read the Gmail History of each direct
 * account. A mailbox with healthy Gmail push (googlePush.healthyGmailAccounts)
 * is read only on its fallback tick, about every 15 minutes; push brings its
 * changes between. When the push stops, the mailbox is read on each tick again.
 */
export const historyTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ requested: number; ok: number; deferred?: number }> => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[google-history cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return { requested: 0, ok: 0 };
    }
    const targets: Array<{ userId: string; accountId: string }> = await ctx.runQuery(
      internal.googleDirect.listDirectMailAccounts,
      {},
    );
    if (!targets.length) return { requested: 0, ok: 0 };
    const ts = now();
    const healthy = new Set<string>(
      await ctx.runQuery(internal.googlePush.healthyGmailAccounts, { now: ts }),
    );
    const due = targets.filter((target) => {
      const key = `${target.userId}:${target.accountId}`;
      return gmailPollDue({ now: ts, key, healthy: healthy.has(key) });
    });
    const deferred = targets.length - due.length;
    const ok = due.length
      ? await fanOutInternalPost(`${appUrl}/api/cron/google-history`, secret, due, {
          label: 'google-history cron',
        })
      : 0;
    return { requested: due.length, ok, ...(deferred ? { deferred } : {}) };
  },
});

// ---------------------------------------------------------------------------
// Scheduled sends (mailOutbox rows with a far fire time)
// ---------------------------------------------------------------------------

const SCHEDULED_KEY = /^outbox:[a-f0-9-]{36}$/;
const MAX_SCHEDULE_MS = 31 * 24 * 60 * 60_000;

export const enqueueScheduledSend = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    key: v.string(),
    payloadId: v.id('_storage'),
    fireAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!SCHEDULED_KEY.test(args.key)) throw new Error('Invalid send key');
    const ts = now();
    if (args.fireAt > ts + MAX_SCHEDULE_MS) throw new Error('Scheduled send time is too far away.');
    const fireAt = Math.max(ts, Math.floor(args.fireAt));
    const id = await ctx.db.insert('mailOutbox', {
      userId: args.userId,
      key: args.key,
      accountId: args.accountId,
      scheduled: true,
      payloadId: args.payloadId,
      status: 'pending',
      fireAt,
      undoSeconds: 0,
      updatedAt: ts,
    });
    await ctx.scheduler.runAt(fireAt, internal.mailOutbox.dispatch, {
      userId: args.userId,
      key: args.key,
      attempt: 0,
    });
    await ctx.scheduler.runAt(fireAt + 7 * 86400_000, internal.mailOutbox.cleanup, { id });
    return { key: args.key, fireAt, status: 'pending' as const };
  },
});

function scheduledRow(row: {
  key: string;
  fireAt: number;
  status: string;
  accountId?: string;
  messageId?: string;
}) {
  return {
    key: row.key,
    accountId: row.accountId,
    fireAt: row.fireAt,
    status: row.status,
    messageId: row.messageId,
  };
}

export const listScheduledSends = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('mailOutbox')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return rows
      .filter((row) => row.scheduled && row.accountId === args.accountId)
      .sort((a, b) => a.fireAt - b.fireAt)
      .map(scheduledRow);
  },
});

export const getScheduledSend = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mailOutbox')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
      .unique();
    return row?.scheduled ? scheduledRow(row) : null;
  },
});
