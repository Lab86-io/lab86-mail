import { z } from 'zod';
import {
  newOperationBatchId,
  recordOperation,
  registerUndoExecutor,
  undoOperation,
} from '@/lib/ai/operations';
import {
  type AlbatrossApplicationStep,
  buildAlbatrossApplicationPlan,
  unresolvedArtifactsAfterUndo,
} from '@/lib/albatross/work-model';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { calendarCreateEvent, calendarRsvpEvent } from './calendar';
import { saveDraftTool, sendMessage } from './compose';
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
  tools: {
    tasksCreateCard,
    calendarCreateEvent,
    calendarRsvpEvent,
    saveDraftTool,
    sendMessage,
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

function batchContext(ctx: ToolContext, operationBatchId: string): ToolContext {
  return { ...ctx, operationBatchId };
}

function approvalKind(step: AlbatrossApplicationStep) {
  if (step.kind === 'email_send') return 'email_send';
  if (step.kind === 'calendar_rsvp') return 'calendar_rsvp';
  if (step.kind === 'calendar_event') return 'calendar_invite';
  return 'external_action';
}

function statusForApplication(input: { operations: unknown[]; approvals: unknown[]; unresolved: unknown[] }) {
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
  throw new Error(`Unsupported executable Albatross step: ${step.kind}`);
}

// Calendar events and email drafts need a provider account; plans rarely name
// one. Fall back to the user's first connected account so those steps execute
// instead of silently landing in "unresolved".
async function resolveDefaultAccount(userId: string): Promise<string | undefined> {
  try {
    const accounts = await deps.convexQuery<any[]>((deps.api as any).accounts?.listConnectedAccounts, {
      userId,
    });
    const connected = (accounts || []).find((account) => account.status === 'connected');
    return connected?.accountId ? String(connected.accountId) : undefined;
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

function approvalToolFor(name: string): AnyTool {
  if (name === 'send_message') return deps.tools.sendMessage;
  if (name === 'calendar_create_event') return deps.tools.calendarCreateEvent;
  if (name === 'calendar_rsvp_event') return deps.tools.calendarRsvpEvent;
  throw new Error(`Approval tool not allowed: ${name}`);
}

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
      projectMode: args.projectMode,
      projectTitle: args.projectTitle,
      account,
      plan: args.plan as any,
    });

    let projectId: string | undefined;
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

registerUndoExecutor('albatross.archive_sprint', async (payload, ctx) => {
  await deps.convexMutation(albatrossApi().updateSprint, {
    userId: ctx.userId,
    sprintId: payload.sprintId,
    status: 'archived',
  });
});
