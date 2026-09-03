import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  newOperationBatchId,
  recordOperation,
  registerUndoExecutor,
  undoOperation,
} from '@/lib/ai/operations';
import { captureFromChat } from '@/lib/albatross/capture-from-chat';
import { HORIZON_KINDS } from '@/lib/albatross/horizon';
import { generateIntentPlan } from '@/lib/albatross/intent-plan';
import { shapePlans } from '@/lib/albatross/shape-policy';
import { commitWorkSplit, proposeWorkSplit } from '@/lib/albatross/split-work';
import {
  type AlbatrossApplicationStep,
  appliedStepsFromApplyResult,
  buildAlbatrossApplicationPlan,
  unresolvedArtifactsAfterUndo,
} from '@/lib/albatross/work-model';
import { summarizeWorkPlanRevision } from '@/lib/albatross/work-revision';
import { WORK_SHAPES } from '@/lib/albatross/work-shape';
import { resolveWorkByTitle } from '@/lib/albatross/work-title-match';
import { unappliedActions } from '@/lib/albatross/work-v2';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { calendarCreateEvent, calendarRsvpEvent } from './calendar';
import { saveDraftTool, sendMessage } from './compose';
import { documentCreate } from './documents';
import { type AnyTool, defineTool, invokeTool, type ToolContext } from './registry';
import { tasksCreateCard } from './tasks';

const defaultDeps = {
  api,
  convexMutation,
  convexQuery,
  recordOperation,
  newOperationBatchId,
  undoOperation,
  invokeTool,
  generateIntentPlan,
  proposeWorkSplit,
  commitWorkSplit,
  captureFromChat,
  tools: {
    tasksCreateCard,
    calendarCreateEvent,
    calendarRsvpEvent,
    saveDraftTool,
    sendMessage,
    documentCreate,
  },
};

let deps = defaultDeps;

export function __setAlbatrossToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = {
    ...defaultDeps,
    ...overrides,
    tools: {
      ...defaultDeps.tools,
      ...(overrides.tools || {}),
    },
  };
}

function albatrossApi() {
  return (deps.api as any).albatrossWork;
}

function routinesApi() {
  return (deps.api as any).albatrossRoutines;
}

function workV2Api() {
  return (deps.api as any).albatrossWorkV2;
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const sourceRefSchema = z
  .object({
    kind: z.string(),
    id: z.string(),
    label: z.string().optional(),
    accountId: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const digitalActionSchema = z
  .object({
    kind: z.enum([
      'project',
      'task',
      'calendar_event',
      'email_draft',
      'email_send',
      'calendar_rsvp',
      'area_fact',
      'document',
    ]),
    key: z.string().optional(),
    title: z.string(),
    areaId: z.string().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    durationMinutes: z.number().int().positive().optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
    account: z.string().optional(),
    to: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    html: z.string().optional(),
    attendees: z.array(z.any()).optional(),
    calendarId: z.string().optional(),
    eventId: z.string().optional(),
    rsvpStatus: z.enum(['yes', 'no', 'maybe']).optional(),
    description: z.string().optional(),
    documentKind: z.enum(['doc', 'sheet', 'deck']).optional(),
    instructions: z.string().optional(),
    sourceRefs: z.array(sourceRefSchema).optional(),
  })
  .passthrough();

const proposedArtifactSchema = z
  .object({
    kind: z.enum([
      'project',
      'task',
      'calendar_event',
      'email_draft',
      'email_send',
      'calendar_rsvp',
      'area_fact',
      'document',
    ]),
    title: z.string(),
    areaId: z.string().optional(),
    detail: z.string().optional(),
    status: z.string().optional(),
    sourceRefs: z.array(sourceRefSchema).optional(),
  })
  .passthrough();

const planSchema = z
  .object({
    id: z.string().optional(),
    intentId: z.string().optional(),
    outcome: z.string().optional(),
    digitalActions: z.array(digitalActionSchema).optional(),
    proposedArtifacts: z.array(proposedArtifactSchema).optional(),
    sourceRefs: z.array(sourceRefSchema).optional(),
  })
  .passthrough();

const workEvidenceKindSchema = z.enum([
  'mail_thread',
  'calendar_event',
  'task',
  'chat',
  'question_answer',
  'area_fact',
  'github_issue',
  'github_pull_request',
  'github_project',
  'github_project_item',
  'github_commit',
  'mcp_item',
  'manual',
]);

const progressEvidenceSchema = z.object({
  sourceKind: workEvidenceKindSchema.exclude(['chat', 'question_answer']),
  sourceId: z.string().min(1).max(500),
  title: z.string().min(1).max(300),
  summary: z.string().max(1_200).optional(),
  claim: z.string().min(1).max(600).optional(),
  limits: z.string().max(600).optional(),
  url: z.string().max(2_000).optional(),
  connectionId: z.string().max(180).optional(),
  accountId: z.string().max(320).optional(),
  occurredAt: z.number().optional(),
  trust: z.enum(['observed', 'inferred']).default('observed'),
});

function progressSourceId(workId: string, claim: string, operationBatchId?: string) {
  const claimHash = createHash('sha256').update(`${workId}\u001f${claim.trim()}`).digest('hex').slice(0, 24);
  return operationBatchId ? `turn:${operationBatchId}:${claimHash}` : `claim:${claimHash}`;
}

function compactWorkDetail(detail: any) {
  if (!detail?.work) return null;
  return {
    work: {
      id: String(detail.work._id),
      title: detail.work.title || detail.work.rawText,
      rawText: detail.work.rawText,
      state: detail.work.workState || detail.work.status,
      areaId: detail.work.primaryAreaId ? String(detail.work.primaryAreaId) : undefined,
    },
    plan: detail.plan
      ? {
          id: String(detail.plan._id),
          outcome: detail.plan.outcome,
          summary: detail.plan.summary,
          status: detail.plan.status,
          digitalActions: (detail.plan.digitalActions || []).slice(0, 24).map((action: any) => ({
            key: action.key,
            actionKey: action.actionKey,
            kind: action.kind,
            title: action.title,
          })),
          physicalActions: (detail.plan.physicalActions || []).slice(0, 24),
        }
      : null,
    questions: (detail.questions || [])
      .filter((question: any) => question.status === 'pending')
      .slice(0, 8)
      .map((question: any) => ({ id: String(question._id), prompt: question.prompt })),
    evidence: (detail.evidence || []).slice(0, 24).map((item: any) => ({
      id: String(item._id),
      claim: item.claim,
      title: item.title,
      summary: item.summary,
      limits: item.limits,
      sourceKind: item.sourceKind,
      trust: item.trust,
      url: item.url,
    })),
  };
}

function batchContext(ctx: ToolContext, operationBatchId: string): ToolContext {
  return { ...ctx, operationBatchId };
}

/** Which consent an executable step needs before it touches the world. */
export function approvalKind(step: AlbatrossApplicationStep) {
  if (step.kind === 'email_send') return 'email_send';
  if (step.kind === 'calendar_rsvp') return 'calendar_rsvp';
  if (step.kind === 'calendar_event') return 'calendar_invite';
  return 'external_action';
}

/** How much of a plan actually landed. Partial is a real, common outcome. */
export function statusForApplication(input: {
  operations: unknown[];
  approvals: unknown[];
  unresolved: unknown[];
}) {
  if (input.operations.length && (input.approvals.length || input.unresolved.length))
    return 'partially_applied';
  if (input.operations.length) return 'applied';
  return 'queued';
}

async function recordProjectOperation(input: {
  userId: string;
  projectId: string;
  title: string;
  operationBatchId: string;
}) {
  return deps.recordOperation({
    userId: input.userId,
    tool: 'albatross_create_project',
    surface: 'albatross',
    summary: `Created project "${input.title}"`,
    batchId: input.operationBatchId,
    target: { kind: 'project', id: input.projectId },
    inverse: { kind: 'albatross.archive_project', payload: { projectId: input.projectId } },
  });
}

async function recordSprintOperation(input: {
  userId: string;
  sprintId: string;
  title: string;
  operationBatchId?: string;
}) {
  return deps.recordOperation({
    userId: input.userId,
    tool: 'albatross_create_sprint',
    surface: 'albatross',
    summary: `Created sprint "${input.title}"`,
    batchId: input.operationBatchId,
    target: { kind: 'sprint', id: input.sprintId },
    inverse: { kind: 'albatross.archive_sprint', payload: { sprintId: input.sprintId } },
  });
}

async function linkToProject(
  userId: string,
  projectId: string | undefined,
  link: {
    artifactKind: string;
    artifactId: string;
    title?: string;
    areaId?: string;
    operationBatchId?: string;
    sourceIntentId?: string;
    role?: 'primary' | 'supporting' | 'evidence';
  },
) {
  if (!projectId || !link.artifactId) return;
  await deps.convexMutation(albatrossApi().linkArtifact, {
    userId,
    projectId,
    artifactKind: link.artifactKind,
    artifactId: link.artifactId,
    title: link.title,
    areaId: link.areaId,
    operationBatchId: link.operationBatchId,
    sourceIntentId: link.sourceIntentId,
    role: link.role || 'supporting',
  });
}

async function executeToolStep(
  step: AlbatrossApplicationStep,
  ctx: ToolContext,
  options: { projectId?: string; boardId?: string } = {},
) {
  const args = { ...(step.toolArgs || {}) } as Record<string, any>;
  if (step.kind === 'task') {
    // Cards for an area-scoped intent land on the AREA's board (created with
    // the area) instead of the generic default board.
    if (options.boardId && !args.boardId) args.boardId = options.boardId;
    args.source = {
      ...(typeof args.source === 'object' && args.source ? args.source : {}),
      kind: 'chat',
      areaId: step.areaId,
      projectId: options.projectId,
      intentId: args.source?.externalId,
    };
    return deps.invokeTool(deps.tools.tasksCreateCard, args, ctx);
  }
  if (step.kind === 'calendar_event') return deps.invokeTool(deps.tools.calendarCreateEvent, args, ctx);
  if (step.kind === 'email_draft') return deps.invokeTool(deps.tools.saveDraftTool, args, ctx);
  if (step.kind === 'document') return deps.invokeTool(deps.tools.documentCreate, args, ctx);
  throw new Error(`Unsupported executable Albatross step: ${step.kind}`);
}

export function selectDefaultExecutionAccount(
  accounts: Array<{ accountId?: string; status?: string }>,
  calendars: Array<{ accountId?: string; readOnly?: boolean; isPrimary?: boolean }>,
  syncStates: Array<{ accountId?: string; status?: string }>,
): string | undefined {
  const connected = accounts.filter((account) => account.status === 'connected' && account.accountId);
  const unauthorized = new Set(
    syncStates.filter((state) => state.status === 'unauthorized').map((state) => state.accountId),
  );
  const writable = calendars.filter(
    (calendar) => calendar.accountId && !calendar.readOnly && !unauthorized.has(calendar.accountId),
  );
  const writableAccounts = new Set(writable.map((calendar) => calendar.accountId));
  const primary = writable.find((calendar) => calendar.isPrimary)?.accountId;
  if (primary && connected.some((account) => account.accountId === primary)) return primary;
  const calendarAccount = connected.find((account) => writableAccounts.has(account.accountId))?.accountId;
  if (calendarAccount) return calendarAccount;
  // A newly connected mail account may not have completed its first calendar
  // sync yet. It remains useful for drafts, but never outranks a known writable
  // calendar or an account explicitly marked unauthorized.
  return connected.find((account) => !unauthorized.has(account.accountId))?.accountId;
}

// Calendar events and email drafts need a provider account; plans rarely name
// one. Prefer a connected account whose calendar corpus proves it can accept
// the write, instead of trusting insertion order or a stale provider grant.
async function resolveDefaultAccount(userId: string): Promise<string | undefined> {
  try {
    const [accounts, calendars, syncStates] = await Promise.all([
      deps.convexQuery<any[]>((deps.api as any).accounts?.listConnectedAccounts, { userId }),
      deps.convexQuery<any[]>((deps.api as any).calendarData?.listCalendars, { userId }).catch(() => []),
      deps.convexQuery<any[]>((deps.api as any).calendarData?.getSyncStates, { userId }).catch(() => []),
    ]);
    return selectDefaultExecutionAccount(accounts || [], calendars || [], syncStates || []);
  } catch {
    return undefined;
  }
}

// The area's linked task board (ASK: cards for an area go on that area's
// board). Best-effort — a missing or foreign areaId simply means no routing.
async function resolveAreaBoardId(userId: string, areaId: string | undefined): Promise<string | undefined> {
  if (!areaId) return undefined;
  try {
    const area = await deps.convexQuery<any>((deps.api as any).albatross?.getArea, { userId, areaId });
    return area?.boardId ? String(area.boardId) : undefined;
  } catch {
    return undefined;
  }
}

export const albatrossGetWorkContext = defineTool({
  name: 'albatross_get_work_context',
  description:
    'Read one Albatross Work item with its latest versioned plan, open questions, and durable evidence. Use before discussing progress when Work was not already attached by the chat client.',
  category: 'tasks',
  mutating: false,
  input: z.object({ workId: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), context: z.any() }),
  async handler(args, ctx) {
    const detail = await deps.convexQuery<any>(workV2Api().workDetail, {
      userId: requireUserId(ctx.userId),
      workId: args.workId,
    });
    const context = compactWorkDetail(detail);
    if (!context) throw new Error('Albatross Work not found.');
    return { ok: true, context };
  },
});

// The Ask / Hold bar and "hold this" in chat. The assistant calls this only
// when the user asks to hold, keep, or remember something as Work.
export const albatrossCaptureWork = defineTool({
  name: 'albatross_capture_work',
  description:
    'Keep text as Albatross Work when the user explicitly asks to hold, keep, or remember something as work. Never call it on your own initiative. Returns the Work items with their shape and horizon.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    text: z.string().trim().min(1).max(20_000),
    shape: z.enum(WORK_SHAPES).optional(),
    horizon: z
      .object({
        kind: z.enum(HORIZON_KINDS),
        notBefore: z.number().int().nonnegative().optional(),
        by: z.number().int().nonnegative().optional(),
        label: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    conversationId: z.string().trim().min(1).max(240).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    work: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        shape: z.string(),
        horizon: z.any().nullable(),
      }),
    ),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const result = await deps.captureFromChat(
      {
        text: args.text,
        shape: args.shape,
        horizon: args.horizon,
        conversationId: args.conversationId ?? ctx.chatId,
      },
      { userId, email: ctx.userEmail || '', name: ctx.userName || '', source: 'clerk' },
    );
    return {
      ok: true,
      work: result.work.map((item) => ({
        id: item.id,
        title: item.title,
        shape: item.shape,
        horizon: item.horizon,
      })),
    };
  },
});

// Shape-owned chat tools -------------------------------------------------------
//
// "Add Blade Runner to the movie list" and "log 182.4" write straight to the
// Work. Neither is a plan step and neither is proof; the shape policy says a
// list and a practice have no steps to prove.

async function resolveShapedWork(
  userId: string,
  args: { workId?: string; workTitle?: string },
  shape: 'list' | 'practice',
) {
  if (args.workId) {
    const detail = await deps.convexQuery<any>(workV2Api().workDetail, { userId, workId: args.workId });
    if (!detail?.work) throw new Error('Albatross Work not found.');
    return detail.work;
  }
  const title = String(args.workTitle || '').trim();
  if (!title) throw new Error('Name the Work: give workId or workTitle.');
  const rows = await deps.convexQuery<any[]>(workV2Api().allWork, { userId, limit: 300 });
  const match = resolveWorkByTitle(rows || [], title, { shape }) ?? resolveWorkByTitle(rows || [], title);
  if (!match) {
    throw new Error(
      `No ${shape === 'list' ? 'list' : 'practice'} matches "${title}". Ask the user which Work they mean.`,
    );
  }
  return match;
}

export const albatrossListAdd = defineTool({
  name: 'albatross_list_add',
  description:
    'Add one item to a list-shaped Albatross Work ("add Blade Runner to the movie list"). Give workId, or workTitle in the user\'s words; the tool resolves the list by title. Returns the item and the full list.',
  category: 'tasks',
  mutating: true,
  input: z
    .object({
      workId: z.string().min(1).optional(),
      workTitle: z.string().trim().min(1).max(200).optional(),
      text: z.string().trim().min(1).max(500),
    })
    .refine((value) => Boolean(value.workId || value.workTitle), {
      message: 'Give workId or workTitle.',
    }),
  output: z.object({
    ok: z.boolean(),
    workId: z.string(),
    workTitle: z.string(),
    item: z.object({ id: z.string(), text: z.string(), done: z.boolean(), addedAt: z.number() }),
    itemCount: z.number(),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const work = await resolveShapedWork(userId, args, 'list');
    const result = await deps.convexMutation<{ item: any; listItems: any[] }>(workV2Api().addListItem, {
      userId,
      workId: String(work._id),
      text: args.text,
    });
    const workTitle = String(work.title || work.rawText || 'List');
    return {
      ok: true,
      workId: String(work._id),
      workTitle,
      item: { id: result.item.id, text: result.item.text, done: false, addedAt: result.item.addedAt },
      itemCount: result.listItems.length,
      summary: `Added "${result.item.text}" to ${workTitle}.`,
    };
  },
});

export const albatrossMetricLog = defineTool({
  name: 'albatross_metric_log',
  description:
    'Log one value for a practice-shaped Albatross Work ("log 182.4 for the weight goal"). Give workId, or workTitle in the user\'s words. Returns the entry, the metric, and the review line data.',
  category: 'tasks',
  mutating: true,
  input: z
    .object({
      workId: z.string().min(1).optional(),
      workTitle: z.string().trim().min(1).max(200).optional(),
      value: z.number().finite(),
      note: z.string().trim().max(500).optional(),
      atIso: z.string().datetime({ offset: true }).optional(),
    })
    .refine((value) => Boolean(value.workId || value.workTitle), {
      message: 'Give workId or workTitle.',
    }),
  output: z.object({
    ok: z.boolean(),
    workId: z.string(),
    workTitle: z.string(),
    entry: z.object({ id: z.string(), value: z.number(), at: z.number(), note: z.string().nullable() }),
    metric: z.object({
      name: z.string(),
      unit: z.string(),
      target: z.number().optional(),
      direction: z.enum(['down', 'up']).optional(),
    }),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const work = await resolveShapedWork(userId, args, 'practice');
    const at = args.atIso ? Date.parse(args.atIso) : undefined;
    const result = await deps.convexMutation<{ entry: any; metric: any; summary: any }>(
      workV2Api().logMetric,
      {
        userId,
        workId: String(work._id),
        value: args.value,
        ...(typeof at === 'number' && Number.isFinite(at) ? { at } : {}),
        ...(args.note ? { note: args.note } : {}),
      },
    );
    const workTitle = String(work.title || work.rawText || 'Practice');
    const unit = result.metric?.unit ? ` ${result.metric.unit}` : '';
    return {
      ok: true,
      workId: String(work._id),
      workTitle,
      entry: {
        id: String(result.entry._id),
        value: result.entry.value,
        at: result.entry.at,
        note: result.entry.note ?? null,
      },
      metric: {
        name: String(result.metric?.name || 'value'),
        unit: String(result.metric?.unit || ''),
        ...(typeof result.metric?.target === 'number' ? { target: result.metric.target } : {}),
        ...(result.metric?.direction ? { direction: result.metric.direction } : {}),
      },
      summary: `Logged ${result.entry.value}${unit} for ${workTitle}.`,
    };
  },
});

export const albatrossRecordProgress = defineTool({
  name: 'albatross_record_progress',
  description:
    "Persist the user's authoritative progress statement on an existing Albatross Work item, optionally attach corroborating evidence found in mail/calendar/tasks/Granola/GitHub/files/web, and answer any pending Work question the statement resolves. Call this before replanning.",
  category: 'tasks',
  mutating: true,
  input: z.object({
    workId: z.string().min(1),
    claim: z.string().min(1).max(2_000),
    detail: z.string().max(2_000).optional(),
    limits: z.string().max(600).optional(),
    questionAnswers: z
      .array(
        z.object({
          questionId: z.string().min(1),
          answer: z.string().min(1).max(2_000),
          answeredOptionId: z.string().max(80).optional(),
        }),
      )
      .max(8)
      .optional(),
    evidence: z.array(progressEvidenceSchema).max(20).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    workId: z.string(),
    claim: z.string(),
    evidenceRecorded: z.number(),
    questionsAnswered: z.number(),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    // Ownership is checked here before any write, then again by each mutation.
    const detail = await deps.convexQuery<any>(workV2Api().workDetail, { userId, workId: args.workId });
    if (!detail?.work) throw new Error('Albatross Work not found.');

    const userSourceId = progressSourceId(args.workId, args.claim, ctx.operationBatchId);
    await deps.convexMutation(workV2Api().attachProof, {
      userId,
      workId: args.workId,
      claim: args.claim,
      title: 'Progress reported in Albatross chat',
      summary: args.detail || args.claim,
      limits: args.limits || 'User-confirmed progress; connected-source corroboration may be incomplete.',
      sourceKind: 'chat',
      sourceId: userSourceId,
      trust: 'confirmed',
    });

    for (const evidence of args.evidence || []) {
      await deps.convexMutation(workV2Api().attachProof, {
        userId,
        workId: args.workId,
        claim: evidence.claim || args.claim,
        title: evidence.title,
        summary: evidence.summary,
        limits: evidence.limits,
        sourceKind: evidence.sourceKind,
        sourceId: evidence.sourceId,
        connectionId: evidence.connectionId,
        accountId: evidence.accountId,
        occurredAt: evidence.occurredAt,
        url: evidence.url,
        trust: evidence.trust,
      });
    }

    for (const answer of args.questionAnswers || []) {
      await deps.convexMutation(workV2Api().answerQuestion, {
        userId,
        questionId: answer.questionId,
        answer: answer.answer,
        answeredOptionId: answer.answeredOptionId,
      });
    }

    const evidenceRecorded = 1 + (args.evidence?.length || 0);
    return {
      ok: true,
      workId: args.workId,
      claim: args.claim,
      evidenceRecorded,
      questionsAnswered: args.questionAnswers?.length || 0,
      summary: `Recorded the progress report with ${evidenceRecorded} evidence ${evidenceRecorded === 1 ? 'entry' : 'entries'}.`,
    };
  },
});

export const albatrossReplanWork = defineTool({
  name: 'albatross_replan_work',
  description:
    'Regenerate the latest plan for the SAME Albatross Work after progress/evidence has been recorded. Creates a versioned plan revision and returns a compact before/after summary with the new current step.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    workId: z.string().min(1),
    reason: z.string().min(1).max(1_000),
  }),
  output: z.object({
    ok: z.boolean(),
    workId: z.string(),
    planId: z.string(),
    title: z.string(),
    outcome: z.string().optional(),
    currentStep: z.string().optional(),
    changed: z.boolean(),
    keptSteps: z.array(z.string()),
    removedSteps: z.array(z.string()),
    addedSteps: z.array(z.string()),
    actionsApplied: z.number(),
    calendarEventsCreated: z.number(),
    needsInput: z.boolean(),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const before = await deps.convexQuery<any>(workV2Api().workDetail, {
      userId,
      workId: args.workId,
    });
    if (!before?.work) throw new Error('Albatross Work not found.');
    // The shape policy: a list, a practice, a monitor, or a routine keeps no
    // plan. Say so before any state changes, so nothing reads as an error.
    if (shapePlans(before.work.shape) === 'no') {
      throw new Error(
        `This Work is a ${before.work.shape}. It keeps no plan and no steps, so there is nothing to revise.`,
      );
    }
    await deps.convexMutation(workV2Api().setAgentState, {
      userId,
      workId: args.workId,
      agentState: 'researching',
    });
    try {
      const generated = await deps.generateIntentPlan({
        userId,
        userEmail: ctx.userEmail,
        userName: ctx.userName,
        intentId: args.workId,
        timezone: ctx.userTimezone,
      });
      let after = await deps.convexQuery<any>(workV2Api().workDetail, {
        userId,
        workId: args.workId,
      });
      if (!after?.plan || String(after.plan._id) !== String(generated.planId)) {
        throw new Error('The revised Albatross plan could not be loaded.');
      }

      let actionsApplied = 0;
      let calendarEventsCreated = 0;
      const firstOpen =
        (after.questions || []).find((question: any) => question.status === 'pending') ||
        (after.work.questions || []).find((question: any) => !question.answer);
      if (firstOpen) {
        await deps.convexMutation(workV2Api().upsertQuestion, {
          userId,
          workId: args.workId,
          legacyQuestionId: firstOpen.legacyQuestionId || firstOpen.id,
          kind: 'clarification',
          prompt: firstOpen.prompt,
          reason: 'This answer changes the next step or what Albatross will create.',
          options: (firstOpen.options || []).map((option: any) => ({
            id: option.id,
            label: option.label || option.title,
            description: option.description || option.detail,
          })),
          sourceRefs: after.plan.sourceRefs || [],
        });
      } else {
        const applications =
          (await deps
            .convexQuery<any[]>(albatrossApi().listPlanApplications, {
              userId,
              intentId: args.workId,
              limit: 100,
            })
            .catch(() => [])) || [];
        const pendingActions = unappliedActions(after.plan.digitalActions || [], applications);
        if (pendingActions.length) {
          await deps.convexMutation(workV2Api().setAgentState, {
            userId,
            workId: args.workId,
            agentState: 'applying',
          });
          const operationBatchId = ctx.operationBatchId || deps.newOperationBatchId();
          const result: any = await deps.invokeTool(
            albatrossApplyIntentPlan,
            {
              intentId: args.workId,
              intentText: after.work.rawText,
              intentTitle: after.work.title,
              areaId: after.work.primaryAreaId ? String(after.work.primaryAreaId) : after.work.areaId,
              existingProjectId: after.work.primaryProjectId
                ? String(after.work.primaryProjectId)
                : undefined,
              projectMode: after.work.primaryProjectId ? 'task_only' : 'auto',
              projectTitle: after.plan.proposedProjectTitle,
              operationBatchId,
              plan: {
                id: String(after.plan._id),
                intentId: args.workId,
                outcome: after.plan.outcome,
                digitalActions: pendingActions,
                sourceRefs: after.plan.sourceRefs,
              },
            },
            { ...ctx, operationBatchId },
          );
          const appliedSteps = appliedStepsFromApplyResult(result);
          await deps.convexMutation((deps.api as any).albatrossIntents.markPlanApplied, {
            userId,
            planId: String(after.plan._id),
            applicationId: result.applicationId,
            appliedSteps,
          });
          actionsApplied = (result.operations || []).filter(
            (operation: any) => operation.tool !== 'albatross_create_project',
          ).length;
          calendarEventsCreated = (result.operations || []).filter(
            (operation: any) => operation.kind === 'calendar_event',
          ).length;
        } else if ((after.plan.digitalActions || []).length) {
          await deps.convexMutation((deps.api as any).albatrossIntents.markPlanApplied, {
            userId,
            planId: String(after.plan._id),
            appliedSteps: [],
          });
        }
      }

      // A revised plan can legitimately stop at a new question. Research is
      // still finished in that case; leaving the Work in `researching` makes
      // the UI look stuck while it is actually waiting for the user.
      await deps.convexMutation(workV2Api().setAgentState, {
        userId,
        workId: args.workId,
        agentState: 'idle',
      });

      after = await deps.convexQuery<any>(workV2Api().workDetail, {
        userId,
        workId: args.workId,
      });
      if (!after?.work || !after?.plan) {
        throw new Error('The revised Albatross plan could not be reloaded.');
      }
      const reconciledEvidenceAt = before.work.lastEvidenceAt;
      if (typeof reconciledEvidenceAt === 'number') {
        await deps.convexMutation(workV2Api().completeEvidenceReconcile, {
          userId,
          workId: args.workId,
          evidenceAt: reconciledEvidenceAt,
        });
      }
      const revision = summarizeWorkPlanRevision(before.plan, after.plan);
      const title = String(after.work.title || after.plan.outcome || before.work.rawText || 'Albatross Work');
      const needsInput = Boolean(firstOpen);
      const activity = [
        actionsApplied ? `created ${actionsApplied} ${actionsApplied === 1 ? 'action' : 'actions'}` : '',
        calendarEventsCreated
          ? `placed ${calendarEventsCreated} ${calendarEventsCreated === 1 ? 'hold' : 'holds'} on the calendar`
          : '',
      ].filter(Boolean);
      return {
        ok: true,
        workId: args.workId,
        planId: String(generated.planId),
        title,
        outcome: after.plan.outcome,
        currentStep: revision.currentStep,
        changed: revision.changed,
        keptSteps: revision.keptSteps,
        removedSteps: revision.removedSteps,
        addedSteps: revision.addedSteps,
        actionsApplied,
        calendarEventsCreated,
        needsInput,
        summary: needsInput
          ? 'Updated the plan as far as the evidence allows. One answer is still needed in chat.'
          : revision.currentStep
            ? `Updated the plan${activity.length ? `, ${activity.join(' and ')}` : ''}. The next step is “${revision.currentStep}”.`
            : `Updated the plan${activity.length ? ` and ${activity.join(' and ')}` : ''}; no remaining step is currently proposed.`,
      };
    } catch (error) {
      await deps
        .convexMutation(workV2Api().setAgentState, {
          userId,
          workId: args.workId,
          agentState: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }
  },
});

function approvalToolFor(name: string): AnyTool {
  if (name === 'send_message') return deps.tools.sendMessage;
  if (name === 'calendar_create_event') return deps.tools.calendarCreateEvent;
  if (name === 'calendar_rsvp_event') return deps.tools.calendarRsvpEvent;
  throw new Error(`Approval tool not allowed: ${name}`);
}

export const albatrossSplitWork = defineTool({
  name: 'albatross_split_work',
  description:
    'Split one Albatross Work that bundles several independent outcomes into sibling Works. Call without items to get a proposal to show the user. Call again with the confirmed items to commit: children are created, the parent is released with provenance, and the children are planned.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    workId: z.string().min(1),
    focus: z.string().max(300).optional(),
    items: z
      .array(
        z.object({
          title: z.string().min(1).max(180),
          rawText: z.string().min(1).max(20_000),
        }),
      )
      .min(2)
      .max(6)
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    workId: z.string(),
    committed: z.boolean(),
    proposed: z.array(z.object({ title: z.string(), rawText: z.string() })).optional(),
    workIds: z.array(z.string()).optional(),
    summary: z.string(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    if (!args.items) {
      const proposal = await deps.proposeWorkSplit({
        userId,
        userEmail: ctx.userEmail ?? undefined,
        userName: ctx.userName ?? undefined,
        workId: args.workId,
        focus: args.focus,
      });
      return {
        ok: true,
        workId: args.workId,
        committed: false,
        proposed: proposal.items.map((item) => ({ title: item.title, rawText: item.rawText })),
        summary: `Proposed ${proposal.items.length} Works: ${proposal.items
          .map((item) => item.title)
          .join('; ')}. Show the proposal and commit only after the user confirms.`,
      };
    }
    const committed = await deps.commitWorkSplit({
      userId,
      userEmail: ctx.userEmail ?? undefined,
      userName: ctx.userName ?? undefined,
      workId: args.workId,
      items: args.items,
      timezone: ctx.userTimezone,
    });
    return {
      ok: true,
      workId: args.workId,
      committed: true,
      workIds: committed.workIds,
      summary: `Split into ${committed.workIds.length} Works. The parent is released with provenance.`,
    };
  },
});

export const albatrossApplyIntentPlan = defineTool({
  name: 'albatross_apply_intent_plan',
  description:
    'Apply an Albatross intent plan through real safe tools. Creates tasks/calendar holds/drafts/projects in one operation batch and queues human-facing actions for approval.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    intentId: z.string(),
    intentText: z.string().optional(),
    intentTitle: z.string().optional(),
    areaId: z.string().optional(),
    account: z.string().optional(),
    existingProjectId: z.string().optional(),
    projectMode: z.enum(['auto', 'project', 'task_only', 'ask']).default('auto'),
    projectTitle: z.string().optional(),
    operationBatchId: z.string().optional(),
    plan: planSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    operationBatchId: z.string(),
    applicationId: z.string().optional(),
    projectId: z.string().optional(),
    operations: z.array(z.any()),
    approvals: z.array(z.any()),
    unresolved: z.array(z.any()),
    preview: z.any(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const operationBatchId = args.operationBatchId || ctx.operationBatchId || deps.newOperationBatchId();
    const [account, areaBoardId] = await Promise.all([
      args.account ? Promise.resolve(args.account) : resolveDefaultAccount(userId),
      resolveAreaBoardId(userId, args.areaId),
    ]);
    const plan = buildAlbatrossApplicationPlan({
      intentId: args.intentId,
      intentText: args.intentText,
      intentTitle: args.intentTitle,
      areaId: args.areaId,
      projectMode: args.existingProjectId ? 'task_only' : args.projectMode,
      projectTitle: args.projectTitle,
      account,
      plan: args.plan as any,
    });

    let projectId: string | undefined = args.existingProjectId;
    const operations: any[] = [];
    const artifacts: any[] = [];
    const approvalIds: string[] = [];
    const approvals: any[] = [];

    for (const step of plan.executableSteps) {
      if (step.kind === 'project') {
        projectId = await deps.convexMutation<string>(albatrossApi().createProject, {
          userId,
          externalId: `intent:${args.intentId}`,
          title: step.title,
          outcome: args.plan.outcome,
          areaId: args.areaId || step.areaId,
          sourceIntentId: args.intentId,
          sourceBatchId: operationBatchId,
          sourceRefs: step.sourceRefs,
        });
        const operationId = await recordProjectOperation({
          userId,
          projectId,
          title: step.title,
          operationBatchId,
        });
        operations.push({ operationId, tool: 'albatross_create_project', projectId, title: step.title });
        artifacts.push({ kind: 'project', id: projectId, title: step.title, operationId });
        await linkToProject(userId, projectId, {
          artifactKind: 'intent',
          artifactId: args.intentId,
          title: args.intentText || args.intentId,
          areaId: args.areaId,
          operationBatchId,
          sourceIntentId: args.intentId,
          role: 'primary',
        });
        continue;
      }
      const result: any = await executeToolStep(step, batchContext(ctx, operationBatchId), {
        projectId,
        boardId: areaBoardId,
      });
      const artifactId =
        result.cardId ||
        result.eventId ||
        result.draft?._id ||
        result.draft?.id ||
        result.documentId ||
        result.operationId ||
        step.id;
      operations.push({
        operationId: result.operationId,
        tool: step.toolName,
        artifactId,
        title: step.title,
        // stepKey/kind let callers map plan steps back to created artifacts
        // (the plan dossier's toggleable task cards).
        stepKey: step.stepKey,
        actionKey: step.actionKey,
        kind: step.kind,
        result,
      });
      artifacts.push({
        kind:
          step.kind === 'calendar_event'
            ? 'calendarEvent'
            : step.kind === 'email_draft'
              ? 'emailDraft'
              : step.kind === 'document'
                ? 'document'
                : step.kind,
        id: artifactId,
        title: step.title,
        operationId: result.operationId,
        actionKey: step.actionKey,
        stepKey: step.stepKey,
      });
      await linkToProject(userId, projectId, {
        artifactKind:
          step.kind === 'calendar_event'
            ? 'calendarEvent'
            : step.kind === 'email_draft'
              ? 'emailDraft'
              : step.kind === 'document'
                ? 'document'
                : 'task',
        artifactId,
        title: step.title,
        areaId: step.areaId,
        operationBatchId,
        sourceIntentId: args.intentId,
      });
    }

    for (const step of plan.approvalSteps) {
      const approvalId = await deps.convexMutation<string>(albatrossApi().enqueueApproval, {
        userId,
        kind: approvalKind(step),
        title: step.title,
        detail: args.plan.outcome,
        areaId: step.areaId || args.areaId,
        projectId,
        intentId: args.intentId,
        operationBatchId,
        artifactKind: step.kind,
        artifactId: step.id,
        toolName: step.toolName || 'external_action',
        toolArgs: step.toolArgs || {},
        risk: 'Human-facing action. Requires explicit approval before provider write.',
      });
      approvalIds.push(String(approvalId));
      approvals.push({
        approvalId,
        title: step.title,
        toolName: step.toolName,
        toolArgs: step.toolArgs,
        stepKey: step.stepKey,
        actionKey: step.actionKey,
        kind: step.kind,
      });
      artifacts.push({
        kind: 'approval',
        id: String(approvalId),
        title: step.title,
        actionKey: step.actionKey,
        stepKey: step.stepKey,
      });
      await linkToProject(userId, projectId, {
        artifactKind: 'operationBatch',
        artifactId: String(approvalId),
        title: `Approval: ${step.title}`,
        areaId: step.areaId,
        operationBatchId,
        sourceIntentId: args.intentId,
      });
    }

    const applicationStatus = statusForApplication({
      operations,
      approvals,
      unresolved: plan.unresolved,
    });
    const applicationId = await deps.convexMutation<string>(albatrossApi().recordPlanApplication, {
      userId,
      intentId: args.intentId,
      intentText: args.intentText,
      planId: args.plan.id,
      areaId: args.areaId,
      projectId,
      operationBatchId,
      status: applicationStatus,
      artifacts,
      operationIds: operations.map((operation) => String(operation.operationId || '')).filter(Boolean),
      pendingApprovalIds: approvalIds,
      unresolvedArtifacts: plan.unresolved,
    });

    return {
      ok: true,
      operationBatchId,
      applicationId,
      projectId,
      operations,
      approvals,
      unresolved: plan.unresolved,
      preview: plan,
    };
  },
});

export const albatrossListApprovalQueue = defineTool({
  name: 'albatross_list_approval_queue',
  description: 'List pending or recent Albatross human approval cards.',
  category: 'tasks',
  mutating: false,
  input: z.object({
    status: z.enum(['pending', 'claiming', 'approved', 'rejected', 'undone', 'expired']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ approvals: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const approvals = await deps.convexQuery<any[]>(albatrossApi().listApprovals, {
      userId,
      ...(args.status ? { status: args.status } : {}),
      limit: args.limit,
    });
    return { approvals };
  },
});

export const albatrossApproveAction = defineTool({
  name: 'albatross_approve_action',
  description:
    'Approve one Albatross approval card and execute its allowlisted human-facing tool. editedArgs can override the stored args before execution.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    approvalId: z.string(),
    editedArgs: z.record(z.string(), z.any()).optional(),
    operationBatchId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), result: z.any().optional(), approval: z.any().optional() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const approval = await deps.convexQuery<any | null>(albatrossApi().getApproval, {
      userId,
      approvalId: args.approvalId,
    });
    if (!approval) throw new Error('Approval not found.');
    if (approval.status !== 'pending') throw new Error(`Approval is already ${approval.status}.`);
    const tool = approvalToolFor(approval.toolName);
    await deps.convexMutation(albatrossApi().claimApproval, {
      userId,
      approvalId: args.approvalId,
    });
    let result: any;
    try {
      result = await deps.invokeTool(
        tool,
        { ...(approval.toolArgs || {}), ...(args.editedArgs || {}) },
        batchContext(
          ctx,
          args.operationBatchId ||
            approval.operationBatchId ||
            ctx.operationBatchId ||
            deps.newOperationBatchId(),
        ),
      );
    } catch (error) {
      await deps
        .convexMutation(albatrossApi().decideApproval, {
          userId,
          approvalId: args.approvalId,
          status: 'rejected',
          decisionNote: `Approval execution failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        .catch(() => {});
      throw error;
    }
    const decided = await deps.convexMutation<any>(albatrossApi().decideApproval, {
      userId,
      approvalId: args.approvalId,
      status: 'approved',
      decisionNote: 'Approved from Albatross approval queue.',
      result,
      ...(result?.operationId ? { undoExpiresAt: Date.now() + 10_000 } : {}),
    });
    return { ok: true, result, approval: decided.approval };
  },
});

export const albatrossRejectAction = defineTool({
  name: 'albatross_reject_action',
  description: 'Reject an Albatross approval card. The originating plan remains unresolved/rejected.',
  category: 'tasks',
  mutating: true,
  input: z.object({ approvalId: z.string(), reason: z.string().optional() }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    await deps.convexMutation(albatrossApi().decideApproval, {
      userId,
      approvalId: args.approvalId,
      status: 'rejected',
      decisionNote: args.reason || 'Rejected from Albatross approval queue.',
    });
    return { ok: true };
  },
});

export const albatrossUndoApproval = defineTool({
  name: 'albatross_undo_approval',
  description:
    'Mark an approved Albatross approval as undone during its short undo window. Provider-level undo is delegated to the underlying operation when available.',
  category: 'tasks',
  mutating: true,
  input: z.object({ approvalId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const approval = await deps.convexQuery<any | null>(albatrossApi().getApproval, {
      userId,
      approvalId: args.approvalId,
    });
    if (!approval) throw new Error('Approval not found.');
    if (approval.status !== 'approved') throw new Error(`Only approved actions can be undone.`);
    if (approval.undoExpiresAt && Date.now() > approval.undoExpiresAt) {
      throw new Error('Undo window expired.');
    }
    const operationId = approval.result?.operationId;
    if (!operationId) {
      throw new Error('This approval did not record an undoable provider operation.');
    }
    await deps.undoOperation(userId, operationId);
    await deps.convexMutation(albatrossApi().decideApproval, {
      userId,
      approvalId: args.approvalId,
      status: 'undone',
      decisionNote: 'Undone from Albatross approval queue.',
    });
    return { ok: true };
  },
});

export const albatrossCreateProject = defineTool({
  name: 'albatross_create_project',
  description: 'Create or update an Albatross project/epic without creating task cards by itself.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    externalId: z.string().optional(),
    title: z.string(),
    outcome: z.string().optional(),
    areaId: z.string().optional(),
    sourceIntentId: z.string().optional(),
    sourceRefs: z.array(sourceRefSchema).optional(),
    operationBatchId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), projectId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const operationBatchId = args.operationBatchId || ctx.operationBatchId || deps.newOperationBatchId();
    const projectId = await deps.convexMutation<string>(albatrossApi().createProject, {
      userId,
      externalId: args.externalId,
      title: args.title,
      outcome: args.outcome,
      areaId: args.areaId,
      sourceIntentId: args.sourceIntentId,
      sourceBatchId: operationBatchId,
      sourceRefs: args.sourceRefs,
    });
    const operationId = await recordProjectOperation({
      userId,
      projectId,
      title: args.title,
      operationBatchId,
    });
    return { ok: true, projectId, operationId };
  },
});

export const albatrossListProjects = defineTool({
  name: 'albatross_list_projects',
  description: 'List Albatross projects by status or area.',
  category: 'tasks',
  mutating: false,
  input: z.object({
    status: z.enum(['active', 'paused', 'done', 'archived']).optional(),
    areaId: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ projects: z.array(z.any()) }),
  async handler(args, ctx) {
    const projects = await deps.convexQuery<any[]>(albatrossApi().listProjects, {
      userId: requireUserId(ctx.userId),
      status: args.status,
      areaId: args.areaId,
      limit: args.limit,
    });
    return { projects };
  },
});

export const albatrossUpdateProject = defineTool({
  name: 'albatross_update_project',
  description: 'Change an Albatross project state after explicit user review.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    projectId: z.string(),
    status: z.enum(['active', 'paused', 'done', 'archived']),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const pane = await deps.convexQuery<any>(albatrossApi().getProjectPane, {
      userId,
      projectId: args.projectId,
    });
    const previousStatus = pane?.project?.status || 'active';
    await deps.convexMutation(albatrossApi().updateProject, {
      userId,
      projectId: args.projectId,
      status: args.status,
    });
    const operationId = await deps.recordOperation({
      userId,
      tool: 'albatross_update_project',
      surface: 'albatross',
      summary: `Changed project "${pane?.project?.title || 'Project'}" to ${args.status}`,
      target: { kind: 'project', id: args.projectId },
      inverse: {
        kind: 'albatross.restore_project_status',
        payload: { projectId: args.projectId, status: previousStatus },
      },
    });
    return { ok: true, operationId };
  },
});

export const albatrossCreateRoutine = defineTool({
  name: 'albatross_create_routine',
  description:
    'Create a durable recurring routine inside an Albatross Project/Epic. Use this after the user declares a recurring personal or professional commitment, such as daily weight-loss actions, an evening food check-in, a weekly client review, or weekday launch work. A routine can materialize tasks, questions, or both in the user’s local timezone. It never enables notifications silently; the living assistant asks once for notification consent after the first check-in.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    projectId: z.string(),
    areaId: z.string().optional(),
    title: z.string().min(1).max(180),
    purpose: z.string().max(800).optional(),
    kind: z.enum(['task', 'checkin', 'task_and_checkin', 'review']),
    cadence: z.enum(['daily', 'weekly', 'weekdays', 'custom']).default('daily'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    localTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('19:00'),
    timezone: z.string().optional(),
    activation: z.enum(['active', 'proposed']).default('active'),
    taskTemplate: z
      .object({
        title: z.string().min(1).max(300),
        description: z.string().max(2_000).optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
      })
      .optional(),
    questionTemplate: z
      .object({
        prompt: z.string().min(1).max(700),
        reason: z.string().max(700).optional(),
        responseKind: z.enum(['text', 'single_select', 'multi_select', 'number', 'boolean']).optional(),
        options: z
          .array(
            z.object({
              id: z.string().max(80),
              label: z.string().max(180),
              description: z.string().max(400).optional(),
            }),
          )
          .max(8)
          .optional(),
      })
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    routineId: z.string(),
    status: z.enum(['active', 'proposed']),
    notification: z.enum(['asks_once_after_first_checkin', 'not_requested_for_task_only']),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const routineId = await deps.convexMutation<string>(routinesApi().create, {
      userId,
      projectId: args.projectId,
      areaId: args.areaId,
      title: args.title,
      purpose: args.purpose,
      kind: args.kind,
      cadence: args.cadence,
      daysOfWeek: args.daysOfWeek,
      localTime: args.localTime,
      timezone: args.timezone || ctx.userTimezone || 'UTC',
      taskTemplate: args.taskTemplate,
      questionTemplate: args.questionTemplate,
      consent: args.activation === 'active' ? 'enabled' : 'proposed',
      notification: { enabled: false, channel: 'in_app' },
    });
    return {
      ok: true,
      routineId: String(routineId),
      status: args.activation,
      notification:
        args.kind === 'task'
          ? ('not_requested_for_task_only' as const)
          : ('asks_once_after_first_checkin' as const),
    };
  },
});

export const albatrossListRoutines = defineTool({
  name: 'albatross_list_routines',
  description: 'List active and proposed routines, recent runs, and pending check-ins for one Project/Epic.',
  category: 'tasks',
  mutating: false,
  input: z.object({ projectId: z.string() }),
  output: z.object({ routines: z.array(z.any()) }),
  async handler(args, ctx) {
    const routines = await deps.convexQuery<any[]>(routinesApi().listForProject, {
      userId: requireUserId(ctx.userId),
      projectId: args.projectId,
    });
    return { routines };
  },
});

export const albatrossSetRoutineConsent = defineTool({
  name: 'albatross_set_routine_consent',
  description:
    'Enable, pause, or decline a routine only after the user explicitly agrees. Notification delivery is a separate explicit choice and defaults off.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    routineId: z.string(),
    consent: z.enum(['enabled', 'declined', 'proposed']),
    localTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    timezone: z.string().optional(),
    notificationEnabled: z.boolean().optional(),
    notificationChannel: z.literal('in_app').optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    await deps.convexMutation(routinesApi().setConsent, {
      userId: requireUserId(ctx.userId),
      routineId: args.routineId,
      consent: args.consent,
      localTime: args.localTime,
      timezone: args.timezone || ctx.userTimezone,
      notificationEnabled: args.notificationEnabled,
      notificationChannel: args.notificationChannel,
    });
    return { ok: true };
  },
});

export const albatrossRunRoutineNow = defineTool({
  name: 'albatross_run_routine_now',
  description:
    'Materialize today’s task/check-in for an enabled routine now. The stable local-date run key prevents duplicate tasks or questions.',
  category: 'tasks',
  mutating: true,
  input: z.object({ routineId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    await deps.convexMutation(routinesApi().runNow, {
      userId: requireUserId(ctx.userId),
      routineId: args.routineId,
    });
    return { ok: true };
  },
});

export const albatrossGetProjectPane = defineTool({
  name: 'albatross_get_project_pane',
  description:
    'Get one Albatross project pane with linked tasks, events, threads, MCP items, sprints, approvals, and plan applications.',
  category: 'tasks',
  mutating: false,
  input: z.object({ projectId: z.string() }),
  output: z.object({ pane: z.any() }),
  async handler(args, ctx) {
    const pane = await deps.convexQuery<any>(albatrossApi().getProjectPane, {
      userId: requireUserId(ctx.userId),
      projectId: args.projectId,
    });
    return { pane };
  },
});

export const albatrossCreateSprint = defineTool({
  name: 'albatross_create_sprint',
  description: 'Create an Albatross sprint, optionally scoped to a project.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    projectId: z.string().optional(),
    externalId: z.string().optional(),
    title: z.string(),
    goal: z.string().optional(),
    cadence: z.enum(['weekly', 'monthly', 'custom']).default('weekly'),
    status: z.enum(['planned', 'active', 'closed', 'archived']).default('planned'),
    startAt: z.number().optional(),
    endAt: z.number().optional(),
    operationBatchId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), sprintId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const operationBatchId = args.operationBatchId || ctx.operationBatchId || deps.newOperationBatchId();
    const sprintId = await deps.convexMutation<string>(albatrossApi().createSprint, {
      userId,
      projectId: args.projectId,
      externalId: args.externalId,
      title: args.title,
      goal: args.goal,
      cadence: args.cadence,
      status: args.status,
      startAt: args.startAt,
      endAt: args.endAt,
    });
    const operationId = await recordSprintOperation({
      userId,
      sprintId,
      title: args.title,
      operationBatchId,
    });
    return { ok: true, sprintId, operationId };
  },
});

export const albatrossListSprints = defineTool({
  name: 'albatross_list_sprints',
  description: 'List Albatross sprints globally or for one project.',
  category: 'tasks',
  mutating: false,
  input: z.object({
    projectId: z.string().optional(),
    status: z.enum(['planned', 'active', 'closed', 'archived']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ sprints: z.array(z.any()) }),
  async handler(args, ctx) {
    const sprints = await deps.convexQuery<any[]>(albatrossApi().listSprints, {
      userId: requireUserId(ctx.userId),
      projectId: args.projectId,
      status: args.status,
      limit: args.limit,
    });
    return { sprints };
  },
});

export const albatrossPreviewUndoUnresolved = defineTool({
  name: 'albatross_preview_undo_unresolved',
  description:
    'Given a stored application artifact list and operation rows, return which artifacts would reappear as unresolved after undo.',
  category: 'tasks',
  mutating: false,
  input: z.object({ application: z.any(), operations: z.array(z.any()) }),
  output: z.object({ unresolved: z.array(z.any()) }),
  async handler(args) {
    return { unresolved: unresolvedArtifactsAfterUndo(args.application, args.operations) };
  },
});

registerUndoExecutor('albatross.archive_project', async (payload, ctx) => {
  await deps.convexMutation(albatrossApi().updateProject, {
    userId: ctx.userId,
    projectId: payload.projectId,
    status: 'archived',
  });
});

registerUndoExecutor('albatross.restore_project_status', async (payload, ctx) => {
  await deps.convexMutation(albatrossApi().updateProject, {
    userId: ctx.userId,
    projectId: payload.projectId,
    status: payload.status,
  });
});

registerUndoExecutor('albatross.archive_sprint', async (payload, ctx) => {
  await deps.convexMutation(albatrossApi().updateSprint, {
    userId: ctx.userId,
    sprintId: payload.sprintId,
    status: 'archived',
  });
});
