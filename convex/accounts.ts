import { v } from 'convex/values';
import { redactExportRow } from '../lib/hosted/export-redaction';
import { pickAccountForGrant } from '../lib/mail/grant-account';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import { deleteContactRow } from './contacts';
import { now, requireInternalSecret } from './lib';
import { deleteAttachmentFileRow } from './mailAttachments';
import { cancelHeldSends } from './mailOutbox';
import schema from './schema';

const providerValidator = v.union(
  v.literal('google'),
  v.literal('microsoft'),
  v.literal('icloud'),
  v.literal('imap'),
);

export const createOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    provider: v.string(),
    redirectTo: v.optional(v.string()),
    nativeCallback: v.optional(v.boolean()),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    await ctx.db.insert('nylasOAuthStates', {
      state: args.state,
      userId: args.userId,
      provider: args.provider,
      redirectTo: args.redirectTo,
      nativeCallback: args.nativeCallback,
      createdAt: ts,
      expiresAt: ts + args.ttlMs,
    });
    return { ok: true };
  },
});

export const consumeOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('nylasOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row || row.consumedAt || row.expiresAt < now()) return null;
    await ctx.db.patch(row._id, { consumedAt: now() });
    return row;
  },
});

export const listConnectedAccounts = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

export const getConnectedAccount = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
  },
});

export const getConnectedAccountByGrant = query({
  args: {
    internalSecret: v.optional(v.string()),
    grantId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    // Deliberately not `.unique()`: it throws when a grant matches more than
    // one row, and this is the first thing every inbound webhook does. See
    // pickAccountForGrant for why that mattered.
    const rows = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .collect();
    return pickAccountForGrant(rows);
  },
});

export const upsertConnectedAccount = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    email: v.string(),
    provider: providerValidator,
    grantId: v.string(),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scopes: v.array(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const email = args.email.toLowerCase();
    const ts = now();
    let existing = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.grantId))
      .unique();
    // Re-auth detection: a fresh OAuth/app-password flow for a mailbox we
    // already track mints a NEW grant id. Match on (email, provider) and
    // reuse the existing accountId so every synced row stays attached —
    // otherwise the same mailbox lands twice and everything shows doubled.
    let replacedGrantId: string | undefined;
    if (!existing) {
      const sameMailbox = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect();
      const match = sameMailbox.find((row) => row.email === email && row.provider === args.provider);
      if (match) {
        existing = match;
        if (match.grantId !== args.grantId) replacedGrantId = match.grantId;
      }
    }
    const id = existing?.accountId ?? args.grantId;
    const accountPatch = {
      accountId: id,
      email,
      provider: args.provider,
      status: 'connected' as const,
      displayName: args.displayName,
      scopes: args.scopes,
      grantId: args.grantId,
      error: undefined,
      // A reconnect ends the dead state. After a purge, the missing sync
      // states make the next sync a fresh backfill.
      errorSince: undefined,
      errorSinceSource: undefined,
      corpusPurgedAt: undefined,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, accountPatch);
    } else {
      await ctx.db.insert('connectedAccounts', {
        userId: args.userId,
        ...accountPatch,
        createdAt: ts,
      });
    }

    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', id))
      .unique();
    const grantPatch = {
      provider: args.provider,
      grantId: args.grantId,
      email,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      updatedAt: ts,
    };
    if (grant) {
      await ctx.db.patch(grant._id, grantPatch);
    } else {
      await ctx.db.insert('providerGrants', {
        userId: args.userId,
        accountId: id,
        ...grantPatch,
        createdAt: ts,
      });
    }

    const syncState = await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', id))
      .unique();
    if (!syncState) {
      await ctx.db.insert('mailSyncStates', {
        userId: args.userId,
        accountId: id,
        grantId: args.grantId,
        provider: args.provider,
        status: 'idle' as const,
        corpusReady: false,
        error: undefined,
        createdAt: ts,
        updatedAt: ts,
      });
    } else if (syncState.grantId !== args.grantId) {
      // A new grant invalidates the old corpus cursors; restart from idle.
      await ctx.db.patch(syncState._id, {
        grantId: args.grantId,
        provider: args.provider,
        status: 'idle' as const,
        corpusReady: false,
        cursor: undefined,
        error: undefined,
        updatedAt: ts,
      });
    } else {
      // Same-grant reconnects/token refreshes must not revoke an
      // already-synced corpus or restart backfill.
      // A reconnect clears a sync error left by the dead grant.
      await ctx.db.patch(syncState._id, {
        provider: args.provider,
        ...(syncState.status === 'error'
          ? { status: syncState.corpusReady ? ('ready' as const) : ('idle' as const), error: undefined }
          : {}),
        updatedAt: ts,
      });
    }
    return { accountId: id, replacedGrantId };
  },
});

// One account health state (SYNC-2, CAL-8). Grant webhooks and grant-gone
// sync errors put each connected account on the grant into `error` with a
// reconnect reason. Sync, backfill kicks, and calendar polls only run for
// `connected` accounts, so the attempts stop. upsertConnectedAccount (a good
// OAuth reconnect) sets `connected` and clears the reason.
export const markGrantReconnectNeeded = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    grantId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .collect();
    let updated = 0;
    const ts = now();
    for (const row of rows) {
      if (row.status !== 'connected') continue;
      await ctx.db.patch(row._id, {
        status: 'error',
        error: truncateText(args.reason, 300),
        ...(row.errorSince === undefined
          ? { errorSince: ts, errorSinceSource: 'status_change' as const }
          : {}),
        updatedAt: ts,
      });
      updated += 1;
    }
    return { updated };
  },
});

/**
 * Keeps the stored scopes equal to the grant's current scopes (Nylas
 * `GET /v3/grants/{id}`). A re-auth that adds contact scopes then shows at
 * once, and the contact sync reads the new list.
 */
export const updateGrantScopes = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const scopes = [...new Set(args.scopes.map((scope) => scope.trim()).filter(Boolean))].slice(0, 100);
    const ts = now();
    let updated = 0;
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (account && account.grantId === args.grantId) {
      await ctx.db.patch(account._id, { scopes, updatedAt: ts });
      updated += 1;
    }
    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (grant && grant.grantId === args.grantId) {
      await ctx.db.patch(grant._id, { scopes, updatedAt: ts });
      updated += 1;
    }
    return { updated };
  },
});

export const updateConnectedAccountAlias = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!row) throw new Error('Connected account not found');
    const displayName = truncateText((args.displayName || '').trim(), 80) || undefined;
    await ctx.db.patch(row._id, {
      displayName,
      updatedAt: now(),
    });
    return { ok: true };
  },
});

// Per-account state rows. Both account purges (disconnect and the 30-day
// dead-account purge) delete all of them in each pass, first, so a reconnect
// during a purge starts a fresh sync.
export const ACCOUNT_STATE_TABLES = [
  'mailSyncStates',
  'calendarSyncStates',
  'calendars',
  'contactSyncStates',
] as const;

// Bulk per-account tables are purged in scheduled batches: a whole mailbox
// corpus cannot be deleted inside one Convex transaction (it exceeds the
// per-transaction document limits, which is exactly how account removal used
// to 500 and strand orphan rows). Disconnect and the dead-account purge
// (convex/deadAccounts.ts) both read this list through purgeAccountPass.
export const ACCOUNT_BULK_TABLES = [
  'mailCorpusThreads',
  'mailCorpusMessages',
  // Mail bodies (IO-1). A body document can hold ~230 kB, so a pass takes few.
  'mailCorpusBodies',
  // Custom-label membership rows point at corpus threads (CLS-13).
  'mailLabelMembership',
  'mailWebhookEvents',
  // One-time codes are live authentication secrets. They expire on their own,
  // but a disconnected account's codes must not outlive the disconnection.
  'mailOneTimeCodes',
  // Snooze rows would otherwise keep waking threads of a removed mailbox.
  'mailSnoozes',
  // Attachment files: each row takes its stored file when no row shares it.
  'mailAttachmentFiles',
  'mailAttachmentQueue',
  'mailAttachmentBackfills',
  'calendarEvents',
  'areaArtifactLinks',
  // Each contacts row takes its contactEmails rows with it (see below).
  'contacts',
] as const;

export const USER_BULK_TABLES = [
  'briefJobs',
  ...ACCOUNT_BULK_TABLES,
  'areaFacts',
  'areaReindexRuns',
  'albatrossRoutines',
  'albatrossRoutineRuns',
  'albatrossEvidence',
  'albatrossLapses',
  'albatrossMetricEntries',
  'mobileCommands',
  'agentToolExecutions',
  'mobileSyncChanges',
  'mobileSyncTombstones',
  'nativePushDeliveries',
  'documentRevisions',
  'documentModels',
  'officeDocuments',
  'officeVersions',
  'officeSessions',
  'documentAssets',
  // Append-only telemetry with no pruning; an active account outgrows one
  // transaction, so it drains in batches like the other bulk tables.
  'briefItemEvents',
  'briefEditionTelemetry',
  // Secure details use history: one row for each use, kept 90 days.
  'secureUses',
  // Shared narrative memory and connected content grow with the mailbox.
  // Each contentItems row takes its contentChunks with it (see below).
  'narrativeEntries',
  'narrativeRuns',
  'contentItems',
  'briefPreparations',
  // Recipient-search counts derived from the mail of every mailbox.
  'correspondents',
  // Tables that grow with mail or with time. In production (2026-09-28) one
  // user had more than 130 MB of userDocs and more than 8,000 rows in each of
  // aiUsageEvents and notificationDeliveries. One inline sweep of them passes
  // the Convex read limits, and the account deletion then fails.
  'userDocs',
  'aiUsageEvents',
  'aiOperations',
  'albatrossNotifications',
  'notificationDeliveries',
  'mcpItems',
] as const;

const PURGE_BATCH = 250;

const KiB = 1024;
const MiB = 1024 * KiB;

// Size limits of one purge pass. One pass is one mutation. Convex lets one
// mutation read 16 MiB and write 16 MiB, scan 32,000 documents, and make
// 4,096 index reads, and one document holds at most 1 MiB
// (docs.convex.dev/production/state/limits, read 2026-09-28). A pass deletes
// the rows that it reads, so its reads also bound its writes. Before each
// read, a pass keeps room for (rows × the row bound of the table). After the
// read, it counts the measured size of the rows. The room never goes past
// PURGE_PASS_BYTES, so one pass reads and deletes at most 8 MiB. A pass that
// stops at a limit schedules the next pass.
export const PURGE_PASS_BYTES = 8 * MiB;
// The row bound of a table that PURGE_ROW_BYTES does not name: the document limit.
const DEFAULT_ROW_BYTES = MiB;
// One content item without its chunks: 120,000 text characters and short fields.
export const CONTENT_ITEM_BYTES = 384 * KiB;

/**
 * The most bytes of one purged row, with the rows that its delete reads or
 * removes. A bound comes from the writer's limits (3 bytes for each
 * character), from the 1 MiB document limit when a field has no limit, or,
 * for rows of short fields, from the largest production row on 2026-09-28
 * with a margin of 10 or more.
 */
export const PURGE_ROW_BYTES: Record<string, number> = {
  // Short provider fields and verdict objects. Production max 5.9 kB.
  mailCorpusThreads: 64 * KiB,
  // A split row (a 1,500-character header line and a body excerpt) is at most
  // 9.1 kB in production. A row from before the body split (IO-1) still holds
  // its HTML and text bodies, and a searchText with the whole text body; its
  // address fields have no limit, so the bound is the document limit. On
  // 2026-09-28 the oldest 8,000 production rows all held inline bodies (max
  // 266 kB, 980 rows over 128 KiB); staging had none. When
  // mailBodies:migrateMessageBodies is done in production, 128 KiB is enough.
  mailCorpusMessages: MiB,
  // 32,000 text and 200,000 HTML characters.
  mailCorpusBodies: 700 * KiB,
  mailLabelMembership: 16 * KiB,
  // A row from before the ids-only change keeps its payload, which has no
  // limit. Production max 449 kB.
  mailWebhookEvents: MiB,
  mailOneTimeCodes: 16 * KiB,
  mailSnoozes: 16 * KiB,
  // Metadata, and the one row that can share the stored file.
  mailAttachmentFiles: 32 * KiB,
  mailAttachmentQueue: 16 * KiB,
  mailAttachmentBackfills: 16 * KiB,
  // Description and guests have no limit. Production max 12 kB.
  calendarEvents: 256 * KiB,
  areaArtifactLinks: 16 * KiB,
  // A contact and its address rows (at most 20). Production max 1.8 kB.
  contacts: 64 * KiB,
  // CONTENT_ITEM_BYTES, and up to 34 chunks of 4,000 characters and 1,536 numbers.
  contentItems: 1280 * KiB,
  // Notices (180 and 1,000 characters) with their delivery rows.
  albatrossNotifications: 64 * KiB,
  // The payload has no limit. Production max 1.6 kB. With its notice.
  suggestions: 128 * KiB,
  // Memory observations. Production max 21 kB.
  narrativeEntries: 128 * KiB,
  // Rows of ids and numbers.
  briefItemEvents: 16 * KiB,
  // Secure details use history: a few short strings and two numbers.
  secureUses: 16 * KiB,
  briefEditionTelemetry: 16 * KiB,
  mobileSyncTombstones: 16 * KiB,
  nativePushDeliveries: 16 * KiB,
  // Short fields and an error message with no limit. Production max 485 B.
  notificationDeliveries: 16 * KiB,
  // Production max 412 B.
  aiUsageEvents: 32 * KiB,
  // A summary and a target object. Production max 4.6 kB.
  aiOperations: 64 * KiB,
  // The raw provider item has no limit. Production max 29 kB.
  mcpItems: 256 * KiB,
};

function purgeRowBytes(table: string) {
  return PURGE_ROW_BYTES[table] ?? DEFAULT_ROW_BYTES;
}

// UTF-8 length. Each half of a surrogate pair counts 3 bytes, which is more
// than the 4 bytes of the pair.
function utf8Bytes(text: string) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

/** An upper estimate of the stored size of a Convex value, in bytes. */
export function storedBytes(value: unknown): number {
  if (typeof value === 'string') return utf8Bytes(value) + 4;
  if (Array.isArray(value)) {
    let bytes = 4;
    for (const item of value) bytes += storedBytes(item);
    return bytes;
  }
  if (value instanceof ArrayBuffer) return value.byteLength + 4;
  if (value && typeof value === 'object') {
    let bytes = 4;
    for (const [key, item] of Object.entries(value)) bytes += utf8Bytes(key) + 2 + storedBytes(item);
    return bytes;
  }
  // A number, a bigint, a boolean, or null.
  return 9;
}

/** The rows that the next read of a pass may take: at most `cap`, and within the row and byte room. */
export function purgePassRoom(pass: { rows: number; bytes: number }, rowBytes: number, cap: number) {
  const byBytes = Math.floor((PURGE_PASS_BYTES - pass.bytes) / rowBytes);
  return Math.max(0, Math.min(cap, PURGE_BATCH - pass.rows, byBytes));
}
// A content item has at most ~34 embedding chunks, so a few items per pass
// keep one purge transaction far below the Convex read limits.
const CONTENT_ITEMS_PER_PASS = 5;
// A document model row can be close to 1 MiB.
const DOCUMENT_MODELS_PER_PASS = 8;
// A contact has at most 20 address rows, so one pass stays small.
const CONTACTS_PER_PASS = 50;
// A mail body document holds up to ~230 kB of text and HTML.
const MAIL_BODIES_PER_PASS = 25;
// A message row from before the body split (IO-1) can still hold its body.
const MAIL_MESSAGES_PER_PASS = 40;
// A webhook row from before the ids-only change can hold a mail payload.
const WEBHOOK_EVENTS_PER_PASS = 50;
// Each attachment file row can also delete its stored file.
const ATTACHMENT_FILES_PER_PASS = 100;

// The most rows of one table that one purge pass takes.
function purgePassLimit(table: string, remaining: number) {
  if (table === 'contentItems') return Math.min(remaining, CONTENT_ITEMS_PER_PASS);
  if (table === 'documentModels') return Math.min(remaining, DOCUMENT_MODELS_PER_PASS);
  if (table === 'contacts') return Math.min(remaining, CONTACTS_PER_PASS);
  if (table === 'mailCorpusBodies') return Math.min(remaining, MAIL_BODIES_PER_PASS);
  if (table === 'mailCorpusMessages') return Math.min(remaining, MAIL_MESSAGES_PER_PASS);
  if (table === 'mailWebhookEvents') return Math.min(remaining, WEBHOOK_EVENTS_PER_PASS);
  if (table === 'mailAttachmentFiles') return Math.min(remaining, ATTACHMENT_FILES_PER_PASS);
  return remaining;
}
// Tables expose one of these userId-prefixed indexes; try each in turn.
export const USER_INDEXES = [
  'by_user',
  'by_user_account',
  'by_user_key',
  'by_user_created',
  'by_user_email',
] as const;

async function takeByUser(ctx: any, table: string, userId: string, limit: number) {
  let lastErr: unknown;
  for (const index of USER_INDEXES) {
    try {
      return await ctx.db
        .query(table)
        .withIndex(index as any, (q: any) => q.eq('userId', userId))
        .take(limit);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Whole-user purge twin of purgeAccountDataBatch: account deletion already
// batches, and user deletion must too — a populated mailbox exceeds Convex's
// per-transaction limits if swept inline.
export const purgeUserDataBatch = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Rows deleted and bytes read in this pass (see PURGE_PASS_BYTES).
    const pass = { rows: 0, bytes: 0 };
    let more = false;
    for (const table of USER_BULK_TABLES) {
      const room = purgePassRoom(pass, purgeRowBytes(table), purgePassLimit(table, PURGE_BATCH));
      if (room === 0) {
        more = true;
        continue;
      }
      const rows = await takeByUser(ctx, table, args.userId, room);
      for (const row of rows) {
        pass.bytes += storedBytes(row);
        if (table === 'mailAttachmentFiles') {
          // It also reads the row that can share the stored file.
          pass.bytes += purgeRowBytes(table);
          await deleteAttachmentFileRow(ctx, row as any);
          pass.rows += 1;
          continue;
        }
        if ((table === 'officeVersions' || table === 'documentAssets') && 'storageId' in row) {
          // Metadata must not be deleted before its private binary.
          await ctx.storage.delete(row.storageId as Id<'_storage'>);
        }
        if (table === 'contentItems') {
          // contentChunks has no userId index; it hangs off its item.
          const chunks = await ctx.db
            .query('contentChunks')
            .withIndex('by_item', (q) => q.eq('itemId', row._id as Id<'contentItems'>))
            .collect();
          pass.bytes += storedBytes(chunks);
          for (const chunk of chunks) await ctx.db.delete(chunk._id);
          pass.rows += chunks.length;
        }
        if (table === 'contacts') {
          // 'contactEmails' has no userId index for the sweep; it hangs off
          // its contact. The pass counts the bound for the address rows.
          pass.bytes += purgeRowBytes(table);
          pass.rows += await deleteContactRow(ctx, row._id as Id<'contacts'>);
          continue;
        }
        await ctx.db.delete(row._id);
        pass.rows += 1;
      }
    }
    if (pass.rows > 0 || more) {
      await ctx.scheduler.runAfter(0, internal.accounts.purgeUserDataBatch, args);
    }
    return { deleted: pass.rows, bytes: pass.bytes };
  },
});

// The (userId, accountId) prefix index of each account table. A table with no
// `by_user_account` index names its own; a wrong name makes the pass throw and
// roll back, which strands every row left in the last batch.
export const ACCOUNT_PURGE_INDEX: Partial<Record<(typeof ACCOUNT_BULK_TABLES)[number], string>> = {
  areaArtifactLinks: 'by_user_account_artifact',
};

/**
 * Rows of one mailbox in tables that have no accountId field. Each entry
 * reads one index: userId, then `kind` when it is set, then `field`, which
 * is equal to `value(accountId)`, or starts with it when `prefix` is set.
 * A key prefix ends with a separator, so one account id never matches the
 * rows of a longer one. `rowBytes` is the row bound of the entry (see
 * PURGE_ROW_BYTES); one pass takes at most PURGE_PASS_BYTES / rowBytes rows.
 */
export type AccountKeyedRows = {
  table: 'userDocs' | 'narrativeEntries' | 'albatrossNotifications' | 'suggestions';
  index: string;
  kind?: string;
  field: string;
  value: (accountId: string) => string;
  prefix?: boolean;
  rowBytes: number;
};

const accountKeyPrefix = (accountId: string) => `${accountId}:`;
// Keys written as JSON.stringify([accountId, threadId]).
const accountJsonKeyPrefix = (accountId: string) => `${JSON.stringify([accountId]).slice(0, -1)},`;

export const ACCOUNT_KEYED_ROWS: readonly AccountKeyedRows[] = [
  // Per-user document store (lib/store/*): thread and message caches, thread
  // notes, tracked threads, drafts, and dismissals of the mailbox's threads.
  {
    table: 'userDocs',
    index: 'by_user_kind_ref',
    kind: 'thread',
    field: 'ref',
    value: (a) => a,
    rowBytes: 64 * KiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_ref',
    kind: 'draft',
    field: 'ref',
    value: (a) => a,
    rowBytes: MiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_ref',
    kind: 'proofDismissal',
    field: 'ref',
    value: (a) => a,
    rowBytes: 16 * KiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_key',
    kind: 'msgCache',
    field: 'key',
    value: accountKeyPrefix,
    prefix: true,
    rowBytes: MiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_key',
    kind: 'threadInsight',
    field: 'key',
    value: accountKeyPrefix,
    prefix: true,
    rowBytes: 64 * KiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_key',
    kind: 'trackedThread',
    field: 'key',
    value: accountKeyPrefix,
    prefix: true,
    rowBytes: 64 * KiB,
  },
  {
    table: 'userDocs',
    index: 'by_user_kind_key',
    kind: 'dailyReportThreadDismissal',
    field: 'key',
    value: accountJsonKeyPrefix,
    prefix: true,
    rowBytes: 16 * KiB,
  },
  // Memory observations of the mailbox's mail and calendar
  // (lib/narrative/observations.ts). The chapters built on them go at the end.
  {
    table: 'narrativeEntries',
    index: 'by_user_source',
    field: 'source',
    value: (a) => `mail:${a}`,
    rowBytes: PURGE_ROW_BYTES.narrativeEntries,
  },
  {
    table: 'narrativeEntries',
    index: 'by_user_source',
    field: 'source',
    value: (a) => `calendar:${a}`,
    rowBytes: PURGE_ROW_BYTES.narrativeEntries,
  },
  // New-mail notifications quote the sender and the subject.
  {
    table: 'albatrossNotifications',
    index: 'by_user_dedupe',
    field: 'dedupeKey',
    value: (a) => `mail-message:${a}:`,
    prefix: true,
    rowBytes: PURGE_ROW_BYTES.albatrossNotifications,
  },
  {
    table: 'albatrossNotifications',
    index: 'by_user_dedupe',
    field: 'dedupeKey',
    value: (a) => `urgent-mail:${a}:`,
    prefix: true,
    rowBytes: PURGE_ROW_BYTES.albatrossNotifications,
  },
  // Event suggestions read from the mailbox's messages (lib/mail/suggestion-detectors.ts).
  {
    table: 'suggestions',
    index: 'by_user_dedupe',
    field: 'dedupeKey',
    value: (a) => `ics:${a}:`,
    prefix: true,
    rowBytes: PURGE_ROW_BYTES.suggestions,
  },
  {
    table: 'suggestions',
    index: 'by_user_dedupe',
    field: 'dedupeKey',
    value: (a) => `inline-event:${a}:`,
    prefix: true,
    rowBytes: PURGE_ROW_BYTES.suggestions,
  },
];

function keyedRowsQuery(ctx: any, entry: AccountKeyedRows, userId: string, accountId: string) {
  const value = entry.value(accountId);
  return ctx.db.query(entry.table).withIndex(entry.index as any, (q: any) => {
    const scoped =
      entry.kind === undefined ? q.eq('userId', userId) : q.eq('userId', userId).eq('kind', entry.kind);
    return entry.prefix
      ? scoped.gte(entry.field, value).lt(entry.field, `${value}￿`)
      : scoped.eq(entry.field, value);
  });
}

/** Deletes a notice and its delivery rows. The bytes count the delivery rows it read. */
async function deleteNotificationRow(ctx: any, notificationId: Id<'albatrossNotifications'>) {
  const done = { rows: 1, bytes: 0 };
  for (const table of ['notificationDeliveries', 'nativePushDeliveries'] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_notification', (q: any) => q.eq('notificationId', notificationId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    done.rows += rows.length;
    done.bytes += storedBytes(rows);
  }
  await ctx.db.delete(notificationId);
  return done;
}

/**
 * Deletes one purged row of a mailbox with the rows that hang off it. It
 * returns the rows deleted and the bytes read: the row, the rows it read, or
 * the row bound when another module reads them.
 */
async function deleteAccountRow(ctx: any, table: string, row: any): Promise<{ rows: number; bytes: number }> {
  const bytes = storedBytes(row);
  // 'contactEmails' has no userId index for the sweep; it hangs off its contact.
  if (table === 'contacts')
    return {
      rows: await deleteContactRow(ctx, row._id as Id<'contacts'>),
      bytes: bytes + purgeRowBytes(table),
    };
  if (table === 'albatrossNotifications') {
    const done = await deleteNotificationRow(ctx, row._id);
    return { rows: done.rows, bytes: bytes + done.bytes };
  }
  if (table === 'mailAttachmentFiles') {
    await deleteAttachmentFileRow(ctx, row);
    return { rows: 1, bytes: bytes + purgeRowBytes(table) };
  }
  const done = { rows: 1, bytes };
  if (table === 'suggestions') {
    // The in-app notice of an event suggestion repeats its title.
    const notices = await ctx.db
      .query('albatrossNotifications')
      .withIndex('by_user_dedupe', (q: any) =>
        q.eq('userId', row.userId).eq('dedupeKey', `event-suggestion:${String(row._id)}`),
      )
      .collect();
    done.bytes += storedBytes(notices);
    for (const notice of notices) {
      const removed = await deleteNotificationRow(ctx, notice._id);
      done.rows += removed.rows;
      done.bytes += removed.bytes;
    }
  }
  await ctx.db.delete(row._id);
  return done;
}

/**
 * One bounded pass over the data of one mailbox. Disconnect and the 30-day
 * dead-account purge share it, so both delete the same set: the state rows,
 * the account tables, the content index of the mailbox (mail and attachment
 * items with their text chunks and vectors), and the keyed rows above. A pass
 * stays within PURGE_BATCH rows and PURGE_PASS_BYTES bytes. `more` is true
 * when a limit stopped a read. A pass that deletes nothing and is not stopped
 * means that the set is gone; the caller then runs finishAccountPurge.
 */
export async function purgeAccountPass(ctx: any, userId: string, accountId: string) {
  // Rows deleted and bytes read in this pass.
  const pass = { rows: 0, bytes: 0 };
  let more = false;
  const byTable: Record<string, number> = {};
  const note = (table: string, count: number) => {
    if (!count) return;
    byTable[table] = (byTable[table] ?? 0) + count;
    pass.rows += count;
  };
  // The rows that the next read may take, or 0 when a limit stops it.
  const room = (rowBytes: number, cap: number) => {
    const rows = purgePassRoom(pass, rowBytes, cap);
    if (rows === 0) more = true;
    return rows;
  };
  for (const table of ACCOUNT_STATE_TABLES) {
    const rows = await ctx.db
      .query(table)
      .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
      .collect();
    pass.bytes += storedBytes(rows);
    for (const row of rows) await ctx.db.delete(row._id);
    note(table, rows.length);
  }
  for (const table of ACCOUNT_BULK_TABLES) {
    const take = room(purgeRowBytes(table), purgePassLimit(table, PURGE_BATCH));
    if (!take) continue;
    const rows = await ctx.db
      .query(table)
      .withIndex((ACCOUNT_PURGE_INDEX[table] ?? 'by_user_account') as any, (q: any) =>
        q.eq('userId', userId).eq('accountId', accountId),
      )
      .take(take);
    for (const row of rows) {
      const done = await deleteAccountRow(ctx, table, row);
      pass.bytes += done.bytes;
      note(table, done.rows);
    }
  }
  const takeItems = room(purgeRowBytes('contentItems'), purgePassLimit('contentItems', PURGE_BATCH));
  if (takeItems) {
    // Mail and attachment content items use the account id as connectionId.
    const items = await ctx.db
      .query('contentItems')
      .withIndex('by_user_connection', (q: any) => q.eq('userId', userId).eq('connectionId', accountId))
      .take(takeItems);
    for (const item of items) {
      // contentChunks has no userId index; it hangs off its item.
      const chunks = await ctx.db
        .query('contentChunks')
        .withIndex('by_item', (q: any) => q.eq('itemId', item._id))
        .collect();
      pass.bytes += storedBytes(item) + storedBytes(chunks);
      for (const chunk of chunks) await ctx.db.delete(chunk._id);
      await ctx.db.delete(item._id);
      note('contentChunks', chunks.length);
      note('contentItems', 1);
    }
  }
  for (const entry of ACCOUNT_KEYED_ROWS) {
    const take = room(entry.rowBytes, PURGE_BATCH);
    if (!take) continue;
    const rows = await keyedRowsQuery(ctx, entry, userId, accountId).take(take);
    for (const row of rows) {
      const done = await deleteAccountRow(ctx, entry.table, row);
      pass.bytes += done.bytes;
      note(entry.table, done.rows);
    }
  }
  return { deleted: pass.rows, byTable, bytes: pass.bytes, more };
}

/**
 * The last step of both account purges, after purgeAccountPass found nothing
 * more: the mailbox's share of the recipient-search counts, and the rows that
 * name the mailbox but have no index by account.
 */
export async function finishAccountPurge(ctx: any, userId: string, accountId: string) {
  await ctx.scheduler.runAfter(0, internal.correspondents.purgeAccountCorrespondents, { userId, accountId });
  await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDerivedRows, { userId, accountId });
}

// Evidence kinds that can quote a mailbox's mail or calendar.
const DERIVED_EVIDENCE_KINDS = ['mail_thread', 'calendar_event'] as const;
// Evidence rows have fields with no limit, so a page also stops after
// DERIVED_PAGE_BYTES (Convex reads one more row at most: 1 MiB).
const DERIVED_EVIDENCE_PAGE = 100;
const DERIVED_PAGE_BYTES = 4 * MiB;
// A preparation reads its seed and its sources (the product saves up to 20),
// each up to CONTENT_ITEM_BYTES. A pass reads a small page, then checks the
// references while the pass has room for one more item. When the room ends,
// the next pass starts again at the same preparation and reference.
const DERIVED_PREPARATIONS_PAGE = 5;
const DERIVED_PREPARATIONS_PAGE_BYTES = 2 * MiB;

/** True when a Work receipt came from the mailbox (reply and proof rows, area-link rows). */
export function evidenceNamesAccount(
  row: { accountId?: string; connectionId?: string; dedupeKey: string },
  accountId: string,
) {
  return (
    row.accountId === accountId || row.connectionId === accountId || row.dedupeKey.includes(`:${accountId}:`)
  );
}

/** The content items that a prepared brief item was written from: its seed, then its sources. */
function preparationReferences(row: { seedId: string; sources?: Array<{ _id?: unknown }> }) {
  return [String(row.seedId), ...(row.sources || []).map((source) => String(source?._id ?? ''))];
}

/**
 * Rows that name a purged mailbox but have no index by account, read page by
 * page: the mail and calendar Work receipts of the mailbox, then prepared
 * brief items whose seed or a source item is gone (their draft was written
 * from that content, and the list and the claim already skip them). The last
 * step asks the memory cleanup to delete the chapters built on the deleted
 * observations. Each pass stays within PURGE_PASS_BYTES.
 */
export const purgeAccountDerivedRows = internalMutation({
  args: {
    userId: v.string(),
    accountId: v.string(),
    step: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    // Where a preparations pass stopped: the row, and the next reference.
    resumeId: v.optional(v.id('briefPreparations')),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const step = args.step ?? 0;
    const cursor = args.cursor ?? null;
    let deleted = 0;
    let bytes = 0;
    // Schedules the next pass and returns its arguments.
    const next = async (fields: {
      step: number;
      cursor: string | null;
      resumeId?: Id<'briefPreparations'>;
      position?: number;
    }) => {
      const nextArgs = { userId: args.userId, accountId: args.accountId, ...fields };
      await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDerivedRows, nextArgs);
      return nextArgs;
    };
    let page: { isDone: boolean; continueCursor: string };
    if (step < DERIVED_EVIDENCE_KINDS.length) {
      const evidence = await ctx.db
        .query('albatrossEvidence')
        .withIndex('by_user_source', (q) =>
          q.eq('userId', args.userId).eq('sourceKind', DERIVED_EVIDENCE_KINDS[step]),
        )
        .paginate({ cursor, numItems: DERIVED_EVIDENCE_PAGE, maximumBytesRead: DERIVED_PAGE_BYTES });
      bytes += storedBytes(evidence.page);
      for (const row of evidence.page) {
        if (!evidenceNamesAccount(row, args.accountId)) continue;
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      page = evidence;
    } else if (step === DERIVED_EVIDENCE_KINDS.length) {
      // by_user_key keeps its order when a row changes, so a pass can resume.
      const preparations = await ctx.db
        .query('briefPreparations')
        .withIndex('by_user_key', (q) => q.eq('userId', args.userId))
        .paginate({
          cursor,
          numItems: DERIVED_PREPARATIONS_PAGE,
          maximumBytesRead: DERIVED_PREPARATIONS_PAGE_BYTES,
        });
      bytes += storedBytes(preparations.page);
      // The rows before the resume row were checked and kept by an earlier pass.
      const resumeAt = args.resumeId ? preparations.page.findIndex((row) => row._id === args.resumeId) : -1;
      for (let index = Math.max(resumeAt, 0); index < preparations.page.length; index++) {
        const row = preparations.page[index];
        const references = preparationReferences(row);
        let lost = false;
        for (
          let position = index === resumeAt ? (args.position ?? 0) : 0;
          position < references.length;
          position++
        ) {
          if (bytes + CONTENT_ITEM_BYTES > PURGE_PASS_BYTES)
            return {
              deleted,
              done: false,
              bytes,
              next: await next({ step, cursor, resumeId: row._id, position }),
            };
          const id = ctx.db.normalizeId('contentItems', references[position]);
          const item = id ? await ctx.db.get(id) : null;
          if (!item) {
            lost = true;
            break;
          }
          bytes += storedBytes(item);
        }
        if (!lost) continue;
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      page = preparations;
    } else {
      const memory = await ctx.db
        .query('narrativeSettings')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .first();
      if (memory) await ctx.scheduler.runAfter(0, internal.narrative.cleanup, { userId: args.userId });
      return { deleted: 0, done: true, bytes };
    }
    const nextArgs = await next({
      step: page.isDone ? step + 1 : step,
      cursor: page.isDone ? null : page.continueCursor,
    });
    return { deleted, done: false, bytes, next: nextArgs };
  },
});

/** The disconnect purge chain. deleteConnectedAccount starts it. */
export const purgeAccountDataBatch = internalMutation({
  args: { userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    // A mailbox connected again under the same id owns these rows now.
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .first();
    if (account) return { deleted: 0, stopped: 'reconnected' as const };
    const { deleted, byTable, bytes, more } = await purgeAccountPass(ctx, args.userId, args.accountId);
    if (deleted > 0 || more) {
      await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDataBatch, args);
      return { deleted, byTable, bytes };
    }
    await finishAccountPurge(ctx, args.userId, args.accountId);
    return { deleted: 0, byTable, bytes, done: true };
  },
});

export const deleteConnectedAccount = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    // Every disconnect path comes here, also when the grant removal failed
    // (lib/nylas/provider.ts deleteNylasAccount). So the held scheduled
    // sends of the mailbox go here too, with their stored messages.
    await cancelHeldSends(ctx, args.userId, args.accountId);
    // Small tables go inline so the account vanishes from the UI immediately;
    // the rest drains in scheduled batches right after (purgeAccountPass).
    for (const table of ['connectedAccounts', 'providerGrants', ...ACCOUNT_STATE_TABLES] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDataBatch, {
      userId: args.userId,
      accountId: args.accountId,
    });
    return { ok: true };
  },
});

export const deleteUserCascade = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    // Revoke active writer ownership before deleting any of its output. Historical
    // jobs drain in the bulk purge; a live worker cannot recreate deleted data.
    const jobs = await ctx.db
      .query('briefJobs')
      .withIndex('by_user_active', (q) => q.eq('userId', args.userId).eq('active', true))
      .collect();
    for (const job of jobs)
      await ctx.db.patch(job._id, { active: false, state: 'cancelled', token: undefined });

    const counts: Record<string, number> = {};
    // Small tables sweep inline; bulk tables drain through purgeUserDataBatch.
    for (const table of USER_INLINE_TABLES) {
      const rows = await rowsByUser(ctx, table, args.userId);
      counts[table] = rows.length;
      for (const row of rows) {
        if (table === 'mailOutbox' && 'payloadId' in row && row.payloadId)
          await ctx.storage.delete(row.payloadId);
        if (table === 'documents' && 'importSource' in row && row.importSource) {
          // The preserved workbook belongs to this document's owner. Remove
          // its private bytes before deleting the only storage reference.
          const source = row.importSource as { storageId: Id<'_storage'> };
          await ctx.storage.delete(source.storageId);
        }
        await ctx.db.delete(row._id);
      }
    }
    const agentUploads = await ctx.db
      .query('agentUploads')
      .withIndex('by_user_created', (q) => q.eq('userId', args.userId))
      .collect();
    counts.agentUploads = agentUploads.length;
    for (const upload of agentUploads) {
      await ctx.storage.delete(upload.storageId).catch(() => undefined);
      await ctx.db.delete(upload._id);
    }
    await ctx.scheduler.runAfter(0, internal.accounts.purgeUserDataBatch, { userId: args.userId });

    // Kanban: boards key on ownerUserId, so they need their own pass. Owned
    // boards go down with their 'boardColumns', 'cards', and 'boardMembers';
    // on boards owned by OTHERS the user's memberships and authored cards are
    // removed while the board itself survives.
    const ownedBoards = await ctx.db
      .query('boards')
      .withIndex('by_owner', (q) => q.eq('ownerUserId', args.userId))
      .collect();
    counts.boards = ownedBoards.length;
    for (const board of ownedBoards) {
      for (const table of ['boardColumns', 'cards', 'boardMembers'] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex(table === 'boardColumns' ? 'by_board' : ('by_board' as any), (q: any) =>
            q.eq('boardId', board._id),
          )
          .collect();
        for (const row of rows) await ctx.db.delete(row._id);
      }
      await ctx.db.delete(board._id);
    }
    const foreignMemberships = await ctx.db
      .query('boardMembers')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    counts.boardMembers = foreignMemberships.length;
    for (const membership of foreignMemberships) await ctx.db.delete(membership._id);
    const authoredCards = await ctx.db
      .query('cards')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    counts.cards = authoredCards.length;
    for (const card of authoredCards) await ctx.db.delete(card._id);

    const userRows = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .collect();
    counts.users = userRows.length;
    for (const row of userRows) await ctx.db.delete(row._id);

    return { ok: true, counts };
  },
});

// Small per-user tables that deleteUserCascade sweeps inline. Bulk tables
// (the mail corpus, calendar events) would blow Convex's
// per-transaction limits on a real mailbox, so they drain through
// purgeUserDataBatch instead. tests/account-cascade-coverage.test.ts fails when
// a schema table with a userId field is in neither list.
export const USER_INLINE_TABLES = [
  'connectedAccounts',
  'mailOutbox',
  'providerGrants',
  'nylasOAuthStates',
  'aiSettings',
  'aiProviderKeys',
  'aiEntitlements',
  'aiUsagePeriods',
  'aiCostWatch',
  'mailSyncStates',
  'rateLimits',
  'suggestions',
  'calendars',
  'calendarSyncStates',
  'contactSyncStates',
  'albatrossDevRecords',
  'albatrossProjects',
  'albatrossProjectLinks',
  'albatrossSprints',
  'albatrossApprovals',
  'albatrossPlanApplications',
  'completionEvents',
  'albatrossIntents',
  'albatrossIntentPlans',
  'albatrossCaptures',
  'albatrossWorkQuestions',
  'albatrossAreaBriefs',
  'albatrossNotificationPreferences',
  'webPushSubscriptions',
  'mobilePushDevices',
  'mobileSyncHeads',
  'albatrossDailyCheckins',
  'albatrossBrowserSessions',
  'albatrossStepRuns',
  'albatrossBrowserContexts',
  'personalDetails',
  // Secure details (docs/albatross-secure-store.md): at most 100 items, and
  // grants that end within two hours. Their use history drains in batches.
  'secureItems',
  'secureGrants',
  'areas',
  'mcpConnections',
  'mcpCredentials',
  'mcpOAuthStates',
  'mcpSyncStates',
  'mcpTaskLinks',
  'cloudFileConnections',
  'cloudFileCredentials',
  'cloudFileOAuthStates',
  'cloudFileOAuthCompletions',
  'googleMailOAuthStates',
  'googleSecurityAudit',
  // Gmail watch and Calendar/Drive channel rows (convex/googlePush.ts).
  'googlePushChannels',
  'oauthCompletions',
  'documents',
  'documentSuggestions',
  'documentImportCancellations',
  // Control rows go inline so the narrative and content crons stop
  // dispatching for this user at once; their bulk rows drain in batches.
  'narrativeSettings',
  'narrativeCursors',
  'narrativeExclusions',
  'contentSync',
] as const;

// userId tables that the cascade deletes through their own pass, not through
// the lists above. The value says where.
export const CASCADE_SPECIAL_TABLES: Record<string, string> = {
  agentUploads: 'deleteUserCascade deletes each upload with its stored file (by_user_created).',
  boardMembers: 'deleteUserCascade removes memberships on owned and foreign boards.',
  cards: 'deleteUserCascade removes cards on owned boards and cards the user wrote.',
  contentChunks: 'purgeUserDataBatch deletes the chunks of each contentItems row (by_item).',
  contactEmails: 'Both purges delete the address rows of each contacts row (by_contact).',
};

// userId tables that stay after account deletion. Each entry must give the
// reason. Keep this empty unless there is a legal or operational need.
export const CASCADE_EXEMPT_TABLES: Record<string, string> = {};

async function rowsByUser(ctx: any, table: string, userId: string) {
  let lastErr: unknown;
  for (const index of USER_INDEXES) {
    try {
      return await ctx.db
        .query(table)
        .withIndex(index as any, (q: any) => q.eq('userId', userId))
        .collect();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Whether the user already made or imported any document. Settings, Advanced
 * starts "Show Files" on for these users and off for everyone else.
 */
export const hasDocuments = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const documents = await ctx.db
      .query('documents')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(25);
    if (documents.some((row) => !row.archivedAt)) return true;
    const office = await ctx.db
      .query('officeDocuments')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .first();
    return office !== null;
  },
});

// ---------------------------------------------------------------------------
// Data export (Settings, Account, Export my data)
// ---------------------------------------------------------------------------

// Tables in the deletion cascade that the export leaves out, with the reason.
export const EXPORT_SKIPPED_TABLES: Record<string, string> = {
  contentChunks: 'Search chunks and embeddings derived from contentItems, which the export includes.',
  contactEmails: 'Address lookup rows derived from contacts, which the export includes.',
  correspondents: 'Recipient-search counts derived from mailCorpusMessages, which the export includes.',
  nylasOAuthStates: 'Short-lived sign-in state for a mailbox connection, not user content.',
  mcpOAuthStates: 'Short-lived sign-in state for a tool connection, not user content.',
  cloudFileOAuthStates: 'Short-lived sign-in state for a file connection, not user content.',
  cloudFileOAuthCompletions: 'Short-lived sign-in state for a file connection, not user content.',
  googleMailOAuthStates: 'Short-lived sign-in state for a mailbox connection, not user content.',
  googlePushChannels: 'Push channel state (ids, expiry times, token hashes), not user content.',
  oauthCompletions: 'Short-lived sign-in state for a mailbox or tool connection, not user content.',
  rateLimits: 'Request counters that protect the service, not user content.',
  aiCostWatch: 'Cost samples for the owner alarm that protect the service, not user content.',
  mailAttachmentQueue: 'Work rows of the attachment file queue; mailAttachmentFiles has the stored files.',
  mailAttachmentBackfills: 'The page cursor of the attachment file queue, not user content.',
  albatrossBrowserContexts:
    'The Browserbase id of the saved sign-ins. It is a service handle to browser cookies, not user content, so it never leaves the service.',
  personalDetails:
    'The rows hold only encrypted values. The export writes them decrypted in personal-details.json instead (lib/hosted/data-export.ts).',
  secureItems:
    'The rows hold sealed passwords, ID numbers, and keys. The export writes secure-items.json instead: each item with its label, kind, sites, and facts, never a value (lib/hosted/data-export.ts).',
};

/**
 * Every table the export writes, one JSON file each. It follows the deletion
 * cascade, so a table that the cascade learns about is exported too.
 */
export const EXPORT_TABLES: readonly string[] = [
  ...new Set<string>([
    'users',
    ...USER_INLINE_TABLES,
    ...USER_BULK_TABLES,
    ...Object.keys(CASCADE_SPECIAL_TABLES),
    'boards',
    'boardColumns',
  ]),
].filter((table) => !(table in EXPORT_SKIPPED_TABLES));

/** The first userId-prefixed index of a table, read from the schema. */
export function exportUserIndex(table: string): string | undefined {
  const definition = (schema.tables as Record<string, any>)[table];
  const names = new Set<string>(
    (definition?.[' indexes']?.() ?? []).map((index: { indexDescriptor: string }) => index.indexDescriptor),
  );
  return USER_INDEXES.find((index) => names.has(index));
}

export const exportTableList = query({
  args: { internalSecret: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return [...EXPORT_TABLES];
  },
});

/** One page of one table for one user, with secrets removed. */
export const exportUserTablePage = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!EXPORT_TABLES.includes(args.table)) throw new Error('This table is not part of the export.');
    const numItems = Math.min(Math.max(Math.floor(args.numItems), 1), 200);
    const done = (rows: any[]) => ({
      page: rows.map((row) => redactExportRow(args.table, row)),
      isDone: true,
      continueCursor: '',
    });
    if (args.table === 'users') {
      return done(
        await ctx.db
          .query('users')
          .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
          .collect(),
      );
    }
    if (args.table === 'boardColumns') {
      // Columns carry no userId; they belong to the boards the user owns.
      const boards = await ctx.db
        .query('boards')
        .withIndex('by_owner', (q) => q.eq('ownerUserId', args.userId))
        .take(200);
      const columns: any[] = [];
      for (const board of boards)
        columns.push(
          ...(await ctx.db
            .query('boardColumns')
            .withIndex('by_board', (q) => q.eq('boardId', board._id))
            .collect()),
        );
      return done(columns);
    }
    const opts = { cursor: args.cursor, numItems };
    let result: any;
    if (args.table === 'boards') {
      result = await ctx.db
        .query('boards')
        .withIndex('by_owner', (q) => q.eq('ownerUserId', args.userId))
        .paginate(opts);
    } else {
      // One paginated read only: Convex allows one `.paginate()` in each
      // function, so a failed try on a missing index cannot fall through.
      const index = exportUserIndex(args.table);
      if (!index) throw new Error('This table has no user index.');
      result = await ctx.db
        .query(args.table as any)
        .withIndex(index as any, (q: any) => q.eq('userId', args.userId))
        .paginate(opts);
    }
    return {
      page: result.page.map((row: any) => redactExportRow(args.table, row)),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
