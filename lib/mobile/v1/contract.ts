import { z } from 'zod';

const identifier = z.string().trim().min(1).max(240);
const optionalIdentifier = identifier.optional();
const isoTimestamp = z.iso.datetime({ offset: true });

export const MobileDomainSchema = z.enum([
  'accounts',
  'mail',
  'calendar',
  'tasks',
  'today',
  'work',
  'assistant',
  'activity',
]);

export type MobileDomain = z.infer<typeof MobileDomainSchema>;

export const ProviderSchema = z.enum(['google', 'microsoft', 'icloud', 'imap']);

export const ProviderCapabilitySetSchema = z
  .object({
    mail: z.boolean(),
    calendar: z.boolean(),
    contacts: z.boolean(),
    folders: z.boolean(),
    labels: z.boolean(),
    drafts: z.boolean(),
    scheduledSend: z.boolean(),
    push: z.boolean(),
    search: z.boolean(),
    unsupportedReason: z.string().max(500).optional(),
  })
  .strict();

export type ProviderCapabilitySet = z.infer<typeof ProviderCapabilitySetSchema>;

export const MobileAccountSchema = z
  .object({
    id: identifier,
    email: z.email(),
    provider: ProviderSchema,
    status: z.enum(['connected', 'disconnected', 'error']),
    displayName: z.string().max(120).optional(),
    scopes: z.array(z.string().max(240)).max(100),
    capabilities: ProviderCapabilitySetSchema,
    sync: z
      .object({
        status: z.enum(['idle', 'backfilling', 'syncing', 'ready', 'error']),
        corpusReady: z.boolean(),
        itemsSynced: z.number().int().nonnegative().optional(),
        lastSyncedAt: z.number().int().nonnegative().optional(),
        error: z.string().max(500).optional(),
      })
      .strict(),
  })
  .strict();

export const MobileNotificationSettingsSchema = z
  .object({
    nativePushEnabled: z.boolean(),
    newMailPushEnabled: z.boolean(),
    eventSuggestionPushEnabled: z.boolean(),
    eveningCheckinEnabled: z.boolean(),
  })
  .strict();

export const MobileCursorsSchema = z
  .object({
    accounts: z.string(),
    mail: z.string(),
    calendar: z.string(),
    tasks: z.string(),
    today: z.string(),
    work: z.string(),
    assistant: z.string(),
    activity: z.string(),
  })
  .strict();

export const MobileBootstrapSchema = z
  .object({
    version: z.literal(1),
    user: z
      .object({
        id: identifier,
        email: z.string().max(320),
        name: z.string().max(240),
        imageURL: z.url().optional(),
      })
      .strict(),
    accounts: z.array(MobileAccountSchema),
    featureFlags: z.record(z.string(), z.boolean()),
    notificationSettings: MobileNotificationSettingsSchema,
    cursors: MobileCursorsSchema,
    serverTime: isoTimestamp,
  })
  .strict();

const syncChangeBase = {
  entityID: identifier,
  revision: z.number().int().nonnegative(),
  operation: z.literal('upsert'),
};

export const MailThreadSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('mail'),
    entityKind: z.literal('thread'),
    payload: z
      .object({
        accountID: identifier,
        archived: z.boolean().optional(),
        trashed: z.boolean().optional(),
        unread: z.boolean().optional(),
        // Epoch ms when a snoozed thread resurfaces. Clearing is a separate
        // literal flag (not null) so generated clients that fold JSON null
        // into absence keep the tri-state.
        snoozedUntil: z.number().int().nonnegative().optional(),
        snoozeCleared: z.literal(true).optional(),
        muted: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const MailMessageSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('mail'),
    entityKind: z.literal('message'),
    payload: z
      .object({
        accountID: identifier,
        unread: z.boolean().optional(),
        starred: z.boolean().optional(),
        labelsAdded: z.array(identifier).max(50).optional(),
        labelsRemoved: z.array(identifier).max(50).optional(),
      })
      .strict(),
  })
  .strict();

export const MailDraftSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('mail'),
    entityKind: z.literal('draft'),
    payload: z
      .object({
        accountID: identifier,
        draftID: identifier,
        deleted: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();

export const CalendarEventSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('calendar'),
    entityKind: z.literal('event'),
    payload: z.object({ accountID: identifier, eventID: identifier }).strict(),
  })
  .strict();

export const TaskSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('tasks'),
    entityKind: z.literal('task'),
    payload: z
      .object({
        cardID: identifier,
        title: z.string().trim().min(1).max(500).optional(),
        completed: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const WorkSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('work'),
    entityKind: z.literal('work'),
    payload: z
      .object({
        captureID: identifier,
        workIDs: z.array(identifier).max(500),
        fallback: z.boolean(),
      })
      .strict(),
  })
  .strict();

// The horizon of one Work: now, later, or someday. Epoch ms, like every
// other server-owned timestamp in a sync payload.
export const WorkHorizonSchema = z
  .object({
    kind: z.enum(['now', 'later', 'someday']),
    notBefore: z.number().int().nonnegative().optional(),
    by: z.number().int().nonnegative().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    wokeAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type WorkHorizon = z.infer<typeof WorkHorizonSchema>;

export const WorkHorizonSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('work'),
    entityKind: z.literal('workHorizon'),
    payload: z
      .object({
        workID: identifier,
        horizon: WorkHorizonSchema.optional(),
        // Explicit clear (mirrors `snoozeCleared`): the Work is back on "now".
        horizonCleared: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();

// Work held from the chat bar or from one chat reply. `existing` is true
// when the reply was already held and the server returned the first result.
export const WorkCapturedSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('work'),
    entityKind: z.literal('workCaptured'),
    payload: z
      .object({
        workIDs: z.array(identifier).max(500),
        existing: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

// Shape-owned data on one Work. Mirrors the validators in `convex/schema.ts`.
// Epoch ms, like every other server-owned timestamp in a sync payload.
export const WorkShapeSchema = z.enum([
  'quick',
  'list',
  'project',
  'practice',
  'decision',
  'monitor',
  'recurring',
]);
export type WorkShape = z.infer<typeof WorkShapeSchema>;

export const WorkListItemSchema = z
  .object({
    id: identifier,
    text: z.string().min(1).max(500),
    done: z.boolean(),
    addedAt: z.number().int().nonnegative(),
    doneAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const WorkMetricSchema = z
  .object({
    name: z.string().min(1).max(80),
    unit: z.string().max(24),
    target: z.number().optional(),
    direction: z.enum(['down', 'up']).optional(),
  })
  .strict();

export const WorkMetricEntrySchema = z
  .object({
    id: identifier,
    at: z.number().int().nonnegative(),
    value: z.number(),
    // Optional, not nullable: the Swift generator drops anyOf[x, null] fields.
    note: z.string().max(500).optional(),
  })
  .strict();

export const WorkMetricSummarySchema = z
  .object({
    // Optional, not nullable: the Swift generator drops anyOf[x, null] fields.
    latest: z.number().optional(),
    latestAt: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative(),
    weeksWithEntry: z.number().int().nonnegative(),
  })
  .strict();

export const WorkMilestoneSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(200),
    done: z.boolean(),
    doneAt: z.number().int().nonnegative().optional(),
    order: z.number().int().nonnegative(),
  })
  .strict();

// A shape-owned field of one Work changed. The payload carries only the
// fields the command touched: the shape word, the whole item list, the
// whole milestone rail, or the metric with its newest entry and summary.
export const WorkShapeSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('work'),
    entityKind: z.literal('workShape'),
    payload: z
      .object({
        workID: identifier,
        shape: WorkShapeSchema.optional(),
        listItems: z.array(WorkListItemSchema).max(500).optional(),
        milestones: z.array(WorkMilestoneSchema).max(60).optional(),
        metric: WorkMetricSchema.optional(),
        metricEntry: WorkMetricEntrySchema.optional(),
        metricSummary: WorkMetricSummarySchema.optional(),
      })
      .strict(),
  })
  .strict();

export const ApprovalSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: z.literal('activity'),
    entityKind: z.literal('approval'),
    payload: z.union([
      z.object({ approvalID: identifier, commandKind: identifier }).strict(),
      z.object({ approvalID: identifier, status: z.enum(['approved', 'rejected']) }).strict(),
    ]),
  })
  .strict();

export const OperationSyncChangeSchema = z
  .object({
    ...syncChangeBase,
    domain: MobileDomainSchema,
    entityKind: z.literal('operation'),
    payload: z.object({ operationID: identifier, undone: z.literal(true) }).strict(),
  })
  .strict();

export const MobileSyncChangeVariantSchemas = {
  MailThreadSyncChange: MailThreadSyncChangeSchema,
  MailMessageSyncChange: MailMessageSyncChangeSchema,
  MailDraftSyncChange: MailDraftSyncChangeSchema,
  CalendarEventSyncChange: CalendarEventSyncChangeSchema,
  TaskSyncChange: TaskSyncChangeSchema,
  WorkSyncChange: WorkSyncChangeSchema,
  WorkHorizonSyncChange: WorkHorizonSyncChangeSchema,
  WorkCapturedSyncChange: WorkCapturedSyncChangeSchema,
  WorkShapeSyncChange: WorkShapeSyncChangeSchema,
  ApprovalSyncChange: ApprovalSyncChangeSchema,
  OperationSyncChange: OperationSyncChangeSchema,
} as const;

export const SyncChangeSchema = z.discriminatedUnion('entityKind', [
  MobileSyncChangeVariantSchemas.MailThreadSyncChange,
  MobileSyncChangeVariantSchemas.MailMessageSyncChange,
  MobileSyncChangeVariantSchemas.MailDraftSyncChange,
  MobileSyncChangeVariantSchemas.CalendarEventSyncChange,
  MobileSyncChangeVariantSchemas.TaskSyncChange,
  MobileSyncChangeVariantSchemas.WorkSyncChange,
  MobileSyncChangeVariantSchemas.WorkHorizonSyncChange,
  MobileSyncChangeVariantSchemas.WorkCapturedSyncChange,
  MobileSyncChangeVariantSchemas.WorkShapeSyncChange,
  MobileSyncChangeVariantSchemas.ApprovalSyncChange,
  MobileSyncChangeVariantSchemas.OperationSyncChange,
]);

export type MobileSyncChange = z.infer<typeof SyncChangeSchema>;

type MobileSyncExecutionFor<Change> = Change extends {
  domain: infer Domain;
  entityKind: infer EntityKind;
  entityID: string;
  payload: infer Payload;
}
  ? {
      syncDomain: Domain;
      entityKind: EntityKind;
      entityID: string;
      syncPayload: Payload;
    }
  : never;

export type MobileSyncExecution = MobileSyncExecutionFor<MobileSyncChange>;

export const SyncEnvelopeSchema = z
  .object({
    items: z.array(SyncChangeSchema),
    deletedIDs: z.array(identifier),
    cursor: z.string(),
    serverRevision: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

// Typed paged mail reads. Summaries come from the synced Convex corpus
// (lastDate-cursor pages); detail reads reuse the corpus-first get_thread
// path, so a fully-hydrated thread is a pure local read server-side.
export const MailAttachmentSchema = z
  .object({
    id: identifier,
    name: z.string().max(500),
    contentType: z.string().max(200),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

export const MailThreadSummarySchema = z
  .object({
    id: identifier,
    accountID: identifier,
    subject: z.string().max(2_000),
    fromHeader: z.string().max(1_000),
    senderEmail: z.string().max(320).optional(),
    snippet: z.string().max(500),
    lastMessageAt: z.number().int().nonnegative(),
    unread: z.boolean(),
    starred: z.boolean(),
    labels: z.array(z.string().max(240)).max(200),
    messageCount: z.number().int().nonnegative(),
    smartCategory: z.string().max(240).optional(),
    // Secondary built-in categories (for example `orders` on a Main thread)
    // and the custom label ids the thread carries. Clients use them to show
    // a thread in the same category views as the web.
    smartSecondary: z.array(z.string().max(80)).max(16).optional(),
    smartLabels: z.array(z.string().max(240)).max(50).optional(),
  })
  .strict();

export const MailThreadPageSchema = z
  .object({
    items: z.array(MailThreadSummarySchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
    serverTime: isoTimestamp,
  })
  .strict();

export const MailMessageSchema = z
  .object({
    id: identifier,
    threadID: identifier,
    accountID: identifier,
    subject: z.string().max(2_000),
    fromHeader: z.string().max(1_000),
    fromEmail: z.string().max(320).optional(),
    to: z.string().max(20_000),
    cc: z.string().max(20_000),
    bcc: z.string().max(20_000),
    sentAt: z.number().int().nonnegative(),
    snippet: z.string().max(500),
    bodyText: z.string().max(500_000),
    bodyHTML: z.string().max(1_000_000).optional(),
    labels: z.array(z.string().max(240)).max(200),
    unread: z.boolean(),
    starred: z.boolean(),
    attachments: z.array(MailAttachmentSchema).max(100),
  })
  .strict();

export const MailThreadDetailSchema = z
  .object({
    threadID: identifier,
    accountID: identifier,
    subject: z.string().max(2_000),
    messages: z.array(MailMessageSchema),
    summary: z.string().max(20_000).optional(),
  })
  .strict();

const mobileCommandBase = {
  idempotencyKey: identifier,
  baseRevision: z.number().int().nonnegative().optional(),
  clientCreatedAt: isoTimestamp,
};

const mailThreadPayload = z
  .object({
    accountID: identifier,
    threadID: identifier,
  })
  .strict();

// Mark unread, star, and unstar change one message. A list row knows only
// its thread, so `messageID` is optional: without it the server changes the
// newest message of the thread.
const mailThreadMessagePayload = z
  .object({
    accountID: identifier,
    threadID: identifier,
    messageID: optionalIdentifier,
  })
  .strict();

const attendeeSchema = z
  .object({
    email: z.email(),
    name: z.string().max(160).optional(),
  })
  .strict();

const calendarCreatePayload = z
  .object({
    accountID: identifier,
    calendarID: optionalIdentifier,
    title: z.string().trim().min(1).max(500),
    startAt: isoTimestamp,
    endAt: isoTimestamp,
    allDay: z.boolean(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(1_000).optional(),
    attendees: z.array(attendeeSchema).max(200),
    recurrence: z.array(z.string().max(1_000)).max(50).optional(),
    busy: z.boolean(),
  })
  .strict();

// Snooze acts on the whole thread. `messageID` is optional: the Snoozed list
// does not always know the message a snooze started from.
const mailSnoozePayload = z
  .object({
    accountID: identifier,
    threadID: identifier,
    messageID: optionalIdentifier,
    untilAt: isoTimestamp,
  })
  .strict();

const mailUnsnoozePayload = z
  .object({
    accountID: identifier,
    threadID: identifier,
    messageID: optionalIdentifier,
  })
  .strict();

export const MailArchiveCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.archive'), payload: mailThreadPayload })
  .strict();
export const MailTrashCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.trash'), payload: mailThreadPayload })
  .strict();
export const MailMarkReadCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.markRead'), payload: mailThreadPayload })
  .strict();
export const MailMarkUnreadCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.markUnread'), payload: mailThreadMessagePayload })
  .strict();
export const MailStarCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.star'), payload: mailThreadMessagePayload })
  .strict();
export const MailUnstarCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.unstar'), payload: mailThreadMessagePayload })
  .strict();
export const MailSnoozeCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.snooze'), payload: mailSnoozePayload })
  .strict();
export const MailUnsnoozeCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.unsnooze'), payload: mailUnsnoozePayload })
  .strict();
export const MailRestoreCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.restore'), payload: mailThreadPayload })
  .strict();
export const CalendarCreateCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('calendar.create'), payload: calendarCreatePayload })
  .strict();
export const TaskSetCompletedCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('task.setCompleted'),
    payload: z.object({ cardID: identifier, completed: z.boolean() }).strict(),
  })
  .strict();
// Set or clear the horizon of one Work. Dates are ISO timestamps, like every
// other client-written time in a command. Exactly one of `horizon` and
// `horizonCleared` is present.
export const WorkSetHorizonCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.setHorizon'),
    payload: z
      .object({
        workID: identifier,
        horizon: z
          .object({
            kind: z.enum(['now', 'later', 'someday']),
            notBeforeAt: isoTimestamp.optional(),
            byAt: isoTimestamp.optional(),
            label: z.string().trim().min(1).max(120).optional(),
          })
          .strict()
          .optional(),
        horizonCleared: z.literal(true).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (Boolean(value.horizon) === Boolean(value.horizonCleared)) {
          ctx.addIssue({ code: 'custom', message: 'Provide horizon or horizonCleared, not both.' });
        }
      }),
  })
  .strict();
// Shape commands. Each one is a user touch on the Work. The receipt carries a
// `workShape` sync change with the fields the command changed.
export const WorkListAddCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.listAdd'),
    payload: z.object({ workID: identifier, text: z.string().trim().min(1).max(500) }).strict(),
  })
  .strict();
export const WorkListToggleCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.listToggle'),
    payload: z.object({ workID: identifier, itemID: identifier }).strict(),
  })
  .strict();
export const WorkListRemoveCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.listRemove'),
    payload: z.object({ workID: identifier, itemID: identifier }).strict(),
  })
  .strict();
// `at` is an ISO timestamp, like every other client-written time in a
// command. Absent means now.
export const WorkMetricLogCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.metricLog'),
    payload: z
      .object({
        workID: identifier,
        value: z.number().finite(),
        at: isoTimestamp.optional(),
        note: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict();
export const WorkMilestoneToggleCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.milestoneToggle'),
    payload: z.object({ workID: identifier, milestoneID: identifier }).strict(),
  })
  .strict();
export const WorkSetShapeCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.setShape'),
    payload: z.object({ workID: identifier, shape: WorkShapeSchema }).strict(),
  })
  .strict();
export const MobileCommandVariantSchemas = {
  MailArchiveCommand: MailArchiveCommandSchema,
  MailTrashCommand: MailTrashCommandSchema,
  MailMarkReadCommand: MailMarkReadCommandSchema,
  MailMarkUnreadCommand: MailMarkUnreadCommandSchema,
  MailStarCommand: MailStarCommandSchema,
  MailUnstarCommand: MailUnstarCommandSchema,
  MailSnoozeCommand: MailSnoozeCommandSchema,
  MailUnsnoozeCommand: MailUnsnoozeCommandSchema,
  MailRestoreCommand: MailRestoreCommandSchema,
  CalendarCreateCommand: CalendarCreateCommandSchema,
  TaskSetCompletedCommand: TaskSetCompletedCommandSchema,
  WorkSetHorizonCommand: WorkSetHorizonCommandSchema,
  WorkListAddCommand: WorkListAddCommandSchema,
  WorkListToggleCommand: WorkListToggleCommandSchema,
  WorkListRemoveCommand: WorkListRemoveCommandSchema,
  WorkMetricLogCommand: WorkMetricLogCommandSchema,
  WorkMilestoneToggleCommand: WorkMilestoneToggleCommandSchema,
  WorkSetShapeCommand: WorkSetShapeCommandSchema,
} as const;

const commandSchemas = Object.values(MobileCommandVariantSchemas) as [
  typeof MailArchiveCommandSchema,
  typeof MailTrashCommandSchema,
  typeof MailMarkReadCommandSchema,
  typeof MailMarkUnreadCommandSchema,
  typeof MailStarCommandSchema,
  typeof MailUnstarCommandSchema,
  typeof MailSnoozeCommandSchema,
  typeof MailUnsnoozeCommandSchema,
  typeof MailRestoreCommandSchema,
  typeof CalendarCreateCommandSchema,
  typeof TaskSetCompletedCommandSchema,
  typeof WorkSetHorizonCommandSchema,
  typeof WorkListAddCommandSchema,
  typeof WorkListToggleCommandSchema,
  typeof WorkListRemoveCommandSchema,
  typeof WorkMetricLogCommandSchema,
  typeof WorkMilestoneToggleCommandSchema,
  typeof WorkSetShapeCommandSchema,
];

export const MobileCommandSchema = z.discriminatedUnion('kind', commandSchemas);
export type MobileCommand = z.infer<typeof MobileCommandSchema>;
export type MobileCommandKind = MobileCommand['kind'];

export const RecoverableMobileErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();

export const CommandReceiptSchema = z
  .object({
    commandID: identifier,
    status: z.enum(['queued', 'applied', 'needsApproval', 'conflicted', 'failed']),
    entityRevision: z.number().int().nonnegative().optional(),
    operationID: optionalIdentifier,
    approvalID: optionalIdentifier,
    undoExpiresAt: isoTimestamp.optional(),
    recoverableError: RecoverableMobileErrorSchema.optional(),
  })
  .strict();

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const MobileErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    requestID: identifier,
    error: RecoverableMobileErrorSchema,
  })
  .strict();

// The Ask / Hold bar. A receipt carries no data, so the route is a query:
// `POST /api/mobile/v1/assistant/route` with `{ text }`. A model failure or
// timeout returns `ask` with confidence 0.
export const AssistantRouteRequestSchema = z.object({ text: z.string().trim().min(1).max(2_000) }).strict();

export const AssistantRouteVerdictSchema = z
  .object({
    route: z.enum(['ask', 'hold']),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type AssistantRouteVerdict = z.infer<typeof AssistantRouteVerdictSchema>;

export const AssistantEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('messageDelta'), text: z.string() }).strict(),
  z.object({ type: z.literal('toolStarted'), toolCallID: identifier, toolName: identifier }).strict(),
  z
    .object({
      type: z.literal('toolResult'),
      toolCallID: identifier,
      result: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal('approvalRequested'), approvalID: identifier }).strict(),
  z.object({ type: z.literal('questionRequested'), questionID: identifier }).strict(),
  z
    .object({
      type: z.literal('displayArtifact'),
      artifactKind: identifier,
      artifact: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ type: z.literal('completed'), conversationID: identifier }).strict(),
  z.object({ type: z.literal('failed'), error: RecoverableMobileErrorSchema }).strict(),
]);

export const PushEnvelopeSchema = z
  .object({
    version: z.literal(1),
    notificationID: identifier,
    category: identifier,
    route: z.string().min(1).max(2_000),
    entityReference: z.object({ domain: MobileDomainSchema, kind: identifier, id: identifier }).strict(),
    allowedActions: z.array(identifier).max(20),
    dedupeKey: identifier,
  })
  .strict();

export const MobileContractV1 = {
  version: 1 as const,
  schemas: {
    AssistantEvent: AssistantEventSchema,
    AssistantRouteRequest: AssistantRouteRequestSchema,
    AssistantRouteVerdict: AssistantRouteVerdictSchema,
    CommandReceipt: CommandReceiptSchema,
    MailAttachment: MailAttachmentSchema,
    MailMessage: MailMessageSchema,
    MailThreadDetail: MailThreadDetailSchema,
    MailThreadPage: MailThreadPageSchema,
    MailThreadSummary: MailThreadSummarySchema,
    MobileBootstrap: MobileBootstrapSchema,
    MobileCommand: MobileCommandSchema,
    MobileErrorEnvelope: MobileErrorEnvelopeSchema,
    ProviderCapabilitySet: ProviderCapabilitySetSchema,
    PushEnvelope: PushEnvelopeSchema,
    SyncChange: SyncChangeSchema,
    SyncEnvelope: SyncEnvelopeSchema,
    WorkHorizon: WorkHorizonSchema,
    WorkShape: WorkShapeSchema,
    WorkListItem: WorkListItemSchema,
    WorkMetric: WorkMetricSchema,
    WorkMetricEntry: WorkMetricEntrySchema,
    WorkMetricSummary: WorkMetricSummarySchema,
    WorkMilestone: WorkMilestoneSchema,
    ...MobileSyncChangeVariantSchemas,
    ...MobileCommandVariantSchemas,
  },
};
