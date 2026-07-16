import { v } from 'convex/values';
import { localDateKey } from '../lib/albatross/local-time';
import { nextRoutineRunAt, routineIsInQuietHours, routineRunKey } from '../lib/albatross/routines';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const kindValidator = v.union(
  v.literal('task'),
  v.literal('checkin'),
  v.literal('task_and_checkin'),
  v.literal('review'),
);
const statusValidator = v.union(
  v.literal('proposed'),
  v.literal('active'),
  v.literal('paused'),
  v.literal('archived'),
);
const consentValidator = v.union(v.literal('proposed'), v.literal('enabled'), v.literal('declined'));
const cadenceValidator = v.union(
  v.literal('daily'),
  v.literal('weekly'),
  v.literal('weekdays'),
  v.literal('custom'),
);
const responseKindValidator = v.union(
  v.literal('text'),
  v.literal('single_select'),
  v.literal('multi_select'),
  v.literal('number'),
  v.literal('boolean'),
);
const taskTemplateValidator = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  priority: v.optional(v.union(v.literal('low'), v.literal('medium'), v.literal('high'))),
});
const questionTemplateValidator = v.object({
  prompt: v.string(),
  reason: v.optional(v.string()),
  responseKind: v.optional(responseKindValidator),
  options: v.optional(
    v.array(v.object({ id: v.string(), label: v.string(), description: v.optional(v.string()) })),
  ),
});
const notificationValidator = v.object({
  enabled: v.boolean(),
  channel: v.literal('in_app'),
});

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
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

async function requireRoutine(
  ctx: QueryCtx | MutationCtx,
  routineId: Id<'albatrossRoutines'>,
  userId: string,
) {
  const routine = await ctx.db.get(routineId);
  if (!routine || routine.userId !== userId) throw new Error('Routine not found.');
  return routine;
}

function clean(value: string | undefined | null, max: number) {
  const next = String(value || '').trim();
  return next ? next.slice(0, max) : undefined;
}

function validateTimezone(timezone: string) {
  const value = clean(timezone, 100) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error('Invalid timezone.');
  }
}

function validateClock(localTime: string) {
  const value = clean(localTime, 5) || '19:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Time must be HH:MM.');
  return value;
}

function normalizedDays(days?: number[], cadence?: 'daily' | 'weekly' | 'weekdays' | 'custom') {
  const supplied = days || [];
  if (
    cadence === 'custom' &&
    (supplied.length === 0 || supplied.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    throw new Error('Custom routines need at least one valid day of the week.');
  }
  return [...new Set(supplied.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
}

function requireNextRoutineRunAt(schedule: Parameters<typeof nextRoutineRunAt>[0], after: number) {
  const next = nextRoutineRunAt(schedule, after);
  if (next === null) throw new Error('Routine schedule does not have a valid next run.');
  return next;
}

function templateText(
  value: string | undefined,
  project: Pick<Doc<'albatrossProjects'>, 'title'>,
  localDate: string,
) {
  return String(value || '')
    .replaceAll('{{project}}', project.title)
    .replaceAll('{{date}}', localDate)
    .trim();
}

interface EvidenceInput {
  userId: string;
  targetKind?: 'area' | 'project' | 'work' | 'routine';
  targetId?: string;
  sourceKind:
    | 'mail_thread'
    | 'calendar_event'
    | 'task'
    | 'chat'
    | 'question_answer'
    | 'area_fact'
    | 'github_issue'
    | 'github_pull_request'
    | 'github_project'
    | 'github_project_item'
    | 'github_commit'
    | 'mcp_item'
    | 'manual';
  sourceId: string;
  connectionId?: string;
  accountId?: string;
  title: string;
  summary?: string;
  url?: string;
  occurredAt: number;
  weight: number;
  confidence: number;
  trust: 'observed' | 'inferred' | 'confirmed' | 'rejected';
  dedupeKey: string;
  searchText: string;
  metadata?: unknown;
}

async function insertEvidence(ctx: MutationCtx, input: EvidenceInput) {
  const existing = await ctx.db
    .query('albatrossEvidence')
    .withIndex('by_user_dedupe', (q) => q.eq('userId', input.userId).eq('dedupeKey', input.dedupeKey))
    .unique();
  const ts = now();
  const doc = { ...input, updatedAt: ts };
  if (existing) {
    await ctx.db.patch(existing._id, doc);
    return existing._id;
  }
  return ctx.db.insert('albatrossEvidence', { ...doc, createdAt: ts });
}

export const create = mutation({
  args: {
    ...callerArgs,
    projectId: v.id('albatrossProjects'),
    areaId: v.optional(v.id('areas')),
    title: v.string(),
    purpose: v.optional(v.string()),
    kind: kindValidator,
    cadence: cadenceValidator,
    daysOfWeek: v.optional(v.array(v.number())),
    localTime: v.string(),
    timezone: v.string(),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    taskTemplate: v.optional(taskTemplateValidator),
    questionTemplate: v.optional(questionTemplateValidator),
    notification: v.optional(notificationValidator),
    consent: v.optional(consentValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const project = await requireProject(ctx, args.projectId, userId);
    let areaId = args.areaId;
    if (!areaId && project.areaId) areaId = ctx.db.normalizeId('areas', project.areaId) || undefined;
    if (areaId) {
      const area = await ctx.db.get(areaId);
      if (!area || area.userId !== userId || area.status !== 'active') throw new Error('Area not found.');
    }
    if ((args.kind === 'task' || args.kind === 'task_and_checkin') && !args.taskTemplate) {
      throw new Error('Task routines need a task template.');
    }
    if (
      (args.kind === 'checkin' || args.kind === 'task_and_checkin' || args.kind === 'review') &&
      !args.questionTemplate
    ) {
      throw new Error('Check-in routines need a question template.');
    }
    const timezone = validateTimezone(args.timezone);
    const localTime = validateClock(args.localTime);
    const consent = args.consent ?? 'proposed';
    const ts = now();
    const schedule = {
      cadence: args.cadence,
      daysOfWeek: normalizedDays(args.daysOfWeek, args.cadence),
      localTime,
      timezone,
    };
    return ctx.db.insert('albatrossRoutines', {
      userId,
      projectId: args.projectId,
      areaId,
      title: clean(args.title, 180) || 'Untitled routine',
      purpose: clean(args.purpose, 800),
      kind: args.kind,
      status: consent === 'enabled' ? 'active' : 'proposed',
      consent,
      ...schedule,
      quietHoursStart: args.quietHoursStart ? validateClock(args.quietHoursStart) : undefined,
      quietHoursEnd: args.quietHoursEnd ? validateClock(args.quietHoursEnd) : undefined,
      taskTemplate: args.taskTemplate
        ? {
            title: clean(args.taskTemplate.title, 300) || 'Routine task',
            description: clean(args.taskTemplate.description, 2_000),
            priority: args.taskTemplate.priority,
          }
        : undefined,
      questionTemplate: args.questionTemplate
        ? {
            prompt: clean(args.questionTemplate.prompt, 700) || 'How did this go?',
            reason: clean(args.questionTemplate.reason, 700),
            responseKind: args.questionTemplate.responseKind ?? 'text',
            options: args.questionTemplate.options?.slice(0, 8).map((option) => ({
              id: clean(option.id, 80) || 'option',
              label: clean(option.label, 180) || 'Option',
              description: clean(option.description, 400),
            })),
          }
        : undefined,
      notification: args.notification ?? { enabled: false, channel: 'in_app' },
      nextRunAt: requireNextRoutineRunAt(schedule, ts),
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const setConsent = mutation({
  args: {
    ...callerArgs,
    routineId: v.id('albatrossRoutines'),
    consent: consentValidator,
    localTime: v.optional(v.string()),
    timezone: v.optional(v.string()),
    notificationEnabled: v.optional(v.boolean()),
    notificationChannel: v.optional(v.literal('in_app')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const routine = await requireRoutine(ctx, args.routineId, userId);
    if (args.consent === 'enabled') {
      const project = await ctx.db.get(routine.projectId);
      if (!project || project.userId !== userId || project.status === 'archived') {
        throw new Error('The routine project is unavailable.');
      }
    }
    const timezone = args.timezone ? validateTimezone(args.timezone) : routine.timezone;
    const localTime = args.localTime ? validateClock(args.localTime) : routine.localTime;
    const ts = now();
    await ctx.db.patch(args.routineId, {
      consent: args.consent,
      status: args.consent === 'enabled' ? 'active' : args.consent === 'declined' ? 'paused' : 'proposed',
      timezone,
      localTime,
      notification: {
        enabled: args.notificationEnabled ?? routine.notification.enabled,
        channel: args.notificationChannel ?? 'in_app',
      },
      nextRunAt: requireNextRoutineRunAt({ ...routine, timezone, localTime }, ts),
      updatedAt: ts,
    });
    await insertEvidence(ctx, {
      userId,
      targetKind: 'routine',
      targetId: String(args.routineId),
      sourceKind: 'question_answer',
      sourceId: `routine-consent:${String(args.routineId)}`,
      title: `${routine.title}: ${args.consent}`,
      summary: `The user ${args.consent === 'enabled' ? 'enabled' : args.consent === 'declined' ? 'declined' : 'has not decided on'} this routine.`,
      occurredAt: ts,
      weight: args.consent === 'proposed' ? 0.5 : 1,
      confidence: 1,
      trust: 'confirmed',
      dedupeKey: `routine-consent:${String(args.routineId)}`,
      searchText: `${routine.title} routine consent ${args.consent}`,
      metadata: { consent: args.consent },
    });
    return { ok: true };
  },
});

export const updateSchedule = mutation({
  args: {
    ...callerArgs,
    routineId: v.id('albatrossRoutines'),
    title: v.optional(v.string()),
    purpose: v.optional(v.string()),
    cadence: v.optional(cadenceValidator),
    daysOfWeek: v.optional(v.array(v.number())),
    localTime: v.optional(v.string()),
    timezone: v.optional(v.string()),
    status: v.optional(statusValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const routine = await requireRoutine(ctx, args.routineId, userId);
    if (args.status === 'active') {
      if (routine.consent !== 'enabled') throw new Error('Enable the routine before activating it.');
      const project = await ctx.db.get(routine.projectId);
      if (!project || project.userId !== userId || project.status === 'archived') {
        throw new Error('The routine project is unavailable.');
      }
    }
    const next = {
      ...routine,
      cadence: args.cadence ?? routine.cadence,
      daysOfWeek: args.daysOfWeek
        ? normalizedDays(args.daysOfWeek, args.cadence ?? routine.cadence)
        : routine.daysOfWeek,
      localTime: args.localTime ? validateClock(args.localTime) : routine.localTime,
      timezone: args.timezone ? validateTimezone(args.timezone) : routine.timezone,
    };
    const ts = now();
    await ctx.db.patch(args.routineId, {
      ...(args.title !== undefined ? { title: clean(args.title, 180) || routine.title } : {}),
      ...(args.purpose !== undefined ? { purpose: clean(args.purpose, 800) } : {}),
      ...(args.cadence !== undefined ? { cadence: next.cadence } : {}),
      ...(args.daysOfWeek !== undefined ? { daysOfWeek: next.daysOfWeek } : {}),
      ...(args.localTime !== undefined ? { localTime: next.localTime } : {}),
      ...(args.timezone !== undefined ? { timezone: next.timezone } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      nextRunAt: requireNextRoutineRunAt(next, ts),
      updatedAt: ts,
      ...(args.status === 'archived' ? { archivedAt: ts } : {}),
    });
    return { ok: true };
  },
});

export const runNow = mutation({
  args: { ...callerArgs, routineId: v.id('albatrossRoutines') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const routine = await requireRoutine(ctx, args.routineId, userId);
    if (routine.consent !== 'enabled') throw new Error('Enable the routine before running it.');
    await ctx.scheduler.runAfter(0, internal.albatrossRoutines.materializeOne, {
      routineId: args.routineId,
      force: true,
    });
    return { ok: true };
  },
});

export const skipNext = mutation({
  args: { ...callerArgs, routineId: v.id('albatrossRoutines') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const routine = await requireRoutine(ctx, args.routineId, userId);
    const scheduled = new Date(routine.nextRunAt);
    const key = routineRunKey(String(routine._id), routine.timezone, scheduled);
    const existing = await ctx.db
      .query('albatrossRoutineRuns')
      .withIndex('by_routine_runKey', (q) => q.eq('routineId', routine._id).eq('runKey', key))
      .unique();
    const ts = now();
    if (!existing) {
      await ctx.db.insert('albatrossRoutineRuns', {
        userId,
        routineId: routine._id,
        projectId: routine.projectId,
        areaId: routine.areaId,
        runKey: key,
        localDate: localDateKey(routine.timezone, scheduled),
        scheduledFor: routine.nextRunAt,
        status: 'skipped',
        completedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    await ctx.db.patch(routine._id, {
      nextRunAt: requireNextRoutineRunAt(routine, routine.nextRunAt + 60_000),
      updatedAt: ts,
    });
    return { ok: true };
  },
});

export const listForProject = query({
  args: { ...callerArgs, projectId: v.id('albatrossProjects') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireProject(ctx, args.projectId, userId);
    const routines = await ctx.db
      .query('albatrossRoutines')
      .withIndex('by_project', (q) => q.eq('projectId', args.projectId))
      .collect();
    return Promise.all(
      routines
        .filter((routine) => routine.userId === userId && routine.status !== 'archived')
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .map(async (routine) => ({
          ...routine,
          runs: await ctx.db
            .query('albatrossRoutineRuns')
            .withIndex('by_routine', (q) => q.eq('routineId', routine._id))
            .order('desc')
            .take(14),
          questions: await ctx.db
            .query('albatrossWorkQuestions')
            .withIndex('by_routine', (q) => q.eq('routineId', routine._id))
            .order('desc')
            .take(10),
        })),
    );
  },
});

export const areaPulse = query({
  args: { ...callerArgs, areaId: v.id('areas') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await ctx.db.get(args.areaId);
    if (!area || area.userId !== userId || area.status !== 'active') throw new Error('Area not found.');
    const projects = (
      await ctx.db
        .query('albatrossProjects')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', String(args.areaId)))
        .collect()
    )
      .filter((project) => project.status === 'active' || project.status === 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);
    const rows = await Promise.all(
      projects.map(async (project) => {
        const routines = (
          await ctx.db
            .query('albatrossRoutines')
            .withIndex('by_project', (q) => q.eq('projectId', project._id))
            .collect()
        ).filter((routine) => routine.userId === userId && routine.status !== 'archived');
        const questions = await ctx.db
          .query('albatrossWorkQuestions')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .order('desc')
          .take(20);
        const links = await ctx.db
          .query('albatrossProjectLinks')
          .withIndex('by_user_project', (q) => q.eq('userId', userId).eq('projectId', project._id))
          .collect();
        const taskLinks = links.filter((link) => link.artifactKind === 'task').slice(0, 100);
        const tasks = (
          await Promise.all(
            taskLinks.map(async (link) => {
              const cardId = ctx.db.normalizeId('cards', link.artifactId);
              const card = cardId ? await ctx.db.get(cardId) : null;
              return card?.userId === userId ? card : null;
            }),
          )
        ).filter((task): task is Doc<'cards'> => task !== null);
        return {
          project,
          routines,
          pendingQuestions: questions.filter((question) => question.status === 'pending'),
          taskCount: tasks.length,
          completedTaskCount: tasks.filter((task) => task.completedAt).length,
          todayTasks: tasks.filter(
            (task) => !task.completedAt && task.dueAt && task.dueAt <= now() + 86_400_000,
          ),
        };
      }),
    );
    return { areaId: args.areaId, projects: rows };
  },
});

async function materialize(ctx: MutationCtx, routine: Doc<'albatrossRoutines'>, force = false) {
  if (routine.status !== 'active' || routine.consent !== 'enabled') return { skipped: 'inactive' };
  const scheduledFor = force ? now() : routine.nextRunAt;
  if (!force && scheduledFor > now()) return { skipped: 'not_due' };
  const scheduledDate = new Date(scheduledFor);
  const localDate = localDateKey(routine.timezone, scheduledDate);
  const runKey = routineRunKey(String(routine._id), routine.timezone, scheduledDate);
  const existing = await ctx.db
    .query('albatrossRoutineRuns')
    .withIndex('by_routine_runKey', (q) => q.eq('routineId', routine._id).eq('runKey', runKey))
    .unique();
  if (existing) {
    await ctx.db.patch(routine._id, {
      nextRunAt: requireNextRoutineRunAt(routine, Math.max(now(), routine.nextRunAt) + 60_000),
      updatedAt: now(),
    });
    return { runId: existing._id, duplicate: true };
  }
  const project = await ctx.db.get(routine.projectId);
  if (!project || project.userId !== routine.userId || project.status === 'archived') {
    await ctx.db.patch(routine._id, { status: 'paused', updatedAt: now() });
    return { skipped: 'project' };
  }
  const ts = now();
  const runId = await ctx.db.insert('albatrossRoutineRuns', {
    userId: routine.userId,
    routineId: routine._id,
    projectId: routine.projectId,
    areaId: routine.areaId,
    runKey,
    localDate,
    scheduledFor,
    status: 'running',
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  });
  try {
    let taskCardId: Id<'cards'> | undefined;
    let questionId: Id<'albatrossWorkQuestions'> | undefined;
    let notificationId: Id<'albatrossNotifications'> | undefined;
    if (routine.taskTemplate) {
      let area = routine.areaId ? await ctx.db.get(routine.areaId) : null;
      if (!area && project.areaId) {
        const areaId = ctx.db.normalizeId('areas', project.areaId);
        area = areaId ? await ctx.db.get(areaId) : null;
      }
      if (area?.userId === routine.userId && area.boardId) {
        const boardId = area.boardId;
        const columns = await ctx.db
          .query('boardColumns')
          .withIndex('by_board', (q) => q.eq('boardId', boardId))
          .collect();
        const column =
          columns.find((entry) => entry.name.toLowerCase() === 'today') ||
          columns.sort((a, b) => a.order - b.order)[0];
        if (column) {
          const siblings = await ctx.db
            .query('cards')
            .withIndex('by_column_order', (q) => q.eq('columnId', column._id))
            .collect();
          const order = Math.max(0, ...siblings.map((card) => card.order)) + 1_024;
          taskCardId = await ctx.db.insert('cards', {
            boardId,
            columnId: column._id,
            userId: routine.userId,
            title: templateText(routine.taskTemplate.title, project, localDate) || routine.title,
            description: templateText(routine.taskTemplate.description, project, localDate) || undefined,
            priority: routine.taskTemplate.priority,
            dueAt: scheduledFor,
            order,
            source: {
              kind: 'albatrossRoutine',
              routineId: String(routine._id),
              routineRunId: String(runId),
              projectId: String(project._id),
            },
            createdAt: ts,
            updatedAt: ts,
          });
          await ctx.db.insert('albatrossProjectLinks', {
            userId: routine.userId,
            projectId: project._id,
            artifactKind: 'task',
            artifactId: String(taskCardId),
            areaId: routine.areaId ? String(routine.areaId) : project.areaId,
            role: 'primary',
            title: templateText(routine.taskTemplate.title, project, localDate) || routine.title,
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }
    }
    if (routine.taskTemplate && !taskCardId) {
      throw new Error('Routine task could not be created because its Area task board is unavailable.');
    }
    if (routine.questionTemplate) {
      const dedupeKey = `routine-question:${String(routine._id)}:${localDate}`;
      const existingQuestion = await ctx.db
        .query('albatrossWorkQuestions')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', routine.userId).eq('dedupeKey', dedupeKey))
        .unique();
      questionId = existingQuestion?._id;
      if (!questionId) {
        questionId = await ctx.db.insert('albatrossWorkQuestions', {
          userId: routine.userId,
          projectId: project._id,
          routineId: routine._id,
          dedupeKey,
          kind: routine.kind === 'review' ? 'reflection' : 'checkin',
          responseKind: routine.questionTemplate.responseKind ?? 'text',
          prompt: templateText(routine.questionTemplate.prompt, project, localDate),
          reason: templateText(routine.questionTemplate.reason, project, localDate) || undefined,
          options: routine.questionTemplate.options,
          status: 'pending',
          sourceRefs: [
            { kind: 'routine', id: String(routine._id), label: routine.title },
            { kind: 'project', id: String(project._id), label: project.title },
          ],
          metadata: { localDate, runId: String(runId) },
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    if (!routine.notification.enabled && routine.questionTemplate) {
      const consentKey = `routine-notification-consent:${String(routine._id)}`;
      const existingConsent = await ctx.db
        .query('albatrossWorkQuestions')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', routine.userId).eq('dedupeKey', consentKey))
        .unique();
      if (!existingConsent) {
        await ctx.db.insert('albatrossWorkQuestions', {
          userId: routine.userId,
          projectId: project._id,
          routineId: routine._id,
          dedupeKey: consentKey,
          kind: 'consent',
          responseKind: 'boolean',
          prompt: `Would you like a notification at ${routine.localTime} when it is time for “${routine.questionTemplate.prompt}”?`,
          reason:
            'The routine follows its own schedule and can keep creating a private check-in without sending a notification.',
          options: [
            { id: 'enable', label: 'Yes, notify me' },
            { id: 'decline', label: 'Not now' },
          ],
          status: 'pending',
          sourceRefs: [
            { kind: 'routine', id: String(routine._id), label: routine.title },
            { kind: 'project', id: String(project._id), label: project.title },
          ],
          metadata: { action: 'routine_notification_consent' },
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    const notificationSuppressedByQuietHours = routineIsInQuietHours(routine, scheduledFor);
    if (routine.notification.enabled && !notificationSuppressedByQuietHours && (questionId || taskCardId)) {
      const dedupeKey = `routine-notification:${String(routine._id)}:${localDate}`;
      const existingNotification = await ctx.db
        .query('albatrossNotifications')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', routine.userId).eq('dedupeKey', dedupeKey))
        .unique();
      notificationId = existingNotification?._id;
      if (!notificationId) {
        notificationId = await ctx.db.insert('albatrossNotifications', {
          userId: routine.userId,
          type: questionId ? 'work_question' : 'brief_ready',
          title: routine.title,
          body:
            questionId && routine.questionTemplate
              ? routine.questionTemplate.prompt
              : templateText(routine.taskTemplate?.title, project, localDate) ||
                routine.purpose ||
                project.title,
          entityKind: 'project',
          entityId: String(project._id),
          deepLink: routine.areaId
            ? `/?area=${String(routine.areaId)}&project=${String(project._id)}`
            : `/?project=${String(project._id)}`,
          dedupeKey,
          status: 'delivered',
          scheduledFor,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('notificationDeliveries', {
          userId: routine.userId,
          notificationId,
          channel: 'in_app',
          status: 'sent',
          attemptCount: 1,
          scheduledFor,
          sentAt: ts,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    await insertEvidence(ctx, {
      userId: routine.userId,
      targetKind: 'project',
      targetId: String(project._id),
      sourceKind: taskCardId ? 'task' : 'manual',
      sourceId: `routine-run:${String(runId)}`,
      title: `${routine.title} materialized`,
      summary: taskCardId ? 'The agreed routine generated a task.' : 'The agreed routine opened a check-in.',
      occurredAt: scheduledFor,
      weight: 0.42,
      confidence: 1,
      trust: 'observed',
      dedupeKey: `routine-run:${String(runId)}`,
      searchText: `${routine.title} ${project.title} routine ${localDate}`,
      metadata: {
        routineId: String(routine._id),
        runId: String(runId),
        taskCardId: taskCardId && String(taskCardId),
        notificationSuppressedByQuietHours,
      },
    });
    await ctx.db.patch(runId, {
      status: 'completed',
      taskCardId,
      questionId,
      notificationId,
      completedAt: now(),
      updatedAt: now(),
    });
    await ctx.db.patch(routine._id, {
      lastRunAt: scheduledFor,
      nextRunAt: requireNextRoutineRunAt(routine, Math.max(now(), scheduledFor) + 60_000),
      updatedAt: now(),
    });
    return { runId, taskCardId, questionId, notificationId };
  } catch (error) {
    await ctx.db.patch(runId, {
      status: 'error',
      error: error instanceof Error ? error.message.slice(0, 500) : 'Routine run failed.',
      updatedAt: now(),
    });
    await ctx.db.patch(routine._id, {
      nextRunAt: requireNextRoutineRunAt(routine, Math.max(now(), routine.nextRunAt) + 60_000),
      updatedAt: now(),
    });
    // Convex mutations are atomic. Rethrowing rolls back the partial card,
    // question, link, and run together so the same runKey can retry safely.
    throw error;
  }
}

export const materializeOne = internalMutation({
  args: { routineId: v.id('albatrossRoutines'), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const routine = await ctx.db.get(args.routineId);
    return routine ? materialize(ctx, routine, args.force === true) : { skipped: 'missing' };
  },
});

export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query('albatrossRoutines')
      .withIndex('by_status_nextRunAt', (q) => q.eq('status', 'active').lte('nextRunAt', now()))
      .take(100);
    const results = [];
    for (const routine of due) results.push(await materialize(ctx, routine));
    return { due: due.length, results };
  },
});
