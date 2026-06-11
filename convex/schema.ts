import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_clerk_user_id', ['clerkUserId'])
    .index('by_email', ['email']),

  connectedAccounts: defineTable({
    userId: v.string(),
    accountId: v.string(),
    email: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    status: v.union(v.literal('connected'), v.literal('disconnected'), v.literal('error')),
    displayName: v.optional(v.string()),
    scopes: v.array(v.string()),
    grantId: v.string(),
    lastSyncedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId']),

  providerGrants: defineTable({
    userId: v.string(),
    accountId: v.string(),
    provider: v.string(),
    grantId: v.string(),
    email: v.string(),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scopes: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId']),

  nylasOAuthStates: defineTable({
    state: v.string(),
    userId: v.string(),
    provider: v.string(),
    redirectTo: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index('by_state', ['state'])
    .index('by_user', ['userId']),

  aiSettings: defineTable({
    userId: v.string(),
    mode: v.union(v.literal('lab86'), v.literal('byok')),
    provider: v.optional(v.union(v.literal('openrouter'), v.literal('openai'), v.literal('anthropic'))),
    model: v.optional(v.string()),
    fastModel: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  aiProviderKeys: defineTable({
    userId: v.string(),
    provider: v.union(v.literal('openrouter'), v.literal('openai'), v.literal('anthropic')),
    encryptedKey: v.string(),
    fingerprint: v.string(),
    masked: v.string(),
    validatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_provider', ['userId', 'provider']),

  aiEntitlements: defineTable({
    userId: v.string(),
    plan: v.union(v.literal('free'), v.literal('pro'), v.literal('admin')),
    status: v.union(
      v.literal('inactive'),
      v.literal('active'),
      v.literal('trialing'),
      v.literal('past_due'),
      v.literal('canceled'),
    ),
    source: v.union(v.literal('manual'), v.literal('stripe'), v.literal('clerk')),
    monthlyCredits: v.number(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_stripe_customer', ['stripeCustomerId'])
    .index('by_stripe_subscription', ['stripeSubscriptionId']),

  aiUsagePeriods: defineTable({
    userId: v.string(),
    period: v.string(),
    source: v.union(v.literal('lab86'), v.literal('byok')),
    creditsUsed: v.number(),
    calls: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_period_source', ['userId', 'period', 'source'])
    .index('by_user', ['userId']),

  aiUsageEvents: defineTable({
    userId: v.string(),
    feature: v.string(),
    source: v.union(v.literal('lab86'), v.literal('byok')),
    provider: v.string(),
    model: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    estimatedCredits: v.number(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_created', ['userId', 'createdAt']),

  threads: defineTable({
    userId: v.string(),
    accountId: v.string(),
    providerThreadId: v.string(),
    subject: v.string(),
    fromAddress: v.string(),
    lastDate: v.number(),
    snippet: v.string(),
    labels: v.array(v.string()),
    unread: v.boolean(),
    starred: v.optional(v.boolean()),
    cachedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account_thread', ['accountId', 'providerThreadId']),

  messages: defineTable({
    userId: v.string(),
    accountId: v.string(),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    subject: v.string(),
    from: v.string(),
    to: v.string(),
    cc: v.optional(v.string()),
    bcc: v.optional(v.string()),
    date: v.number(),
    snippet: v.string(),
    textBodyEncrypted: v.optional(v.string()),
    htmlBodyEncrypted: v.optional(v.string()),
    labels: v.array(v.string()),
    attachments: v.array(v.any()),
    headers: v.any(),
    cachedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account_thread', ['accountId', 'providerThreadId'])
    .index('by_account_message', ['accountId', 'providerMessageId']),

  mailCorpusThreads: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    providerThreadId: v.string(),
    subject: v.string(),
    fromAddress: v.string(),
    lastDate: v.number(),
    snippet: v.string(),
    labels: v.array(v.string()),
    unread: v.boolean(),
    starred: v.optional(v.boolean()),
    messageCount: v.optional(v.number()),
    // Smart classification is computed at write time (see convex/smart.ts):
    // the full verdict for the UI, plus flattened fields the indexes can key.
    smartCategory: v.optional(v.any()),
    smartPrimary: v.optional(v.string()),
    smartCustomKeys: v.optional(v.array(v.string())),
    classifiedAt: v.optional(v.number()),
    yearMonth: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_user_lastDate', ['userId', 'lastDate'])
    .index('by_grant', ['grantId'])
    .index('by_account', ['accountId'])
    .index('by_account_thread', ['accountId', 'providerThreadId'])
    .index('by_user_account_thread', ['userId', 'accountId', 'providerThreadId'])
    .index('by_user_account_updated', ['userId', 'accountId', 'lastDate'])
    .index('by_user_primary_lastDate', ['userId', 'smartPrimary', 'lastDate'])
    .index('by_user_account_primary_lastDate', ['userId', 'accountId', 'smartPrimary', 'lastDate'])
    // Backlog sweep: rows without smartPrimary sort first under undefined.
    .index('by_smart_primary', ['smartPrimary']),

  mailCorpusMessages: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    subject: v.string(),
    from: v.string(),
    to: v.string(),
    cc: v.optional(v.string()),
    bcc: v.optional(v.string()),
    receivedAt: v.number(),
    snippet: v.string(),
    textBody: v.optional(v.string()),
    // Full HTML body, stored at sync time so opening a thread never has to
    // round-trip to the provider. Missing on rows synced before this existed;
    // the read path hydrates those lazily.
    htmlBody: v.optional(v.string()),
    searchText: v.string(),
    labels: v.array(v.string()),
    unread: v.optional(v.boolean()),
    starred: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.any())),
    headers: v.optional(v.any()),
    yearMonth: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId'])
    .index('by_account', ['accountId'])
    .index('by_account_thread', ['accountId', 'providerThreadId'])
    .index('by_user_account_thread_received', ['userId', 'accountId', 'providerThreadId', 'receivedAt'])
    .index('by_account_message', ['accountId', 'providerMessageId'])
    .index('by_user_account_received', ['userId', 'accountId', 'receivedAt'])
    .searchIndex('by_search_text', {
      searchField: 'searchText',
      filterFields: ['userId', 'accountId', 'grantId', 'provider', 'yearMonth'],
    }),

  // Generic per-user document store backing all server-side app state that
  // previously lived in the single-tenant NeDB files (memories, smart labels,
  // tracked threads, drafts, chat, prefs, caches, ...). `kind` namespaces the
  // record type, `key` is the stable identity within a kind, and `ref` is an
  // optional secondary lookup (e.g. account or threadId).
  userDocs: defineTable({
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
    ref: v.optional(v.string()),
    doc: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_kind', ['userId', 'kind'])
    .index('by_user_kind_updatedAt', ['userId', 'kind', 'updatedAt'])
    .index('by_user_kind_key', ['userId', 'kind', 'key'])
    .index('by_user_kind_ref', ['userId', 'kind', 'ref'])
    .index('by_user_kind_ref_updatedAt', ['userId', 'kind', 'ref', 'updatedAt']),

  mailSyncStates: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    status: v.union(
      v.literal('idle'),
      v.literal('backfilling'),
      v.literal('syncing'),
      v.literal('ready'),
      v.literal('error'),
    ),
    cursor: v.optional(v.string()),
    historyId: v.optional(v.string()),
    deltaLink: v.optional(v.string()),
    corpusReady: v.boolean(),
    progress: v.optional(v.any()),
    error: v.optional(v.string()),
    messagesSynced: v.optional(v.number()),
    oldestIndexedAt: v.optional(v.number()),
    lastBackfillAt: v.optional(v.number()),
    lastIncrementalSyncAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId'])
    .index('by_account', ['accountId'])
    .index('by_status', ['status']),

  mailWebhookEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    userId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    grantId: v.optional(v.string()),
    provider: v.optional(
      v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    ),
    payload: v.any(),
    status: v.union(v.literal('received'), v.literal('processed'), v.literal('error')),
    error: v.optional(v.string()),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
  })
    .index('by_event', ['eventId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account', ['accountId'])
    .index('by_grant', ['grantId'])
    .index('by_status', ['status'])
    .index('by_received', ['receivedAt']),

  dailyReports: defineTable({
    userId: v.string(),
    accountIds: v.array(v.string()),
    kind: v.string(),
    title: v.string(),
    generatedAt: v.number(),
    payload: v.any(),
  })
    .index('by_user', ['userId'])
    .index('by_user_generated', ['userId', 'generatedAt']),

  memories: defineTable({
    userId: v.string(),
    email: v.string(),
    notes: v.string(),
    sourceAccountIds: v.array(v.string()),
    userPinned: v.boolean(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_email', ['userId', 'email']),

  auditEvents: defineTable({
    userId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    tool: v.string(),
    args: v.any(),
    result: v.string(),
    detail: v.optional(v.string()),
    agent: v.string(),
    ts: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_ts', ['ts']),

  syncJobs: defineTable({
    userId: v.string(),
    accountId: v.string(),
    kind: v.string(),
    status: v.union(v.literal('queued'), v.literal('running'), v.literal('ok'), v.literal('error')),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_account', ['accountId']),

  rateLimits: defineTable({
    userId: v.string(),
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_key_window', ['userId', 'key', 'windowStart'])
    .index('by_expires', ['expiresAt']),
});
