import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
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
    // LLM-once classification: threads the deterministic pass isn't sure about
    // get exactly one model verdict (nano tier), persisted here forever.
    // llmPending flags rows awaiting that verdict; user rules always override.
    llmCategory: v.optional(v.any()),
    llmClassifiedAt: v.optional(v.number()),
    llmPending: v.optional(v.boolean()),
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
    // Rail badges: unread-per-category is an indexed range read, never a scan.
    .index('by_user_primary_unread', ['userId', 'smartPrimary', 'unread', 'lastDate'])
    .index('by_user_account_primary_unread', ['userId', 'accountId', 'smartPrimary', 'unread', 'lastDate'])
    .index('by_user_llm_pending', ['userId', 'llmPending', 'lastDate'])
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

  // Calendar corpus: two-way Nylas sync mirroring the mail-corpus pattern.
  // Calendars are listed per grant; events are synced inside a rolling window
  // with expand_recurring, so recurring instances arrive pre-expanded (each
  // carries masterEventId back to its series master for edit semantics).
  calendars: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    providerCalendarId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    timezone: v.optional(v.string()),
    isPrimary: v.optional(v.boolean()),
    readOnly: v.optional(v.boolean()),
    // Provider-reported hex color; the UI maps it into the OKLCH family.
    hexColor: v.optional(v.string()),
    // User-chosen Tableau-10 palette slot (0-9); unset = assigned by order.
    colorIndex: v.optional(v.number()),
    // User pref: hide this calendar from the merged view (still synced).
    hidden: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account_calendar', ['accountId', 'providerCalendarId'])
    .index('by_grant', ['grantId']),

  calendarEvents: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    providerEventId: v.string(),
    providerCalendarId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    status: v.optional(v.string()),
    busy: v.optional(v.boolean()),
    readOnly: v.optional(v.boolean()),
    // Epoch ms. All-day events carry allDay=true with day-granularity bounds.
    startAt: v.number(),
    endAt: v.number(),
    allDay: v.optional(v.boolean()),
    startTimezone: v.optional(v.string()),
    endTimezone: v.optional(v.string()),
    // Series master id when this row is an expanded recurring instance.
    masterEventId: v.optional(v.string()),
    // RRULE lines when this row is itself a series master.
    recurrence: v.optional(v.array(v.string())),
    participants: v.optional(v.array(v.any())),
    organizer: v.optional(v.any()),
    conferencing: v.optional(v.any()),
    icalUid: v.optional(v.string()),
    htmlLink: v.optional(v.string()),
    // Corpus fields: new/updated rows get normalized text for local search.
    // Optional so existing mirrored rows remain valid until their next sync.
    searchText: v.optional(v.string()),
    yearMonth: v.optional(v.string()),
    providerUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_start', ['userId', 'startAt'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account_event', ['accountId', 'providerEventId'])
    .index('by_account_calendar_event', ['accountId', 'providerCalendarId', 'providerEventId'])
    .index('by_account_master', ['accountId', 'masterEventId'])
    .index('by_user_account_calendar_start', ['userId', 'accountId', 'providerCalendarId', 'startAt'])
    .index('by_grant', ['grantId']),

  calendarEventCorpus: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    providerEventId: v.string(),
    providerCalendarId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    status: v.optional(v.string()),
    busy: v.optional(v.boolean()),
    readOnly: v.optional(v.boolean()),
    startAt: v.number(),
    endAt: v.number(),
    allDay: v.optional(v.boolean()),
    startTimezone: v.optional(v.string()),
    endTimezone: v.optional(v.string()),
    masterEventId: v.optional(v.string()),
    recurrence: v.optional(v.array(v.string())),
    participants: v.optional(v.array(v.any())),
    organizer: v.optional(v.any()),
    conferencing: v.optional(v.any()),
    icalUid: v.optional(v.string()),
    htmlLink: v.optional(v.string()),
    searchText: v.string(),
    yearMonth: v.string(),
    providerUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_start', ['userId', 'startAt'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_account_event', ['accountId', 'providerEventId'])
    .index('by_account_calendar_event', ['accountId', 'providerCalendarId', 'providerEventId'])
    .index('by_user_account_calendar_start', ['userId', 'accountId', 'providerCalendarId', 'startAt'])
    .index('by_grant', ['grantId'])
    .searchIndex('by_search_text', {
      searchField: 'searchText',
      filterFields: ['userId', 'accountId', 'providerCalendarId', 'provider', 'yearMonth'],
    }),

  calendarSyncStates: defineTable({
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
    status: v.union(
      v.literal('idle'),
      v.literal('syncing'),
      v.literal('ready'),
      v.literal('error'),
      // The grant lacks calendar scope; clears on a successful sync after
      // the account is re-connected with calendar access.
      v.literal('unauthorized'),
    ),
    error: v.optional(v.string()),
    calendarsSynced: v.optional(v.number()),
    eventsSynced: v.optional(v.number()),
    // Bounds of the synced event window (epoch ms).
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastIncrementalSyncAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    lastHistoryBackfillAt: v.optional(v.number()),
    historyCursorEnd: v.optional(v.number()),
    historyWindowStart: v.optional(v.number()),
    historyBackfillReady: v.optional(v.boolean()),
    progress: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId']),

  agentUploads: defineTable({
    userId: v.string(),
    storageId: v.id('_storage'),
    name: v.string(),
    contentType: v.optional(v.string()),
    size: v.number(),
    createdAt: v.number(),
  })
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_storage', ['storageId']),

  // Kanban (docs/productivity-platform-spec.md M2). Boards are shareable:
  // memberships carry roles, and a publicToken exposes a read-only view with
  // no account. Cards keep provenance back to the email/chat that spawned
  // them. Ordering is fractional (midpoint insertion, renumber on exhaustion)
  // so a drag writes one row, not a column's worth.
  boards: defineTable({
    ownerUserId: v.string(),
    title: v.string(),
    publicToken: v.optional(v.string()),
    isDefault: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_owner', ['ownerUserId'])
    .index('by_public_token', ['publicToken']),

  boardMembers: defineTable({
    boardId: v.id('boards'),
    // Invites are by email and may precede the invitee's first sign-in;
    // userId links on their first board list after signup.
    userId: v.optional(v.string()),
    email: v.string(),
    role: v.union(v.literal('member'), v.literal('viewer')),
    invitedBy: v.string(),
    status: v.union(v.literal('invited'), v.literal('active')),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_board', ['boardId'])
    .index('by_user', ['userId'])
    .index('by_email', ['email']),

  boardColumns: defineTable({
    boardId: v.id('boards'),
    name: v.string(),
    order: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_board', ['boardId']),

  cards: defineTable({
    boardId: v.id('boards'),
    columnId: v.id('boardColumns'),
    // Creator. Cards on shared boards survive their creator's account
    // deletion only if the board belongs to someone else (see cascade).
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    priority: v.optional(v.union(v.literal('low'), v.literal('medium'), v.literal('high'))),
    weight: v.optional(v.number()),
    // Assigned board members (by email; resolved against boardMembers/owner).
    assignees: v.optional(v.array(v.string())),
    dueAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    order: v.number(),
    // Attachments: pasted links carry url; uploaded files carry a Convex
    // storage id (URL resolved at read time).
    attachments: v.optional(
      v.array(
        v.object({
          name: v.string(),
          url: v.optional(v.string()),
          storageId: v.optional(v.id('_storage')),
          contentType: v.optional(v.string()),
          size: v.optional(v.number()),
        }),
      ),
    ),
    // Embedded comment thread; boards are small-team, so no separate table.
    comments: v.optional(
      v.array(
        v.object({
          id: v.string(),
          authorUserId: v.string(),
          authorEmail: v.optional(v.string()),
          body: v.string(),
          createdAt: v.number(),
        }),
      ),
    ),
    // Provenance chip: where this card came from.
    source: v.optional(v.any()),
    sourceThreadId: v.optional(v.string()),
    sourceCalendarEventId: v.optional(v.string()),
    sourceAccountId: v.optional(v.string()),
    // Per-card audit trail (sse-era parity): every mutation appends.
    activity: v.optional(
      v.array(
        v.object({
          id: v.string(),
          actorUserId: v.string(),
          actorEmail: v.optional(v.string()),
          action: v.string(),
          detail: v.optional(v.string()),
          createdAt: v.number(),
        }),
      ),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_board', ['boardId'])
    .index('by_column_order', ['columnId', 'order'])
    .index('by_user', ['userId'])
    .index('by_user_source_thread', ['userId', 'sourceThreadId'])
    .index('by_user_source_calendar_event', ['userId', 'sourceCalendarEventId'])
    .index('by_user_due', ['userId', 'dueAt']),

  // Every mutating action the AI (or a user clicking an AI suggestion) applies
  // to mail/calendar/tasks. `inverse` is a declarative undo descriptor executed
  // by lib/ai/operations.ts; rows without one are not undoable. `batchId`
  // groups the operations of a single agent turn into one reviewable
  // change-set ("created 4 events, 10 tasks").
  aiOperations: defineTable({
    userId: v.string(),
    agent: v.union(v.literal('user'), v.literal('ai')),
    tool: v.string(),
    surface: v.union(v.literal('mail'), v.literal('calendar'), v.literal('tasks')),
    summary: v.string(),
    batchId: v.optional(v.string()),
    chatId: v.optional(v.string()),
    // What was touched: { kind, id, accountId?, ... } — shape owned by the
    // surface that recorded it; the UI only needs kind/id for deep links.
    target: v.any(),
    inverse: v.optional(v.object({ kind: v.string(), payload: v.any() })),
    status: v.union(v.literal('applied'), v.literal('undone'), v.literal('undo_failed')),
    error: v.optional(v.string()),
    createdAt: v.number(),
    undoneAt: v.optional(v.number()),
  })
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_user_batch', ['userId', 'batchId'])
    .index('by_user_status_created', ['userId', 'status', 'createdAt']),

  // Proactive-agent proposals (task drafts, detected events, automations).
  // Nothing here touches real calendars or boards until accepted; accepting
  // runs the normal tool path and records an aiOperation. `dedupeKey` keeps
  // re-scans of the same email from piling up duplicate suggestions.
  suggestions: defineTable({
    userId: v.string(),
    kind: v.union(v.literal('task'), v.literal('event'), v.literal('automation')),
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('dismissed'),
      v.literal('expired'),
    ),
    title: v.string(),
    payload: v.any(),
    // Where this came from: { source: 'email'|'sweep'|'chat', accountId?,
    // threadId?, messageId? } — rendered as a provenance chip in the tray.
    provenance: v.any(),
    dedupeKey: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index('by_user_status_created', ['userId', 'status', 'createdAt'])
    .index('by_user_dedupe', ['userId', 'dedupeKey'])
    .index('by_user_created', ['userId', 'createdAt']),

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

  // --- MCP connectors: remote MCP servers/APIs a user opts
  // into so their items feed the Daily Brief, search, and tasks. Mirrors the
  // connectedAccounts/providerGrants split — display row here, secrets in
  // mcpCredentials, normalized items in mcpItems. ---
  mcpConnections: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.union(v.literal('github'), v.literal('bitbucket'), v.literal('jira'), v.literal('slack')),
    serverUrl: v.string(),
    authKind: v.union(v.literal('token'), v.literal('oauth')),
    status: v.union(v.literal('connected'), v.literal('disconnected'), v.literal('error')),
    displayName: v.optional(v.string()),
    scopes: v.array(v.string()),
    // Per-connection toggles — opt-in by default with opt-out, per the design.
    includeInBrief: v.boolean(),
    includeInSearch: v.boolean(),
    lastSyncedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_server', ['server']),

  mcpCredentials: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    masked: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_connection', ['userId', 'connectionId']),

  mcpItems: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.union(v.literal('github'), v.literal('bitbucket'), v.literal('jira'), v.literal('slack')),
    externalId: v.string(),
    kind: v.string(),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    state: v.optional(v.string()),
    author: v.optional(v.string()),
    assignedToUser: v.optional(v.boolean()),
    updatedAtSource: v.optional(v.number()),
    raw: v.optional(v.any()),
    searchText: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_connection_external', ['connectionId', 'externalId'])
    .index('by_user_updated', ['userId', 'updatedAtSource'])
    .searchIndex('by_search_text', {
      searchField: 'searchText',
      filterFields: ['userId', 'server', 'connectionId', 'state'],
    }),

  mcpSyncStates: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    status: v.union(v.literal('idle'), v.literal('syncing'), v.literal('ready'), v.literal('error')),
    lastSyncedAt: v.optional(v.number()),
    lastCursor: v.optional(v.string()),
    itemCount: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_connection', ['userId', 'connectionId']),

  // Links a Lab86 task card to the external MCP item it was created from, so
  // closing the item (during sync) can auto-complete the task — "external wins
  // for status, user wins for intent".
  mcpTaskLinks: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    externalId: v.string(),
    cardId: v.string(),
    // Last state we reconciled to the card, so we only act on real transitions.
    lastSyncedState: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_connection_external', ['connectionId', 'externalId'])
    .index('by_card', ['cardId']),
});
