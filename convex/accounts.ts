import { v } from 'convex/values';
import { internal } from './_generated/api';
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
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .unique();
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
      await ctx.db.patch(syncState._id, { provider: args.provider, updatedAt: ts });
    }
    return { accountId: id, replacedGrantId };
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
    const displayName = (args.displayName || '').trim().slice(0, 80) || undefined;
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
const ACCOUNT_BULK_TABLES = [
  'threads',
  'messages',
  'mailCorpusThreads',
  'mailCorpusMessages',
  'mailWebhookEvents',
  'calendarEvents',
  'calendarEventCorpus',
  'areaArtifactLinks',
] as const;

const USER_BULK_TABLES = [
  ...ACCOUNT_BULK_TABLES,
  'areaFacts',
  'areaReindexRuns',
  'albatrossRoutines',
  'albatrossRoutineRuns',
  'albatrossEvidence',
] as const;

const PURGE_BATCH = 250;

// Whole-user purge twin of purgeAccountDataBatch: account deletion already
// batches, and user deletion must too — a populated mailbox exceeds Convex's
// per-transaction limits if swept inline.
export const purgeUserDataBatch = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const table of USER_BULK_TABLES) {
      if (deleted >= PURGE_BATCH) break;
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user' as any, (q: any) => q.eq('userId', args.userId))
        .take(PURGE_BATCH - deleted)
        .catch(async () =>
          ctx.db
            .query(table)
            .withIndex('by_user_account' as any, (q: any) => q.eq('userId', args.userId))
            .take(PURGE_BATCH - deleted),
        );
      for (const row of rows) {
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
    // Index per table — syncJobs only has by_account; assuming
    // by_user_account everywhere is exactly how this mutation Server-Errored.
    const smallTables: Array<[string, 'by_user_account' | 'by_account']> = [
      ['connectedAccounts', 'by_user_account'],
      ['providerGrants', 'by_user_account'],
      ['syncJobs', 'by_account'],
      ['mailSyncStates', 'by_user_account'],
      ['calendars', 'by_user_account'],
      ['calendarSyncStates', 'by_user_account'],
    ];
    for (const [table, index] of smallTables) {
      const rows =
        index === 'by_account'
          ? await ctx.db
              .query(table as any)
              .withIndex('by_account' as any, (q: any) => q.eq('accountId', args.accountId))
              .collect()
          : await ctx.db
              .query(table as any)
              .withIndex('by_user_account' as any, (q: any) =>
                q.eq('userId', args.userId).eq('accountId', args.accountId),
              )
              .collect();
      for (const row of rows) {
        if (row.userId && row.userId !== args.userId) continue;
        await ctx.db.delete(row._id);
      }
    }
    await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountDataBatch, {
      userId: args.userId,
      accountId: args.accountId,
    });

    const reports = await ctx.db
      .query('dailyReports')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const report of reports) {
      if (report.accountIds.includes(args.accountId)) await ctx.db.delete(report._id);
    }

    const memories = await ctx.db
      .query('memories')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const memory of memories) {
      if (!memory.sourceAccountIds.includes(args.accountId)) continue;
      const remaining = memory.sourceAccountIds.filter((id) => id !== args.accountId);
      if (memory.userPinned) {
        await ctx.db.patch(memory._id, { sourceAccountIds: remaining, updatedAt: now() });
      } else if (remaining.length) {
        await ctx.db.patch(memory._id, { sourceAccountIds: remaining, updatedAt: now() });
      } else {
        await ctx.db.delete(memory._id);
      }
    }
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
    const counts: Record<string, number> = {};
    // Small tables sweep inline. Bulk tables ('threads', 'messages',
    // 'mailCorpusThreads', 'mailCorpusMessages', 'mailWebhookEvents',
    // 'calendarEvents', 'calendarEventCorpus') would blow Convex's per-transaction limits on a real
    // mailbox, so they drain through the scheduled purge instead.
    const userTables = [
      'connectedAccounts',
      'providerGrants',
      'nylasOAuthStates',
      'aiSettings',
      'aiProviderKeys',
      'aiEntitlements',
      'aiUsagePeriods',
      'aiUsageEvents',
      'dailyReports',
      'memories',
      'auditEvents',
      'syncJobs',
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
      'notificationDeliveries',
      'albatrossDailyCheckins',
      'areas',
      'mcpConnections',
      'mcpCredentials',
      'mcpItems',
      'mcpSyncStates',
      'mcpTaskLinks',
    ] as const;

    for (const table of userTables) {
      const rows = await rowsByUser(ctx, table, args.userId);
      counts[table] = rows.length;
      for (const row of rows) await ctx.db.delete(row._id);
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

async function rowsByUser(ctx: any, table: string, userId: string) {
  // Tables expose one of these userId-prefixed indexes; try each in turn.
  const indexes = ['by_user', 'by_user_account', 'by_user_created'];
  let lastErr: unknown;
  for (const index of indexes) {
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
