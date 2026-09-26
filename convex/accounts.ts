import { v } from 'convex/values';
import { redactExportRow } from '../lib/hosted/export-redaction';
import { pickAccountForGrant } from '../lib/mail/grant-account';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

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
      await ctx.db.patch(row._id, { status: 'error', error: truncateText(args.reason, 300), updatedAt: ts });
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

// Bulk per-account tables are purged in scheduled batches: a whole mailbox
// corpus cannot be deleted inside one Convex transaction (it exceeds the
// per-transaction document limits, which is exactly how account removal used
// to 500 and strand orphan rows).
export const ACCOUNT_BULK_TABLES = [
  'mailCorpusThreads',
  'mailCorpusMessages',
  // Custom-label membership rows point at corpus threads (CLS-13).
  'mailLabelMembership',
  'mailWebhookEvents',
  // One-time codes are live authentication secrets. They expire on their own,
  // but a disconnected account's codes must not outlive the disconnection.
  'mailOneTimeCodes',
  // Snooze rows would otherwise keep waking threads of a removed mailbox.
  'mailSnoozes',
  'calendarEvents',
  'areaArtifactLinks',
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
  // Shared narrative memory and connected content grow with the mailbox.
  // Each contentItems row takes its contentChunks with it (see below).
  'narrativeEntries',
  'narrativeRuns',
  'contentItems',
  'briefPreparations',
] as const;

const PURGE_BATCH = 250;
// A content item has at most ~34 embedding chunks, so a few items per pass
// keep one purge transaction far below the Convex read limits.
const CONTENT_ITEMS_PER_PASS = 5;
// A document model row can be close to 1 MiB.
const DOCUMENT_MODELS_PER_PASS = 8;
// Tables expose one of these userId-prefixed indexes; try each in turn.
export const USER_INDEXES = ['by_user', 'by_user_account', 'by_user_key', 'by_user_created'] as const;

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
    let deleted = 0;
    for (const table of USER_BULK_TABLES) {
      if (deleted >= PURGE_BATCH) break;
      const remaining = PURGE_BATCH - deleted;
      const rows = await takeByUser(
        ctx,
        table,
        args.userId,
        table === 'contentItems'
          ? Math.min(remaining, CONTENT_ITEMS_PER_PASS)
          : table === 'documentModels'
            ? Math.min(remaining, DOCUMENT_MODELS_PER_PASS)
            : remaining,
      );
      for (const row of rows) {
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
          for (const chunk of chunks) await ctx.db.delete(chunk._id);
          deleted += chunks.length;
        }
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    if (deleted > 0) {
      await ctx.scheduler.runAfter(0, internal.accounts.purgeUserDataBatch, args);
    }
    return { deleted };
  },
});

export const purgeAccountDataBatch = internalMutation({
  args: { userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const table of ACCOUNT_BULK_TABLES) {
      if (deleted >= PURGE_BATCH) break;
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user_account' as any, (q: any) =>
          q.eq('userId', args.userId).eq('accountId', args.accountId),
        )
        .take(PURGE_BATCH - deleted);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    if (deleted > 0) {
      await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDataBatch, args);
    }
    return { deleted };
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
    // Small tables go inline so the account vanishes from the UI immediately;
    // the bulk corpus drains in scheduled batches right after.
    const smallTables = [
      'connectedAccounts',
      'providerGrants',
      'mailSyncStates',
      'calendars',
      'calendarSyncStates',
    ] as const;
    for (const table of smallTables) {
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
  'aiUsageEvents',
  'mailSyncStates',
  'rateLimits',
  'userDocs',
  'aiOperations',
  'suggestions',
  'calendars',
  'calendarSyncStates',
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
  'albatrossNotifications',
  'albatrossNotificationPreferences',
  'webPushSubscriptions',
  'mobilePushDevices',
  'mobileSyncHeads',
  'notificationDeliveries',
  'albatrossDailyCheckins',
  'albatrossBrowserSessions',
  'areas',
  'mcpConnections',
  'mcpCredentials',
  'mcpOAuthStates',
  'mcpItems',
  'mcpSyncStates',
  'mcpTaskLinks',
  'cloudFileConnections',
  'cloudFileCredentials',
  'cloudFileOAuthStates',
  'cloudFileOAuthCompletions',
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
  nylasOAuthStates: 'Short-lived sign-in state for a mailbox connection, not user content.',
  mcpOAuthStates: 'Short-lived sign-in state for a tool connection, not user content.',
  cloudFileOAuthStates: 'Short-lived sign-in state for a file connection, not user content.',
  cloudFileOAuthCompletions: 'Short-lived sign-in state for a file connection, not user content.',
  rateLimits: 'Request counters that protect the service, not user content.',
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
      let lastErr: unknown;
      for (const index of USER_INDEXES) {
        try {
          result = await ctx.db
            .query(args.table as any)
            .withIndex(index as any, (q: any) => q.eq('userId', args.userId))
            .paginate(opts);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!result) throw lastErr;
    }
    return {
      page: result.page.map((row: any) => redactExportRow(args.table, row)),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
