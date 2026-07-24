import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { normalizeSourceRefs, normalizeText } from './albatrossModel';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const sourceRefValidator = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  accountId: v.optional(v.string()),
  url: v.optional(v.string()),
});

const projectStatusValidator = v.union(
  v.literal('active'),
  v.literal('paused'),
  v.literal('done'),
  v.literal('archived'),
);

const sprintStatusValidator = v.union(
  v.literal('planned'),
  v.literal('active'),
  v.literal('closed'),
  v.literal('archived'),
);

const approvalStatusValidator = v.union(
  v.literal('pending'),
  v.literal('claiming'),
  v.literal('approved'),
  v.literal('rejected'),
  v.literal('undone'),
  v.literal('expired'),
);

const approvalKindValidator = v.union(
  v.literal('email_send'),
  v.literal('calendar_invite'),
  v.literal('calendar_rsvp'),
  v.literal('provider_write'),
  v.literal('external_action'),
);

const artifactKindValidator = v.union(
  v.literal('task'),
  v.literal('calendarEvent'),
  v.literal('mailThread'),
  v.literal('mcpItem'),
  v.literal('intent'),
  v.literal('emailDraft'),
  v.literal('areaFact'),
  v.literal('sprint'),
  v.literal('operationBatch'),
);

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
): Promise<string> {
  if (args.internalSecret) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

function bounded(value: string | undefined, max: number, fallback = '') {
  if (value === undefined) return undefined;
  return normalizeText(value, fallback).slice(0, max);
}

// --- completion events (issue #87/#18) ---------------------------------------

// Pure early/late math for completion events. Exactly one side is set when a
// due date exists ("done exactly on time" counts as 0ms early); both stay
// unset when the artifact never had a due date, so reports can distinguish
// "no deadline" from "on the deadline".
export function completionDelta(
  completedAt: number,
  dueAt?: number,
): { completedEarlyByMs?: number; completedLateByMs?: number } {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt) || !Number.isFinite(completedAt)) return {};
  const delta = dueAt - completedAt;
  return delta >= 0 ? { completedEarlyByMs: delta } : { completedLateByMs: -delta };
}

// Best-effort history insert shared by every completion hook (boards cards,
// intents, intent plans, projects). History bookkeeping must never fail the
// user-facing mutation that triggered it.
export async function recordCompletionEvent(
  ctx: MutationCtx,
  event: {
    userId: string;
    artifactKind: 'task' | 'intent' | 'intent_plan' | 'project';
    artifactId: string;
    completedAt: number;
    dueAt?: number;
    areaId?: string;
    intentId?: string;
    projectId?: Id<'albatrossProjects'>;
  },
): Promise<void> {
  try {
    await ctx.db.insert('completionEvents', {
      userId: event.userId,
      areaId: event.areaId,
      intentId: event.intentId,
      projectId: event.projectId,
      artifactKind: event.artifactKind,
      artifactId: event.artifactId.slice(0, 240),
      completedAt: event.completedAt,
      dueAt: event.dueAt,
      ...completionDelta(event.completedAt, event.dueAt),
      createdAt: now(),
    });
  } catch {
    // Non-fatal by design: completing the artifact matters more than logging it.
  }
}

async function requireProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'albatrossProjects'>,
  userId: string,
) {
  const project = await ctx.db.get(projectId);
  if (!project || project.userId !== userId) throw new Error('Project not found.');
  return project;
}

async function requireSprint(ctx: QueryCtx | MutationCtx, sprintId: Id<'albatrossSprints'>, userId: string) {
  const sprint = await ctx.db.get(sprintId);
  if (!sprint || sprint.userId !== userId) throw new Error('Sprint not found.');
  return sprint;
}

async function projectByExternalId(ctx: QueryCtx | MutationCtx, userId: string, externalId?: string) {
  if (!externalId) return null;
  return ctx.db
    .query('albatrossProjects')
    .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', externalId))
    .unique();
}

async function sprintByExternalId(ctx: QueryCtx | MutationCtx, userId: string, externalId?: string) {
  if (!externalId) return null;
  return ctx.db
    .query('albatrossSprints')
    .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', externalId))
    .unique();
}

export const createProject = mutation({
  args: {
    ...callerArgs,
    externalId: v.optional(v.string()),
    title: v.string(),
    outcome: v.optional(v.string()),
    areaId: v.optional(v.string()),
    status: v.optional(projectStatusValidator),
    sourceIntentId: v.optional(v.string()),
    sourceBatchId: v.optional(v.string()),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const externalId = bounded(args.externalId, 160);
    const existing = await projectByExternalId(ctx, userId, externalId);
    const ts = now();
    const doc = {
      externalId,
      title: bounded(args.title, 180, 'Untitled project')!,
      outcome: bounded(args.outcome, 1200),
      areaId: bounded(args.areaId, 160),
      status: args.status || 'active',
      sourceIntentId: bounded(args.sourceIntentId, 160),
      sourceBatchId: bounded(args.sourceBatchId, 180),
      sourceRefs: normalizeSourceRefs(args.sourceRefs),
      updatedAt: ts,
      completedAt: args.status === 'done' ? ts : undefined,
      archivedAt: args.status === 'archived' ? ts : undefined,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert('albatrossProjects', {
      userId,
      ...doc,
      createdAt: ts,
    });
  },
});

export const updateProject = mutation({
  args: {
    ...callerArgs,
    projectId: v.id('albatrossProjects'),
    title: v.optional(v.string()),
    outcome: v.optional(v.string()),
    areaId: v.optional(v.string()),
    status: v.optional(projectStatusValidator),
    activeSprintId: v.optional(v.id('albatrossSprints')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const project = await requireProject(ctx, args.projectId, userId);
    if (args.activeSprintId) {
      const sprint = await requireSprint(ctx, args.activeSprintId, userId);
      if (sprint.projectId !== args.projectId) {
        throw new Error('Active sprint must belong to this project.');
      }
    }
    const ts = now();
    await ctx.db.patch(args.projectId, {
      ...(args.title !== undefined ? { title: bounded(args.title, 180, 'Untitled project') } : {}),
      ...(args.outcome !== undefined ? { outcome: bounded(args.outcome, 1200) } : {}),
      ...(args.areaId !== undefined ? { areaId: bounded(args.areaId, 160) } : {}),
      ...(args.status !== undefined
        ? {
            status: args.status,
            completedAt: args.status === 'done' ? ts : undefined,
            archivedAt: args.status === 'archived' ? ts : undefined,
          }
        : {}),
      ...(args.activeSprintId !== undefined ? { activeSprintId: args.activeSprintId } : {}),
      updatedAt: ts,
    });
    // Completion history: only a real transition into 'done' records an event.
    if (args.status === 'done' && project.status !== 'done') {
      await recordCompletionEvent(ctx, {
        userId,
        artifactKind: 'project',
        artifactId: String(args.projectId),
        completedAt: ts,
        areaId: args.areaId !== undefined ? bounded(args.areaId, 160) : project.areaId,
        intentId: project.sourceIntentId,
        projectId: args.projectId,
      });
    }
    return { ok: true };
  },
});

export const listProjects = query({
  args: {
    ...callerArgs,
    status: v.optional(projectStatusValidator),
    areaId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('albatrossProjects')
      .withIndex(args.status ? 'by_user_status' : args.areaId ? 'by_user_area' : 'by_user', (q) => {
        const byUser = q.eq('userId', userId);
        if (args.status) return byUser.eq('status', args.status);
        if (args.areaId) return byUser.eq('areaId', args.areaId);
        return byUser;
      })
      .collect();
    return rows
      .filter((project) => (args.status ? project.status === args.status : true))
      .filter((project) => (args.areaId ? project.areaId === args.areaId : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  },
});

export const linkArtifact = mutation({
  args: {
    ...callerArgs,
    projectId: v.id('albatrossProjects'),
    artifactKind: artifactKindValidator,
    artifactId: v.string(),
    accountId: v.optional(v.string()),
    areaId: v.optional(v.string()),
    role: v.optional(v.union(v.literal('primary'), v.literal('supporting'), v.literal('evidence'))),
    sourceIntentId: v.optional(v.string()),
    operationBatchId: v.optional(v.string()),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireProject(ctx, args.projectId, userId);
    const artifactId = bounded(args.artifactId, 240, '')!;
    if (!artifactId) throw new Error('artifactId required.');
    const existing = await ctx.db
      .query('albatrossProjectLinks')
      .withIndex('by_user_artifact', (q) =>
        q.eq('userId', userId).eq('artifactKind', args.artifactKind).eq('artifactId', artifactId),
      )
      .collect();
    const duplicate = existing.find((link) => link.projectId === args.projectId);
    const ts = now();
    const doc = {
      accountId: bounded(args.accountId, 160),
      areaId: bounded(args.areaId, 160),
      role: args.role || 'supporting',
      sourceIntentId: bounded(args.sourceIntentId, 160),
      operationBatchId: bounded(args.operationBatchId, 180),
      title: bounded(args.title, 240),
      url: bounded(args.url, 600),
      updatedAt: ts,
    };
    if (duplicate) {
      await ctx.db.patch(duplicate._id, doc);
      return duplicate._id;
    }
    return ctx.db.insert('albatrossProjectLinks', {
      userId,
      projectId: args.projectId,
      artifactKind: args.artifactKind,
      artifactId,
      ...doc,
      createdAt: ts,
    });
  },
});

export const createSprint = mutation({
  args: {
    ...callerArgs,
    projectId: v.optional(v.id('albatrossProjects')),
    externalId: v.optional(v.string()),
    title: v.string(),
    goal: v.optional(v.string()),
    cadence: v.optional(v.union(v.literal('weekly'), v.literal('monthly'), v.literal('custom'))),
    status: v.optional(sprintStatusValidator),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.projectId) await requireProject(ctx, args.projectId, userId);
    const externalId = bounded(args.externalId, 160);
    const existing = await sprintByExternalId(ctx, userId, externalId);
    const ts = now();
    const doc = {
      projectId: args.projectId,
      externalId,
      title: bounded(args.title, 180, 'Untitled sprint')!,
      goal: bounded(args.goal, 900),
      cadence: args.cadence || 'weekly',
      status: args.status || 'planned',
      startAt: args.startAt,
      endAt: args.endAt,
      closedAt: args.status === 'closed' ? ts : undefined,
      archivedAt: args.status === 'archived' ? ts : undefined,
      updatedAt: ts,
    };
    if (existing) {
      const previousProjectId = existing.projectId;
      await ctx.db.patch(existing._id, doc);
      if (previousProjectId && (previousProjectId !== args.projectId || doc.status !== 'active')) {
        const previousProject = await ctx.db.get(previousProjectId);
        if (previousProject?.activeSprintId === existing._id) {
          await ctx.db.patch(previousProjectId, { activeSprintId: undefined, updatedAt: ts });
        }
      }
      if (args.projectId && doc.status === 'active') {
        await ctx.db.patch(args.projectId, { activeSprintId: existing._id, updatedAt: ts });
      }
      return existing._id;
    }
    const sprintId = await ctx.db.insert('albatrossSprints', {
      userId,
      ...doc,
      createdAt: ts,
    });
    if (args.projectId && doc.status === 'active') {
      await ctx.db.patch(args.projectId, { activeSprintId: sprintId, updatedAt: ts });
    }
    return sprintId;
  },
});

export const updateSprint = mutation({
  args: {
    ...callerArgs,
    sprintId: v.id('albatrossSprints'),
    title: v.optional(v.string()),
    goal: v.optional(v.string()),
    status: v.optional(sprintStatusValidator),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const sprint = await requireSprint(ctx, args.sprintId, userId);
    const ts = now();
    await ctx.db.patch(args.sprintId, {
      ...(args.title !== undefined ? { title: bounded(args.title, 180, 'Untitled sprint') } : {}),
      ...(args.goal !== undefined ? { goal: bounded(args.goal, 900) } : {}),
      ...(args.status !== undefined
        ? {
            status: args.status,
            closedAt: args.status === 'closed' ? ts : undefined,
            archivedAt: args.status === 'archived' ? ts : undefined,
          }
        : {}),
      ...(args.startAt !== undefined ? { startAt: args.startAt } : {}),
      ...(args.endAt !== undefined ? { endAt: args.endAt } : {}),
      updatedAt: ts,
    });
    if (sprint.projectId) {
      if (args.status === 'active') {
        await ctx.db.patch(sprint.projectId, { activeSprintId: args.sprintId, updatedAt: ts });
      }
      if (
        (args.status === 'closed' || args.status === 'archived') &&
        (await ctx.db.get(sprint.projectId))?.activeSprintId === args.sprintId
      ) {
        await ctx.db.patch(sprint.projectId, { activeSprintId: undefined, updatedAt: ts });
      }
    }
    return { ok: true };
  },
});

export const listSprints = query({
  args: {
    ...callerArgs,
    projectId: v.optional(v.id('albatrossProjects')),
    status: v.optional(sprintStatusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('albatrossSprints')
      .withIndex(args.projectId ? 'by_user_project' : args.status ? 'by_user_status' : 'by_user', (q) => {
        const byUser = q.eq('userId', userId);
        if (args.projectId) return byUser.eq('projectId', args.projectId);
        if (args.status) return byUser.eq('status', args.status);
        return byUser;
      })
      .collect();
    return rows
      .filter((sprint) => (args.projectId ? sprint.projectId === args.projectId : true))
      .filter((sprint) => (args.status ? sprint.status === args.status : true))
      .sort((a, b) => (a.startAt ?? a.updatedAt) - (b.startAt ?? b.updatedAt))
      .slice(0, limit);
  },
});

export const enqueueApproval = mutation({
  args: {
    ...callerArgs,
    kind: approvalKindValidator,
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
    risk: v.optional(v.string()),
    undoExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.projectId) await requireProject(ctx, args.projectId, userId);
    if (args.sprintId) await requireSprint(ctx, args.sprintId, userId);
    const ts = now();
    return ctx.db.insert('albatrossApprovals', {
      userId,
      kind: args.kind,
      status: 'pending',
      title: bounded(args.title, 220, 'Approval required')!,
      detail: bounded(args.detail, 1600),
      areaId: bounded(args.areaId, 160),
      intentId: bounded(args.intentId, 160),
      projectId: args.projectId,
      sprintId: args.sprintId,
      operationBatchId: bounded(args.operationBatchId, 180),
      artifactKind: bounded(args.artifactKind, 80),
      artifactId: bounded(args.artifactId, 240),
      toolName: bounded(args.toolName, 120, 'unknown')!,
      toolArgs: args.toolArgs ?? {},
      risk: bounded(args.risk, 600),
      undoExpiresAt: args.undoExpiresAt,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const listApprovals = query({
  args: {
    ...callerArgs,
    status: v.optional(approvalStatusValidator),
    projectId: v.optional(v.id('albatrossProjects')),
    intentId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const defaultQueueStatuses = ['pending', 'claiming'] as const;
    if (!args.status && !args.projectId && !args.intentId) {
      const rows = (
        await Promise.all(
          defaultQueueStatuses.map((status) =>
            ctx.db
              .query('albatrossApprovals')
              .withIndex('by_user_status_created', (q) => q.eq('userId', userId).eq('status', status))
              .order('desc')
              .take(limit),
          ),
        )
      ).flat();
      return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }
    const rows = await ctx.db
      .query('albatrossApprovals')
      .withIndex(
        args.status
          ? 'by_user_status_created'
          : args.projectId
            ? 'by_user_project'
            : args.intentId
              ? 'by_user_intent'
              : 'by_user',
        (q) => {
          const byUser = q.eq('userId', userId);
          if (args.status) return byUser.eq('status', args.status);
          if (args.projectId) return byUser.eq('projectId', args.projectId);
          if (args.intentId) return byUser.eq('intentId', args.intentId);
          return byUser;
        },
      )
      .collect();
    const defaultQueueStatusSet = new Set<string>(defaultQueueStatuses);
    return rows
      .filter((approval) =>
        args.status ? approval.status === args.status : defaultQueueStatusSet.has(approval.status),
      )
      .filter((approval) => (args.projectId ? approval.projectId === args.projectId : true))
      .filter((approval) => (args.intentId ? approval.intentId === args.intentId : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
});

export const getApproval = query({
  args: { ...callerArgs, approvalId: v.id('albatrossApprovals') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const approval = await ctx.db.get(args.approvalId);
    if (!approval || approval.userId !== userId) return null;
    return approval;
  },
});

export const decideApproval = mutation({
  args: {
    ...callerArgs,
    approvalId: v.id('albatrossApprovals'),
    status: v.union(v.literal('approved'), v.literal('rejected'), v.literal('undone')),
    decisionNote: v.optional(v.string()),
    result: v.optional(v.any()),
    undoExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const approval = await ctx.db.get(args.approvalId);
    if (!approval || approval.userId !== userId) throw new Error('Approval not found.');
    if (args.status === 'approved' && approval.status !== 'claiming' && approval.status !== 'pending') {
      throw new Error(`Approval is already ${approval.status}.`);
    }
    if (args.status === 'rejected' && approval.status !== 'pending' && approval.status !== 'claiming') {
      throw new Error(`Approval is already ${approval.status}.`);
    }
    if (args.status === 'undone') {
      if (approval.status !== 'approved') throw new Error(`Only approved actions can be undone.`);
      if (!approval.undoExpiresAt || now() > approval.undoExpiresAt) throw new Error('Undo window expired.');
    }
    const ts = now();
    const undoExpiresAt =
      args.undoExpiresAt !== undefined ? Math.min(args.undoExpiresAt, ts + 10_000) : undefined;
    const patch = {
      status: args.status,
      decisionNote: bounded(args.decisionNote, 800),
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(undoExpiresAt !== undefined ? { undoExpiresAt } : {}),
      decidedAt: ts,
      updatedAt: ts,
    };
    await ctx.db.patch(args.approvalId, patch);
    return { ok: true, approval: { ...approval, ...patch } };
  },
});

export const claimApproval = mutation({
  args: { ...callerArgs, approvalId: v.id('albatrossApprovals') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const approval = await ctx.db.get(args.approvalId);
    if (!approval || approval.userId !== userId) throw new Error('Approval not found.');
    if (approval.status !== 'pending') throw new Error(`Approval is already ${approval.status}.`);
    const ts = now();
    await ctx.db.patch(args.approvalId, { status: 'claiming', updatedAt: ts });
    return { ok: true, approval: { ...approval, status: 'claiming', updatedAt: ts } };
  },
});

export const recordPlanApplication = mutation({
  args: {
    ...callerArgs,
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
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (args.projectId) await requireProject(ctx, args.projectId, userId);
    const intentId = bounded(args.intentId, 160, '')!;
    const operationBatchId = bounded(args.operationBatchId, 180, '')!;
    if (!intentId) throw new Error('intentId required.');
    if (!operationBatchId) throw new Error('operationBatchId required.');
    const ts = now();
    return ctx.db.insert('albatrossPlanApplications', {
      userId,
      intentId,
      intentText: bounded(args.intentText, 1600),
      planId: bounded(args.planId, 160),
      areaId: bounded(args.areaId, 160),
      projectId: args.projectId,
      operationBatchId,
      status: args.status,
      artifacts: args.artifacts,
      operationIds: args.operationIds,
      pendingApprovalIds: args.pendingApprovalIds,
      unresolvedArtifacts: args.unresolvedArtifacts,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const listPlanApplications = query({
  args: { ...callerArgs, intentId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const intentId = args.intentId;
    const rows = intentId
      ? await ctx.db
          .query('albatrossPlanApplications')
          .withIndex('by_user_intent', (q) => q.eq('userId', userId).eq('intentId', intentId))
          .collect()
      : await ctx.db
          .query('albatrossPlanApplications')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
});

export const dailyReportContext = query({
  args: { ...callerArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const [projects, approvals, applications, sprints, areas, checkins] = await Promise.all([
      ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(limit),
      ctx.db
        .query('albatrossApprovals')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(limit),
      ctx.db
        .query('albatrossPlanApplications')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(limit),
      ctx.db
        .query('albatrossSprints')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .take(limit),
      ctx.db
        .query('areas')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', 'active'))
        .collect(),
      ctx.db
        .query('albatrossDailyCheckins')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .order('desc')
        .take(7),
    ]);

    return {
      projects,
      approvals,
      applications,
      sprints,
      areas,
      checkins,
    };
  },
});

// --- project progress (issue #87/#18, feeds the task-board progress UI) ------

// Contract FROZEN for the progress UI: each row is
// { _id, title, outcome, status, areaId, sourceIntentId, createdAt, updatedAt,
//   taskCount, completedTaskCount, intentCount, eventCount }.
// Counts come from albatrossProjectLinks; completedTaskCount resolves linked
// cards (capped) and checks card.completedAt.
const PROGRESS_PROJECT_CAP = 50;
const PROGRESS_TASK_RESOLVE_CAP = 100;

export const listProjectsWithProgress = query({
  args: { ...callerArgs, status: v.optional(projectStatusValidator) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossProjects')
      .withIndex(args.status ? 'by_user_status' : 'by_user', (q) => {
        const byUser = q.eq('userId', userId);
        return args.status ? byUser.eq('status', args.status) : byUser;
      })
      .collect();
    const projects = rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PROGRESS_PROJECT_CAP);
    return Promise.all(
      projects.map(async (project) => {
        const links = await ctx.db
          .query('albatrossProjectLinks')
          .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', project._id))
          .collect();
        const taskLinks = links.filter((link) => link.artifactKind === 'task');
        let completedTaskCount = 0;
        for (const link of taskLinks.slice(0, PROGRESS_TASK_RESOLVE_CAP)) {
          const cardId = ctx.db.normalizeId('cards', link.artifactId);
          const card = cardId ? await ctx.db.get(cardId) : null;
          if (card && card.userId === userId && card.completedAt) completedTaskCount += 1;
        }
        return {
          _id: project._id,
          title: project.title,
          outcome: project.outcome,
          status: project.status,
          areaId: project.areaId,
          sourceIntentId: project.sourceIntentId,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          taskCount: taskLinks.length,
          completedTaskCount,
          intentCount: links.filter((link) => link.artifactKind === 'intent').length,
          eventCount: links.filter((link) => link.artifactKind === 'calendarEvent').length,
        };
      }),
    );
  },
});

// Contract FROZEN for the progress UI: each row is
// { cardId, boardId, title, completedAt, dueAt, updatedAt, columnName? } (≤100),
// resolved from this project's task links; dead links are dropped.
export const projectTasks = query({
  args: { ...callerArgs, projectId: v.id('albatrossProjects') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireProject(ctx, args.projectId, userId);
    const links = await ctx.db
      .query('albatrossProjectLinks')
      .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', args.projectId))
      .collect();
    const taskLinks = links
      .filter((link) => link.artifactKind === 'task')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, PROGRESS_TASK_RESOLVE_CAP);
    const cards = (
      await Promise.all(
        taskLinks.map(async (link) => {
          const cardId = ctx.db.normalizeId('cards', link.artifactId);
          const card = cardId ? await ctx.db.get(cardId) : null;
          return card && card.userId === userId ? card : null;
        }),
      )
    ).filter((card) => card !== null);
    const columnIds = [...new Set(cards.map((card) => card.columnId))];
    const columns = await Promise.all(columnIds.map((id) => ctx.db.get(id)));
    const columnNames = new Map(
      columns.filter(Boolean).map((column) => [column!._id, column!.name] as const),
    );
    return cards.map((card) => ({
      cardId: card._id,
      boardId: card.boardId,
      title: card.title,
      completedAt: card.completedAt,
      dueAt: card.dueAt,
      updatedAt: card.updatedAt,
      columnName: columnNames.get(card.columnId),
    }));
  },
});

// Contract FROZEN for issue #18 reporting:
// { completedThisPeriod, completedPriorPeriod, onTimeRate? }.
// Simple, honest math over completionEvents: this period vs the period of the
// same length before it; onTimeRate only over this period's events that had a
// due date (undefined when none did — no fabricated rates).
export const projectProgressSummary = query({
  args: { ...callerArgs, sinceDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const days = Math.min(Math.max(Math.round(args.sinceDays ?? 7), 1), 90);
    const ts = now();
    const periodMs = days * 86_400_000;
    const since = ts - periodMs;
    const priorSince = ts - 2 * periodMs;
    const events = await ctx.db
      .query('completionEvents')
      .withIndex('by_user_completedAt', (q) => q.eq('userId', userId).gte('completedAt', priorSince))
      .collect();
    const thisPeriod = events.filter((event) => event.completedAt >= since);
    const priorPeriod = events.filter((event) => event.completedAt < since);
    const withDue = thisPeriod.filter((event) => typeof event.dueAt === 'number');
    const onTime = withDue.filter((event) => event.completedAt <= (event.dueAt as number));
    return {
      completedThisPeriod: thisPeriod.length,
      completedPriorPeriod: priorPeriod.length,
      onTimeRate: withDue.length ? onTime.length / withDue.length : undefined,
    };
  },
});

export const getProjectPane = query({
  args: { ...callerArgs, projectId: v.id('albatrossProjects') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const project = await requireProject(ctx, args.projectId, userId);
    const [links, sprints, approvals, applications] = await Promise.all([
      ctx.db
        .query('albatrossProjectLinks')
        .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', args.projectId))
        .collect(),
      ctx.db
        .query('albatrossSprints')
        .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', args.projectId))
        .collect(),
      ctx.db
        .query('albatrossApprovals')
        .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', args.projectId))
        .collect(),
      ctx.db
        .query('albatrossPlanApplications')
        .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', args.projectId))
        .collect(),
    ]);
    const taskLinks = links.filter((link) => link.artifactKind === 'task');
    const tasks = (
      await Promise.all(
        taskLinks.map(async (link) => {
          const cardId = ctx.db.normalizeId('cards', link.artifactId);
          const card = cardId ? await ctx.db.get(cardId) : null;
          if (!card || card.userId !== userId) return { link, card: null };
          return { link, card };
        }),
      )
    ).filter((item) => item.card || item.link.title);
    return {
      project,
      links: links.sort((a, b) => b.createdAt - a.createdAt),
      tasks,
      sprints: sprints.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0)),
      approvals: approvals.sort((a, b) => b.createdAt - a.createdAt),
      applications: applications.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});
