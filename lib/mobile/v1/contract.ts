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
  CalendarEventSyncChange: CalendarEventSyncChangeSchema,
  TaskSyncChange: TaskSyncChangeSchema,
  WorkSyncChange: WorkSyncChangeSchema,
  ApprovalSyncChange: ApprovalSyncChangeSchema,
  OperationSyncChange: OperationSyncChangeSchema,
} as const;

export const SyncChangeSchema = z.discriminatedUnion('entityKind', [
  MobileSyncChangeVariantSchemas.MailThreadSyncChange,
  MobileSyncChangeVariantSchemas.MailMessageSyncChange,
  MobileSyncChangeVariantSchemas.CalendarEventSyncChange,
  MobileSyncChangeVariantSchemas.TaskSyncChange,
  MobileSyncChangeVariantSchemas.WorkSyncChange,
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

const mailMessagePayload = z
  .object({
    accountID: identifier,
    messageID: identifier,
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

const taskCreatePayload = z
  .object({
    boardID: optionalIdentifier,
    column: z.string().trim().min(1).max(160).optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    dueAt: isoTimestamp.optional(),
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
  .object({ ...mobileCommandBase, kind: z.literal('mail.markUnread'), payload: mailMessagePayload })
  .strict();
export const MailStarCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.star'), payload: mailMessagePayload })
  .strict();
export const MailUnstarCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('mail.unstar'), payload: mailMessagePayload })
  .strict();
export const CalendarCreateCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('calendar.create'), payload: calendarCreatePayload })
  .strict();
export const TaskCreateCommandSchema = z
  .object({ ...mobileCommandBase, kind: z.literal('task.create'), payload: taskCreatePayload })
  .strict();
export const TaskSetCompletedCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('task.setCompleted'),
    payload: z.object({ cardID: identifier, completed: z.boolean() }).strict(),
  })
  .strict();
export const WorkCaptureCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('work.capture'),
    payload: z
      .object({
        rawText: z.string().trim().min(1).max(20_000),
        transcript: z.string().max(20_000).optional(),
        source: z.enum(['text', 'voice', 'chat']),
        areaID: optionalIdentifier,
      })
      .strict(),
  })
  .strict();
export const ApprovalApproveCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('approval.approve'),
    payload: z
      .object({
        approvalID: identifier,
        editedArguments: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export const ApprovalRejectCommandSchema = z
  .object({
    ...mobileCommandBase,
    kind: z.literal('approval.reject'),
    payload: z.object({ approvalID: identifier, reason: z.string().max(1_000).optional() }).strict(),
  })
  .strict();

export const MobileCommandVariantSchemas = {
  MailArchiveCommand: MailArchiveCommandSchema,
  MailTrashCommand: MailTrashCommandSchema,
  MailMarkReadCommand: MailMarkReadCommandSchema,
  MailMarkUnreadCommand: MailMarkUnreadCommandSchema,
  MailStarCommand: MailStarCommandSchema,
  MailUnstarCommand: MailUnstarCommandSchema,
  CalendarCreateCommand: CalendarCreateCommandSchema,
  TaskCreateCommand: TaskCreateCommandSchema,
  TaskSetCompletedCommand: TaskSetCompletedCommandSchema,
  WorkCaptureCommand: WorkCaptureCommandSchema,
  ApprovalApproveCommand: ApprovalApproveCommandSchema,
  ApprovalRejectCommand: ApprovalRejectCommandSchema,
} as const;

const commandSchemas = Object.values(MobileCommandVariantSchemas) as [
  typeof MailArchiveCommandSchema,
  typeof MailTrashCommandSchema,
  typeof MailMarkReadCommandSchema,
  typeof MailMarkUnreadCommandSchema,
  typeof MailStarCommandSchema,
  typeof MailUnstarCommandSchema,
  typeof CalendarCreateCommandSchema,
  typeof TaskCreateCommandSchema,
  typeof TaskSetCompletedCommandSchema,
  typeof WorkCaptureCommandSchema,
  typeof ApprovalApproveCommandSchema,
  typeof ApprovalRejectCommandSchema,
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
    CommandReceipt: CommandReceiptSchema,
    MobileBootstrap: MobileBootstrapSchema,
    MobileCommand: MobileCommandSchema,
    MobileErrorEnvelope: MobileErrorEnvelopeSchema,
    ProviderCapabilitySet: ProviderCapabilitySetSchema,
    PushEnvelope: PushEnvelopeSchema,
    SyncChange: SyncChangeSchema,
    SyncEnvelope: SyncEnvelopeSchema,
    ...MobileSyncChangeVariantSchemas,
    ...MobileCommandVariantSchemas,
  },
};
