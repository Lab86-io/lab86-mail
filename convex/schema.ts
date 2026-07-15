import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const albatrossSourceRef = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  accountId: v.optional(v.string()),
  url: v.optional(v.string()),
});

const albatrossConfirmationRef = v.object({
  kind: v.string(),
  id: v.string(),
  confirmedAt: v.number(),
  confirmedBy: v.optional(v.string()),
  prompt: v.optional(v.string()),
  sourceRefId: v.optional(v.string()),
});

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

  // Development-only Albatross fixture records. This intentionally stores the
  // current 0.9 test corpus as typed-by-kind documents so issue #70 can be
  // exercised without locking in issue #71's final area/intent schema.
  albatrossDevRecords: defineTable({
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
    ref: v.optional(v.string()),
    source: v.string(),
    doc: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_kind', ['userId', 'kind'])
    .index('by_user_kind_key', ['userId', 'kind', 'key'])
    .index('by_user_source', ['userId', 'source']),

  areas: defineTable({
    userId: v.string(),
    externalId: v.optional(v.string()),
    name: v.string(),
    kind: v.string(),
    status: v.union(v.literal('active'), v.literal('archived')),
    description: v.optional(v.string()),
    priority: v.optional(v.number()),
    primaryDomain: v.optional(v.string()),
    faviconUrl: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id('_storage')),
    // Every area gets its own task board at creation; archiving the area never
    // deletes the board, and unarchiving reuses it (no duplicates).
    boardId: v.optional(v.id('boards')),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_kind', ['userId', 'kind'])
    .index('by_user_external', ['userId', 'externalId']),

  areaFacts: defineTable({
    userId: v.string(),
    areaId: v.id('areas'),
    externalId: v.optional(v.string()),
    kind: v.string(),
    value: v.string(),
    status: v.union(
      v.literal('candidate'),
      v.literal('verified'),
      v.literal('rejected'),
      v.literal('superseded'),
    ),
    sourceRefs: v.array(albatrossSourceRef),
    confirmationRefs: v.array(albatrossConfirmationRef),
    supersedesFactId: v.optional(v.id('areaFacts')),
    supersededByFactId: v.optional(v.id('areaFacts')),
    rejectedReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    verifiedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    supersededAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_area', ['areaId'])
    .index('by_area_status', ['areaId', 'status'])
    .index('by_user_area_status', ['userId', 'areaId', 'status'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_kind', ['userId', 'kind'])
    .index('by_user_external', ['userId', 'externalId']),

  areaArtifactLinks: defineTable({
    userId: v.string(),
    areaId: v.id('areas'),
    externalId: v.optional(v.string()),
    artifactKind: v.union(
      v.literal('mailThread'),
      v.literal('calendarEvent'),
      v.literal('task'),
      v.literal('mcpItem'),
      v.literal('intent'),
      v.literal('manual'),
    ),
    artifactId: v.string(),
    accountId: v.optional(v.string()),
    role: v.union(v.literal('primary'), v.literal('secondary'), v.literal('supporting')),
    status: v.union(v.literal('candidate'), v.literal('verified'), v.literal('rejected')),
    confidence: v.optional(v.number()),
    reason: v.optional(v.string()),
    sourceRefs: v.array(albatrossSourceRef),
    confirmationRefs: v.array(albatrossConfirmationRef),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_area', ['areaId'])
    .index('by_user_area', ['userId', 'areaId'])
    .index('by_user_area_status', ['userId', 'areaId', 'status'])
    .index('by_user_area_kind_status_updatedAt', ['userId', 'areaId', 'artifactKind', 'status', 'updatedAt'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_artifact', ['userId', 'artifactKind', 'artifactId'])
    .index('by_user_account_artifact', ['userId', 'accountId', 'artifactKind', 'artifactId'])
    .index('by_user_external', ['userId', 'externalId']),

  areaReindexRuns: defineTable({
    userId: v.string(),
    areaId: v.optional(v.string()),
    status: v.union(v.literal('queued'), v.literal('running'), v.literal('done'), v.literal('error')),
    reason: v.optional(v.string()),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    inserted: v.number(),
    matched: v.number(),
    personal: v.number(),
    skipped: v.number(),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_area_updatedAt', ['userId', 'areaId', 'updatedAt']),

  albatrossProjects: defineTable({
    userId: v.string(),
    externalId: v.optional(v.string()),
    title: v.string(),
    outcome: v.optional(v.string()),
    areaId: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('paused'), v.literal('done'), v.literal('archived')),
    sourceIntentId: v.optional(v.string()),
    sourceBatchId: v.optional(v.string()),
    activeSprintId: v.optional(v.id('albatrossSprints')),
    sourceRefs: v.optional(v.array(albatrossSourceRef)),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_area', ['userId', 'areaId'])
    .index('by_user_external', ['userId', 'externalId'])
    .index('by_user_source_intent', ['userId', 'sourceIntentId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt']),

  // The untouched brain dump that precedes one or more Work items. A capture
  // is preserved even when the splitter produces several albatrossIntents so
  // the user can always recover exactly what they originally unloaded.
  albatrossCaptures: defineTable({
    userId: v.string(),
    rawText: v.string(),
    transcript: v.optional(v.string()),
    source: v.union(v.literal('text'), v.literal('voice'), v.literal('chat'), v.literal('import')),
    status: v.union(v.literal('processing'), v.literal('split'), v.literal('error')),
    workIds: v.array(v.id('albatrossIntents')),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_created', ['userId', 'createdAt'])
    .index('by_user_status', ['userId', 'status']),

  // One durable, material question for a Work item. Questions are separate
  // from plan versions so the same active ask can render in Daily Brief, Area,
  // Work detail, notification center, and optional browser PiP.
  albatrossWorkQuestions: defineTable({
    userId: v.string(),
    // Work remains optional for project/routine questions. This table predates
    // generic questions, but is intentionally evolved in place so one ask can
    // render in chat, a living brief, Work, and notifications without copies.
    workId: v.optional(v.id('albatrossIntents')),
    projectId: v.optional(v.id('albatrossProjects')),
    routineId: v.optional(v.id('albatrossRoutines')),
    dedupeKey: v.optional(v.string()),
    legacyQuestionId: v.optional(v.string()),
    kind: v.union(
      v.literal('clarification'),
      v.literal('completion'),
      v.literal('correction'),
      v.literal('checkin'),
      v.literal('consent'),
      v.literal('reflection'),
    ),
    responseKind: v.optional(
      v.union(
        v.literal('text'),
        v.literal('single_select'),
        v.literal('multi_select'),
        v.literal('number'),
        v.literal('boolean'),
      ),
    ),
    prompt: v.string(),
    reason: v.optional(v.string()),
    options: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    ),
    status: v.union(
      v.literal('pending'),
      v.literal('answered'),
      v.literal('dismissed'),
      v.literal('superseded'),
    ),
    answer: v.optional(v.string()),
    answeredOptionId: v.optional(v.string()),
    sourceRefs: v.array(albatrossSourceRef),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    answeredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_work', ['workId'])
    .index('by_project', ['projectId'])
    .index('by_routine', ['routineId'])
    .index('by_user_dedupe', ['userId', 'dedupeKey'])
    .index('by_user_status_created', ['userId', 'status', 'createdAt'])
    .index('by_user_work_status', ['userId', 'workId', 'status']),

  // A Routine is an explicitly consented recurring behavior attached to a
  // durable Project/Epic. The scheduler materializes durable runs; a retry can
  // never duplicate a task, question, or notification because runKey is stable
  // in the user's local timezone.
  albatrossRoutines: defineTable({
    userId: v.string(),
    projectId: v.id('albatrossProjects'),
    areaId: v.optional(v.id('areas')),
    title: v.string(),
    purpose: v.optional(v.string()),
    kind: v.union(
      v.literal('task'),
      v.literal('checkin'),
      v.literal('task_and_checkin'),
      v.literal('review'),
    ),
    status: v.union(v.literal('proposed'), v.literal('active'), v.literal('paused'), v.literal('archived')),
    consent: v.union(v.literal('proposed'), v.literal('enabled'), v.literal('declined')),
    cadence: v.union(v.literal('daily'), v.literal('weekly'), v.literal('weekdays'), v.literal('custom')),
    daysOfWeek: v.optional(v.array(v.number())),
    localTime: v.string(),
    timezone: v.string(),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    taskTemplate: v.optional(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        priority: v.optional(v.union(v.literal('low'), v.literal('medium'), v.literal('high'))),
      }),
    ),
    questionTemplate: v.optional(
      v.object({
        prompt: v.string(),
        reason: v.optional(v.string()),
        responseKind: v.optional(
          v.union(
            v.literal('text'),
            v.literal('single_select'),
            v.literal('multi_select'),
            v.literal('number'),
            v.literal('boolean'),
          ),
        ),
        options: v.optional(
          v.array(v.object({ id: v.string(), label: v.string(), description: v.optional(v.string()) })),
        ),
      }),
    ),
    notification: v.object({
      enabled: v.boolean(),
      channel: v.union(
        v.literal('in_app'),
        v.literal('web_push'),
        v.literal('email'),
        v.literal('preferred'),
      ),
    }),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_project', ['projectId'])
    .index('by_area', ['areaId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_status_nextRunAt', ['status', 'nextRunAt'])
    .index('by_user_project_status', ['userId', 'projectId', 'status']),

  albatrossRoutineRuns: defineTable({
    userId: v.string(),
    routineId: v.id('albatrossRoutines'),
    projectId: v.id('albatrossProjects'),
    areaId: v.optional(v.id('areas')),
    runKey: v.string(),
    localDate: v.string(),
    scheduledFor: v.number(),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('skipped'),
      v.literal('error'),
    ),
    taskCardId: v.optional(v.id('cards')),
    questionId: v.optional(v.id('albatrossWorkQuestions')),
    notificationId: v.optional(v.id('albatrossNotifications')),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_routine', ['routineId'])
    .index('by_project', ['projectId'])
    .index('by_routine_runKey', ['routineId', 'runKey'])
    .index('by_user_status_scheduled', ['userId', 'status', 'scheduledFor']),

  // Source-normalized evidence is the substrate for the personal index. The
  // target is optional: unassigned evidence remains searchable until the user
  // or classifier links it to an Area, Project, Work item, or Routine.
  albatrossEvidence: defineTable({
    userId: v.string(),
    targetKind: v.optional(
      v.union(v.literal('area'), v.literal('project'), v.literal('work'), v.literal('routine')),
    ),
    targetId: v.optional(v.string()),
    sourceKind: v.union(
      v.literal('mail_thread'),
      v.literal('calendar_event'),
      v.literal('task'),
      v.literal('chat'),
      v.literal('question_answer'),
      v.literal('area_fact'),
      v.literal('github_issue'),
      v.literal('github_pull_request'),
      v.literal('github_project'),
      v.literal('github_project_item'),
      v.literal('github_commit'),
      v.literal('mcp_item'),
      v.literal('manual'),
    ),
    sourceId: v.string(),
    connectionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    occurredAt: v.number(),
    weight: v.number(),
    confidence: v.number(),
    trust: v.union(
      v.literal('observed'),
      v.literal('inferred'),
      v.literal('confirmed'),
      v.literal('rejected'),
    ),
    dedupeKey: v.string(),
    searchText: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_occurredAt', ['userId', 'occurredAt'])
    .index('by_user_target', ['userId', 'targetKind', 'targetId'])
    .index('by_user_source', ['userId', 'sourceKind', 'sourceId'])
    .index('by_user_dedupe', ['userId', 'dedupeKey'])
    .index('by_user_connection', ['userId', 'connectionId'])
    .searchIndex('by_search_text', {
      searchField: 'searchText',
      filterFields: ['userId', 'sourceKind', 'targetKind', 'targetId'],
    }),

  // Cached AI-composed Area document. The full selected-Area canvas is rendered
  // from artifactHtml in an opaque sandbox; the smaller prose fields remain as
  // an honest deterministic fallback while the first artifact is composing or
  // when generation is unavailable. Regeneration preserves the last good HTML.
  albatrossAreaBriefs: defineTable({
    userId: v.string(),
    areaId: v.id('areas'),
    status: v.union(v.literal('generating'), v.literal('ready'), v.literal('error')),
    lede: v.string(),
    summary: v.string(),
    artifactHtml: v.optional(v.string()),
    sourceRefs: v.array(albatrossSourceRef),
    basedOnRevision: v.string(),
    generatedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_area', ['areaId'])
    .index('by_user_area', ['userId', 'areaId'])
    .index('by_user_status', ['userId', 'status']),

  albatrossProjectLinks: defineTable({
    userId: v.string(),
    projectId: v.id('albatrossProjects'),
    artifactKind: v.union(
      v.literal('task'),
      v.literal('calendarEvent'),
      v.literal('mailThread'),
      v.literal('mcpItem'),
      v.literal('intent'),
      v.literal('emailDraft'),
      v.literal('areaFact'),
      v.literal('sprint'),
      v.literal('operationBatch'),
    ),
    artifactId: v.string(),
    accountId: v.optional(v.string()),
    areaId: v.optional(v.string()),
    role: v.union(v.literal('primary'), v.literal('supporting'), v.literal('evidence')),
    sourceIntentId: v.optional(v.string()),
    operationBatchId: v.optional(v.string()),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_project', ['projectId'])
    .index('by_user_project', ['userId', 'projectId'])
    .index('by_user_artifact', ['userId', 'artifactKind', 'artifactId'])
    .index('by_user_intent', ['userId', 'sourceIntentId'])
    .index('by_user_batch', ['userId', 'operationBatchId']),

  albatrossSprints: defineTable({
    userId: v.string(),
    projectId: v.optional(v.id('albatrossProjects')),
    externalId: v.optional(v.string()),
    title: v.string(),
    goal: v.optional(v.string()),
    cadence: v.union(v.literal('weekly'), v.literal('monthly'), v.literal('custom')),
    status: v.union(v.literal('planned'), v.literal('active'), v.literal('closed'), v.literal('archived')),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_project', ['userId', 'projectId'])
    .index('by_user_external', ['userId', 'externalId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt']),

  albatrossApprovals: defineTable({
    userId: v.string(),
    kind: v.union(
      v.literal('email_send'),
      v.literal('calendar_invite'),
      v.literal('calendar_rsvp'),
      v.literal('provider_write'),
      v.literal('external_action'),
    ),
    status: v.union(
      v.literal('pending'),
      v.literal('claiming'),
      v.literal('approved'),
      v.literal('rejected'),
      v.literal('undone'),
      v.literal('expired'),
    ),
    title: v.string(),
    detail: v.optional(v.string()),
    areaId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    projectId: v.optional(v.id('albatrossProjects')),
    sprintId: v.optional(v.id('albatrossSprints')),
    operationBatchId: v.optional(v.string()),
    artifactKind: v.optional(v.string()),
    artifactId: v.optional(v.string()),
    toolName: v.string(),
    toolArgs: v.any(),
    result: v.optional(v.any()),
    risk: v.optional(v.string()),
    undoExpiresAt: v.optional(v.number()),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_status_created', ['userId', 'status', 'createdAt'])
    .index('by_user_intent', ['userId', 'intentId'])
    .index('by_user_project', ['userId', 'projectId'])
    .index('by_user_batch', ['userId', 'operationBatchId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt']),

  albatrossPlanApplications: defineTable({
    userId: v.string(),
    intentId: v.string(),
    intentText: v.optional(v.string()),
    planId: v.optional(v.string()),
    areaId: v.optional(v.string()),
    projectId: v.optional(v.id('albatrossProjects')),
    operationBatchId: v.string(),
    status: v.union(
      v.literal('applied'),
      v.literal('partially_applied'),
      v.literal('queued'),
      v.literal('undone'),
    ),
    artifacts: v.array(v.any()),
    operationIds: v.array(v.string()),
    pendingApprovalIds: v.array(v.string()),
    unresolvedArtifacts: v.array(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_intent', ['userId', 'intentId'])
    .index('by_user_project', ['userId', 'projectId'])
    .index('by_user_batch', ['userId', 'operationBatchId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt']),

  // Completion history (issue #87/#18). Current card/intent/project state
  // answers "what is open"; this table answers "what actually got done and
  // when", so progress reports can compare completion behavior over time
  // ("three months ago you completed 50%, on average 1.5 days early...").
  // Rows are append-only: reopening an artifact does not erase its history.
  completionEvents: defineTable({
    userId: v.string(),
    areaId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    projectId: v.optional(v.id('albatrossProjects')),
    artifactKind: v.union(
      v.literal('task'),
      v.literal('intent'),
      v.literal('intent_plan'),
      v.literal('project'),
    ),
    artifactId: v.string(),
    completedAt: v.number(),
    dueAt: v.optional(v.number()),
    // Exactly one of these is set when dueAt exists (completionDelta in
    // albatrossWork.ts); both stay unset for artifacts without a due date.
    completedEarlyByMs: v.optional(v.number()),
    completedLateByMs: v.optional(v.number()),
    sourceRefs: v.optional(v.array(albatrossSourceRef)),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_completedAt', ['userId', 'completedAt'])
    .index('by_user_project', ['userId', 'projectId'])
    .index('by_user_artifact', ['userId', 'artifactKind', 'artifactId']),

  // A raw user-declared intent (issue #76/#77 made durable). The raw dump is
  // preserved verbatim; parse/plan output layers on top without replacing it.
  albatrossIntents: defineTable({
    userId: v.string(),
    externalId: v.optional(v.string()),
    rawText: v.string(),
    transcript: v.optional(v.string()),
    source: v.union(v.literal('text'), v.literal('voice'), v.literal('chat'), v.literal('import')),
    title: v.optional(v.string()),
    status: v.union(
      v.literal('captured'),
      v.literal('planning'),
      v.literal('needs_answers'),
      v.literal('ready'),
      v.literal('applied'),
      v.literal('done'),
      v.literal('archived'),
    ),
    kind: v.optional(v.string()),
    areaId: v.optional(v.string()),
    // Work-v2 additions. Legacy areaId/status remain readable during the
    // additive migration; these fields become the user-facing Work contract.
    captureId: v.optional(v.id('albatrossCaptures')),
    conversationId: v.optional(v.string()),
    primaryAreaId: v.optional(v.id('areas')),
    primaryProjectId: v.optional(v.id('albatrossProjects')),
    workState: v.optional(
      v.union(
        v.literal('active'),
        v.literal('waiting'),
        v.literal('blocked'),
        v.literal('done'),
        v.literal('archived'),
      ),
    ),
    agentState: v.optional(
      v.union(
        v.literal('idle'),
        v.literal('researching'),
        v.literal('needs_input'),
        v.literal('applying'),
        v.literal('error'),
      ),
    ),
    lastAgentRunAt: v.optional(v.number()),
    lastEvidenceAt: v.optional(v.number()),
    priority: v.optional(v.number()),
    questions: v.optional(
      v.array(
        v.object({
          id: v.string(),
          prompt: v.string(),
          // Choosable answers (e.g. real nearby places found on the web).
          // Free-text answering stays available even when options exist.
          options: v.optional(
            v.array(
              v.object({
                id: v.string(),
                title: v.string(),
                detail: v.optional(v.string()),
                address: v.optional(v.string()),
                hoursText: v.optional(v.string()),
                website: v.optional(v.string()),
              }),
            ),
          ),
          answer: v.optional(v.string()),
          answeredOptionId: v.optional(v.string()),
          answeredAt: v.optional(v.number()),
        }),
      ),
    ),
    planError: v.optional(v.string()),
    // Auto-retry counter for the plan-reconcile cron: generations killed by a
    // deploy/restart leave the intent stuck in 'planning' with no planError.
    planAttempts: v.optional(v.number()),
    latestPlanId: v.optional(v.id('albatrossIntentPlans')),
    appliedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_external', ['userId', 'externalId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt'])
    .index('by_user_primary_area', ['userId', 'primaryAreaId'])
    .index('by_user_work_state', ['userId', 'workState'])
    .index('by_user_project', ['userId', 'primaryProjectId'])
    .index('by_capture', ['captureId']),

  // A generated plan for one intent. digitalActions match the work-model
  // contract so albatross_apply_intent_plan can execute the plan as stored.
  // artifactHtml is the self-contained HTML plan brief rendered in a sandbox.
  albatrossIntentPlans: defineTable({
    userId: v.string(),
    intentId: v.id('albatrossIntents'),
    status: v.union(
      v.literal('draft'),
      v.literal('needs_answers'),
      v.literal('ready'),
      v.literal('applied'),
      v.literal('superseded'),
    ),
    outcome: v.optional(v.string()),
    summary: v.optional(v.string()),
    // When the generator judges the intent multi-step, this becomes the
    // albatross project created at apply time (projectMode 'auto').
    proposedProjectTitle: v.optional(v.string()),
    digitalActions: v.array(v.any()),
    physicalActions: v.array(
      v.object({
        title: v.string(),
        detail: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
    assumptions: v.array(v.string()),
    sourceRefs: v.array(
      v.object({
        kind: v.string(),
        id: v.string(),
        label: v.optional(v.string()),
        accountId: v.optional(v.string()),
        url: v.optional(v.string()),
      }),
    ),
    artifactHtml: v.optional(v.string()),
    artifactTitle: v.optional(v.string()),
    model: v.optional(v.string()),
    // Model-declared place for the plan's map column ("Penn Yan DMV, NY").
    mapQuery: v.optional(v.string()),
    // Every plan hunts for the real-world places it touches (grounded only).
    places: v.optional(
      v.array(
        v.object({
          name: v.string(),
          detail: v.optional(v.string()),
          address: v.optional(v.string()),
          hoursText: v.optional(v.string()),
          phone: v.optional(v.string()),
          website: v.optional(v.string()),
          mapsQuery: v.optional(v.string()),
        }),
      ),
    ),
    appliedApplicationId: v.optional(v.string()),
    // stepKey -> created artifact mapping recorded at apply time; card-backed
    // steps carry the board cardId for the dossier's interactive task cards.
    // Calendar/draft steps record their created eventId/draftId for provenance.
    appliedSteps: v.optional(
      v.array(
        v.object({
          stepKey: v.string(),
          kind: v.string(),
          cardId: v.optional(v.string()),
          eventId: v.optional(v.string()),
          draftId: v.optional(v.string()),
        }),
      ),
    ),
    appliedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_intent', ['userId', 'intentId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt']),

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
    .index('by_board_updatedAt', ['boardId', 'updatedAt'])
    .index('by_column_order', ['columnId', 'order'])
    .index('by_user', ['userId'])
    .index('by_user_updatedAt', ['userId', 'updatedAt'])
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
    surface: v.union(v.literal('mail'), v.literal('calendar'), v.literal('tasks'), v.literal('albatross')),
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

  // Albatross notifications are delivery-independent. A failed web push or
  // email never hides the durable in-app record, and dedupe keys make cron
  // retries, deploys, and DST transitions safe.
  albatrossNotifications: defineTable({
    userId: v.string(),
    type: v.union(
      v.literal('daily_checkin'),
      v.literal('work_question'),
      v.literal('approval'),
      v.literal('completion_suggestion'),
      v.literal('brief_ready'),
      v.literal('agent_error'),
    ),
    title: v.string(),
    body: v.string(),
    entityKind: v.optional(
      v.union(
        v.literal('checkin'),
        v.literal('work'),
        v.literal('project'),
        v.literal('area'),
        v.literal('approval'),
      ),
    ),
    entityId: v.optional(v.string()),
    deepLink: v.string(),
    dedupeKey: v.string(),
    status: v.union(
      v.literal('queued'),
      v.literal('delivered'),
      v.literal('read'),
      v.literal('acted'),
      v.literal('dismissed'),
      v.literal('expired'),
    ),
    scheduledFor: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    readAt: v.optional(v.number()),
    actedAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status_created', ['userId', 'status', 'createdAt'])
    .index('by_user_dedupe', ['userId', 'dedupeKey'])
    .index('by_scheduled', ['scheduledFor']),

  albatrossNotificationPreferences: defineTable({
    userId: v.string(),
    timezone: v.string(),
    eveningCheckinEnabled: v.boolean(),
    eveningCheckinLocalTime: v.string(),
    inAppEnabled: v.boolean(),
    webPushEnabled: v.boolean(),
    emailFallbackEnabled: v.boolean(),
    emailFallbackDelayMinutes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  webPushSubscriptions: defineTable({
    userId: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('revoked'), v.literal('expired')),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastDeliveredAt: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_endpoint', ['endpoint']),

  notificationDeliveries: defineTable({
    userId: v.string(),
    notificationId: v.id('albatrossNotifications'),
    channel: v.union(v.literal('in_app'), v.literal('web_push'), v.literal('email')),
    status: v.union(v.literal('queued'), v.literal('sent'), v.literal('failed'), v.literal('suppressed')),
    attemptCount: v.number(),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
    scheduledFor: v.number(),
    sentAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_notification', ['notificationId'])
    .index('by_user', ['userId'])
    .index('by_status_scheduled', ['status', 'scheduledFor']),

  albatrossDailyCheckins: defineTable({
    userId: v.string(),
    localDate: v.string(),
    timezone: v.string(),
    status: v.union(v.literal('scheduled'), v.literal('open'), v.literal('answered'), v.literal('skipped')),
    candidateItems: v.array(
      v.object({
        kind: v.union(
          v.literal('work'),
          v.literal('project'),
          v.literal('task'),
          v.literal('event'),
          v.literal('artifact'),
        ),
        id: v.string(),
        title: v.string(),
        suggestedState: v.optional(v.string()),
        evidence: v.array(albatrossSourceRef),
      }),
    ),
    responseText: v.optional(v.string()),
    reconciledChanges: v.optional(
      v.array(
        v.object({
          kind: v.string(),
          id: v.string(),
          previousState: v.optional(v.string()),
          nextState: v.optional(v.string()),
        }),
      ),
    ),
    conversationId: v.string(),
    openedAt: v.optional(v.number()),
    answeredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_date', ['userId', 'localDate'])
    .index('by_user_status_date', ['userId', 'status', 'localDate']),

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
    server: v.union(
      v.literal('github'),
      v.literal('bitbucket'),
      v.literal('jira'),
      v.literal('slack'),
      v.literal('granola'),
    ),
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
    .index('by_status', ['status'])
    .index('by_server', ['server']),

  mcpCredentials: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    oauthClientInformationEncrypted: v.optional(v.string()),
    fingerprint: v.optional(v.string()),
    masked: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_connection', ['userId', 'connectionId']),

  mcpOAuthStates: defineTable({
    userId: v.string(),
    state: v.string(),
    server: v.string(),
    payloadEncrypted: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_state', ['state'])
    .index('by_expires', ['expiresAt']),

  mcpItems: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.union(
      v.literal('github'),
      v.literal('bitbucket'),
      v.literal('jira'),
      v.literal('slack'),
      v.literal('granola'),
    ),
    externalId: v.string(),
    kind: v.string(),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    state: v.optional(v.string()),
    author: v.optional(v.string()),
    repository: v.optional(v.string()),
    organization: v.optional(v.string()),
    parentExternalId: v.optional(v.string()),
    sha: v.optional(v.string()),
    assignedToUser: v.optional(v.boolean()),
    updatedAtSource: v.optional(v.number()),
    raw: v.optional(v.any()),
    searchText: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_external', ['userId', 'externalId'])
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_connection_external', ['connectionId', 'externalId'])
    .index('by_user_updated', ['userId', 'updatedAtSource'])
    .searchIndex('by_search_text', {
      searchField: 'searchText',
      filterFields: ['userId', 'server', 'connectionId', 'kind', 'state', 'repository', 'organization'],
    }),

  mcpSyncStates: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    status: v.union(v.literal('idle'), v.literal('syncing'), v.literal('ready'), v.literal('error')),
    lastSyncedAt: v.optional(v.number()),
    lastCursor: v.optional(v.string()),
    itemCount: v.optional(v.number()),
    accountEmail: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
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
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_connection_external', ['connectionId', 'externalId'])
    .index('by_card', ['cardId']),
});
