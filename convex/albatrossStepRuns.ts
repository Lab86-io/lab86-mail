import { v } from 'convex/values';
import { conductorMayMove } from '../lib/albatross/conductor-quiet';
import { shapePlans } from '../lib/albatross/shape-policy';
import { isTerminalWork } from '../lib/albatross/work-lifecycle';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

// Step runs. The agent works one plan step as far as it can and stops with
// one next action for the user: approve a draft, sign in on a page, answer a
// question, or do an offline step. One row is both the job (a renewable lease
// and an attempt count, as for brief jobs) and the handoff record that the
// web, iOS, and macOS clients read.
//
// The run itself executes in the app (lib/albatross/step-runner.ts), because
// it needs the tool registry, the model gateway, and the shared browser.
// Convex owns the queue: enqueue, claim with a token, heartbeat, settle.

/** A renewable ownership lease, never a run deadline (the run meter owns that). */
export const STEP_RUN_LEASE_MS = 120_000;
/** A lost lease (a deploy, a crash) gets one more attempt; then the run fails. */
export const STEP_RUN_MAX_ATTEMPTS = 2;
const LOG_MAX = 30;
const ARTIFACT_MAX = 20;
/** Runs a user may have open at once. Automatic triggers stop earlier. */
const USER_ACTIVE_MAX = 3;
const AUTO_ACTIVE_MAX = 1;
/** A handoff older than this leaves the Brief list; the Work page keeps it. */
export const HANDOFF_VISIBLE_MS = 14 * 24 * 60 * 60_000;

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

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

const triggerValidator = v.union(
  v.literal('user'),
  v.literal('brief'),
  v.literal('conductor'),
  v.literal('resume'),
);

const outcomeValidator = v.union(
  v.literal('done'),
  v.literal('ready_for_you'),
  v.literal('your_turn'),
  v.literal('needs_answer'),
  v.literal('stopped'),
);

const nextValidator = v.object({
  kind: v.union(
    v.literal('review_draft'),
    v.literal('review_document'),
    v.literal('approve'),
    v.literal('sign_in'),
    v.literal('finish_on_page'),
    v.literal('answer'),
    v.literal('do_offline'),
    v.literal('review'),
    v.literal('continue'),
  ),
  label: v.string(),
  detail: v.string(),
  target: v.optional(
    v.object({
      kind: v.union(
        v.literal('draft'),
        v.literal('document'),
        v.literal('approval'),
        v.literal('session'),
        v.literal('question'),
        v.literal('url'),
        v.literal('card'),
        v.literal('event'),
      ),
      id: v.optional(v.string()),
      url: v.optional(v.string()),
      accountId: v.optional(v.string()),
    }),
  ),
});

const artifactValidator = v.object({
  kind: v.union(
    v.literal('document'),
    v.literal('draft'),
    v.literal('event'),
    v.literal('card'),
    v.literal('approval'),
    v.literal('page'),
  ),
  id: v.optional(v.string()),
  title: v.string(),
  url: v.optional(v.string()),
  accountId: v.optional(v.string()),
});

const budgetValidator = v.object({
  timeMs: v.number(),
  costUsd: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  calls: v.number(),
  exhausted: v.optional(v.union(v.literal('time'), v.literal('cost'))),
});

type RunDoc = Doc<'albatrossStepRuns'>;

/**
 * What every client reads. The lease token, the attempt count, and the cost
 * stay on the server; the client gets the state, the log, and the handoff.
 */
export function stepRunView(run: RunDoc) {
  return {
    id: String(run._id),
    workId: run.workId,
    stepKey: run.stepKey,
    stepIdentity: run.stepIdentity,
    stepTitle: run.stepTitle,
    state: run.state,
    trigger: run.trigger,
    outcome: run.outcome ?? null,
    summary: run.summary ?? null,
    log: run.log,
    next: run.next
      ? {
          kind: run.next.kind,
          label: run.next.label,
          detail: run.next.detail,
          target: run.next.target ?? null,
        }
      : null,
    artifacts: run.artifacts,
    browserSessionId: run.browserSessionId ?? null,
    stoppedBy: run.budget?.exhausted ?? null,
    error: run.error ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
  };
}
export type StepRunView = ReturnType<typeof stepRunView>;

/** The newest run of each step, newest first. */
export function latestRunPerStep(rows: readonly RunDoc[]): RunDoc[] {
  const seen = new Set<string>();
  const latest: RunDoc[] = [];
  for (const row of [...rows].sort((a, b) => b.createdAt - a.createdAt)) {
    if (seen.has(row.stepKey)) continue;
    seen.add(row.stepKey);
    latest.push(row);
  }
  return latest;
}

async function workRow(ctx: QueryCtx | MutationCtx, userId: string, workId: string) {
  const id = ctx.db.normalizeId('albatrossIntents', workId);
  const work = id ? await ctx.db.get(id) : null;
  return work && work.userId === userId ? work : null;
}

async function activeRuns(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('albatrossStepRuns')
    .withIndex('by_user_active', (q) => q.eq('userId', userId).eq('active', true))
    .take(20);
}

/**
 * Queue one run. One open run per Work. An automatic trigger (the Brief or the
 * conductor) runs a step at most once: after any earlier run of the same step,
 * only the user starts it again.
 */
export const enqueue = mutation({
  args: {
    ...callerArgs,
    workId: v.string(),
    stepKey: v.string(),
    stepIdentity: v.string(),
    stepTitle: v.string(),
    trigger: triggerValidator,
    parentRunId: v.optional(v.id('albatrossStepRuns')),
    resumeNote: v.optional(v.string()),
    browserSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Only the server queues runs: the app route checks the switches, the
    // standing order, and the step mode before it calls this.
    if (!args.internalSecret) throw new Error('Only the server queues a step run.');
    const userId = await resolveUserId(ctx, args);
    const work = await workRow(ctx, userId, args.workId);
    if (!work) throw new Error('Work not found.');
    if (isTerminalWork(work)) return { runId: null, created: false, reason: 'closed' as const };
    const open = await activeRuns(ctx, userId);
    const sameWork = open.find((row) => row.workId === args.workId);
    if (sameWork) return { runId: String(sameWork._id), created: false, reason: 'active' as const };
    const automatic = args.trigger === 'brief' || args.trigger === 'conductor';
    if (open.length >= (automatic ? AUTO_ACTIVE_MAX : USER_ACTIVE_MAX))
      return { runId: null, created: false, reason: 'busy' as const };
    if (automatic) {
      const earlier = await ctx.db
        .query('albatrossStepRuns')
        .withIndex('by_user_step', (q) =>
          q.eq('userId', userId).eq('workId', args.workId).eq('stepIdentity', args.stepIdentity),
        )
        .first();
      if (earlier) return { runId: String(earlier._id), created: false, reason: 'already_ran' as const };
    }
    if (args.parentRunId) {
      const parent = await ctx.db.get(args.parentRunId);
      if (!parent || parent.userId !== userId || parent.workId !== args.workId)
        throw new Error('Run not found.');
    }
    const ts = now();
    const runId = await ctx.db.insert('albatrossStepRuns', {
      userId,
      workId: args.workId,
      stepKey: truncateText(args.stepKey, 300),
      stepIdentity: truncateText(args.stepIdentity, 500),
      stepTitle: truncateText(args.stepTitle, 200),
      trigger: args.trigger,
      state: 'queued',
      active: true,
      availableAt: ts,
      attempts: 0,
      ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
      ...(args.resumeNote?.trim() ? { resumeNote: truncateText(args.resumeNote.trim(), 2_000) } : {}),
      ...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}),
      log: [],
      artifacts: [],
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.scheduler.runAfter(0, internal.albatrossStepRuns.deliver, { ids: [runId] });
    return { runId: String(runId), created: true, reason: null };
  },
});

const fenceArgs = {
  internalSecret: v.string(),
  userId: v.string(),
  id: v.id('albatrossStepRuns'),
  token: v.string(),
};

async function ownedRun(
  ctx: MutationCtx,
  args: { internalSecret: string; userId: string; id: Id<'albatrossStepRuns'>; token: string },
) {
  requireInternalSecret(args.internalSecret);
  const run = await ctx.db.get(args.id);
  if (!run || run.userId !== args.userId || run.state !== 'running' || run.token !== args.token) return null;
  return run;
}

export const claim = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const run = await ctx.db.get(args.id);
    const ts = now();
    if (!run || run.userId !== args.userId || !run.active || run.availableAt > ts) return null;
    const work = await workRow(ctx, run.userId, run.workId);
    if (!work || isTerminalWork(work)) {
      await ctx.db.patch(run._id, {
        state: 'cancelled',
        active: false,
        token: undefined,
        error: 'The Albatross is closed.',
        finishedAt: ts,
        updatedAt: ts,
      });
      return null;
    }
    const patch = {
      state: 'running' as const,
      token: args.token,
      availableAt: ts + STEP_RUN_LEASE_MS,
      attempts: run.attempts + 1,
      startedAt: run.startedAt ?? ts,
      updatedAt: ts,
    };
    await ctx.db.patch(run._id, patch);
    return { ...run, ...patch, _id: String(run._id) };
  },
});

/** Renews the lease. False means the run was stopped or lost: the runner must stop at once. */
export const heartbeat = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    const run = await ownedRun(ctx, args);
    if (!run) return false;
    await ctx.db.patch(run._id, { availableAt: now() + STEP_RUN_LEASE_MS });
    return true;
  },
});

/** One line of the live log, and optionally one artifact or the shared browser. */
export const progress = mutation({
  args: {
    ...fenceArgs,
    line: v.optional(v.string()),
    artifact: v.optional(artifactValidator),
    browserSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ownedRun(ctx, args);
    if (!run) return false;
    const ts = now();
    const log = args.line?.trim()
      ? [...run.log, { at: ts, text: truncateText(args.line.trim(), 200) }].slice(-LOG_MAX)
      : run.log;
    let artifacts = run.artifacts;
    if (args.artifact) {
      const entry = {
        ...args.artifact,
        title: truncateText(args.artifact.title, 200),
        ...(args.artifact.url ? { url: truncateText(args.artifact.url, 2_000) } : {}),
      };
      artifacts = [
        ...artifacts.filter((row) => !(row.kind === entry.kind && entry.id && row.id === entry.id)),
        entry,
      ].slice(-ARTIFACT_MAX);
    }
    await ctx.db.patch(run._id, {
      log,
      artifacts,
      ...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}),
      availableAt: ts + STEP_RUN_LEASE_MS,
      updatedAt: ts,
    });
    return true;
  },
});

/**
 * End one attempt. A retryable error queues the run again until it has used
 * its attempts; anything else is final. A final run keeps its handoff.
 */
export const settle = mutation({
  args: {
    ...fenceArgs,
    outcome: v.optional(outcomeValidator),
    summary: v.optional(v.string()),
    next: v.optional(nextValidator),
    budget: v.optional(budgetValidator),
    error: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const run = await ownedRun(ctx, args);
    if (!run) return { state: null };
    const ts = now();
    if (args.error && args.retryable && run.attempts < STEP_RUN_MAX_ATTEMPTS) {
      const retryAt = ts + 15_000 * run.attempts;
      await ctx.db.patch(run._id, {
        state: 'queued',
        token: undefined,
        availableAt: retryAt,
        error: truncateText(args.error, 300),
        ...(args.budget ? { budget: args.budget } : {}),
        updatedAt: ts,
      });
      await ctx.scheduler.runAt(retryAt, internal.albatrossStepRuns.deliver, { ids: [run._id] });
      return { state: 'queued' as const };
    }
    const state = args.error && !args.outcome ? 'failed' : args.outcome === 'done' ? 'done' : 'handed_off';
    await ctx.db.patch(run._id, {
      state,
      active: false,
      token: undefined,
      ...(args.outcome ? { outcome: args.outcome } : {}),
      ...(args.summary?.trim() ? { summary: truncateText(args.summary.trim(), 800) } : {}),
      ...(args.next
        ? {
            next: {
              kind: args.next.kind,
              label: truncateText(args.next.label, 48),
              detail: truncateText(args.next.detail, 500),
              ...(args.next.target
                ? {
                    target: {
                      kind: args.next.target.kind,
                      ...(args.next.target.id ? { id: truncateText(args.next.target.id, 300) } : {}),
                      ...(args.next.target.url ? { url: truncateText(args.next.target.url, 2_000) } : {}),
                      ...(args.next.target.accountId
                        ? { accountId: truncateText(args.next.target.accountId, 300) }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(args.budget ? { budget: args.budget } : {}),
      ...(args.error ? { error: truncateText(args.error, 300) } : { error: undefined }),
      finishedAt: ts,
      updatedAt: ts,
    });
    return { state };
  },
});

/** The user stops a run, or takes over the page. The runner sees it at its next heartbeat. */
export const cancel = mutation({
  args: { ...callerArgs, id: v.id('albatrossStepRuns') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const run = await ctx.db.get(args.id);
    if (!run || run.userId !== userId) throw new Error('Run not found.');
    if (!run.active) return { cancelled: false, browserSessionId: run.browserSessionId ?? null };
    const ts = now();
    await ctx.db.patch(run._id, {
      state: 'cancelled',
      active: false,
      token: undefined,
      finishedAt: ts,
      updatedAt: ts,
    });
    return { cancelled: true, browserSessionId: run.browserSessionId ?? null };
  },
});

/**
 * Close the handoff of a step the user finished another way (the step was
 * checked, or the user dismissed the handoff). The record stays for history.
 */
export const dismissHandoff = mutation({
  args: { ...callerArgs, id: v.id('albatrossStepRuns') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const run = await ctx.db.get(args.id);
    if (!run || run.userId !== userId) throw new Error('Run not found.');
    if (run.state !== 'handed_off') return { dismissed: false };
    await ctx.db.patch(run._id, { state: 'closed', updatedAt: now() });
    return { dismissed: true };
  },
});

/**
 * Close the open handoffs of one step. completeStep calls this, so a step the
 * user checked never leaves a "Ready for you" row behind.
 */
export async function closeHandoffsForStep(
  ctx: MutationCtx,
  userId: string,
  workId: string,
  stepIdentity: string,
) {
  const rows = await ctx.db
    .query('albatrossStepRuns')
    .withIndex('by_user_step', (q) =>
      q.eq('userId', userId).eq('workId', workId).eq('stepIdentity', stepIdentity),
    )
    .take(20);
  const ts = now();
  for (const row of rows)
    if (row.state === 'handed_off') await ctx.db.patch(row._id, { state: 'closed', updatedAt: ts });
}

/** The Work page's subscription: the newest run of each step. */
export const runsForWork = query({
  args: { ...callerArgs, workId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossStepRuns')
      .withIndex('by_user', (q) => q.eq('userId', userId).eq('workId', args.workId))
      .order('desc')
      .take(40);
    return latestRunPerStep(rows).map(stepRunView);
  },
});

/** One run, for the runner and the resume route. */
export const get = query({
  args: { ...callerArgs, id: v.id('albatrossStepRuns') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const run = await ctx.db.get(args.id);
    if (!run || run.userId !== userId) return null;
    return {
      ...stepRunView(run),
      attempts: run.attempts,
      resumeNote: run.resumeNote ?? null,
      parentRunId: run.parentRunId ? String(run.parentRunId) : null,
      budget: run.budget ?? null,
    };
  },
});

/**
 * The Brief's "Ready for you" list: open handoffs and runs at work, newest
 * first, one per Work. A handoff leaves the list when its step is done, when
 * a newer run replaces it, or after two weeks.
 */
export const openHandoffs = query({
  args: { ...callerArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 20);
    const since = now() - HANDOFF_VISIBLE_MS;
    const working = await activeRuns(ctx, userId);
    const recent = await ctx.db
      .query('albatrossStepRuns')
      .withIndex('by_user_active', (q) => q.eq('userId', userId).eq('active', false))
      .order('desc')
      .take(60);
    const byWork = new Map<string, RunDoc>();
    for (const row of [...working, ...recent].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (byWork.has(row.workId)) continue;
      byWork.set(row.workId, row);
    }
    const rows = [...byWork.values()].filter(
      (row) => row.active || (row.state === 'handed_off' && row.updatedAt >= since),
    );
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const work = await workRow(ctx, userId, row.workId);
      if (!work || isTerminalWork(work)) continue;
      items.push({ workId: row.workId, workTitle: work.title || work.rawText, run: stepRunView(row) });
    }
    return items;
  },
});

/**
 * Work the conductor may start a run on: open, planned, touched recently or
 * woken, and with no open run. The app reads each candidate's current step
 * and decides; this query only bounds the set. The check time rotates the
 * set so every Work gets its turn.
 */
export const autoCandidates = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ts = now();
    const limit = Math.min(Math.max(args.limit ?? 6, 1), 20);
    // Least recently checked first, so a checked Work moves to the back and
    // every Work gets its turn. The window is wide enough that Work the filter
    // refuses (no plan, open questions, untouched) does not hide the rest.
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_work_state_step_check', (q) => q.eq('workState', 'active'))
      .take(500);
    const open = rows
      .filter((row) => {
        if ((row.workState || 'active') !== 'active') return false;
        if (!row.latestPlanId || row.planError || row.status === 'planning') return false;
        if ((row.questions || []).some((question) => !question.answer)) return false;
        if (shapePlans(row.shape) === 'no') return false;
        if (['researching', 'applying'].includes(row.agentState || '')) return false;
        if (row.lastStepRunCheckAt && row.lastStepRunCheckAt > ts - 60 * 60_000) return false;
        return conductorMayMove(row, 'conductor', ts);
      })
      .sort((a, b) => (a.lastStepRunCheckAt ?? 0) - (b.lastStepRunCheckAt ?? 0));
    const picked: Array<{ userId: string; workId: string }> = [];
    for (const row of open) {
      if (picked.length >= limit) break;
      const running = await ctx.db
        .query('albatrossStepRuns')
        .withIndex('by_user_active', (q) => q.eq('userId', row.userId).eq('active', true))
        .take(5);
      if (running.length >= AUTO_ACTIVE_MAX) continue;
      picked.push({ userId: row.userId, workId: String(row._id) });
    }
    return picked;
  },
});

export const markAutoChecked = internalMutation({
  args: { workIds: v.array(v.id('albatrossIntents')) },
  handler: async (ctx, args) => {
    const ts = now();
    for (const workId of args.workIds.slice(0, 20)) {
      const work = await ctx.db.get(workId);
      if (work) await ctx.db.patch(workId, { lastStepRunCheckAt: ts });
    }
  },
});

/** The conductor's step-run tick: post the candidates to the app, which checks each step. */
export const autoTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) return;
    const candidates = await ctx.runQuery(internal.albatrossStepRuns.autoCandidates, {});
    if (!candidates.length) return;
    await ctx.runMutation(internal.albatrossStepRuns.markAutoChecked, {
      workIds: candidates.map((row) => row.workId as Id<'albatrossIntents'>),
    });
    await fanOutInternalPost(`${appUrl}/api/cron/step-runs`, secret, [{ candidates }], {
      label: 'step-run candidates',
      timeoutMs: 60_000,
      concurrency: 1,
    });
  },
});

export const due = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query('albatrossStepRuns')
      .withIndex('by_active_available', (q) => q.eq('active', true).lte('availableAt', now()))
      .take(50),
});

export const targets = internalQuery({
  args: { ids: v.array(v.id('albatrossStepRuns')) },
  handler: async (ctx, args) =>
    (await Promise.all(args.ids.map((id) => ctx.db.get(id))))
      .filter((run) => run?.active && run.availableAt <= now())
      .map((run) => ({ id: String(run!._id), userId: run!.userId })),
});

/**
 * Lost leases: a run whose app process died (a deploy restarts the server)
 * stops renewing its lease. Recovery queues it again while it has attempts,
 * and fails it after that, so no run stays "working" forever.
 */
export const expireLost = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const lost = await ctx.db
      .query('albatrossStepRuns')
      .withIndex('by_active_available', (q) => q.eq('active', true).lte('availableAt', ts))
      .take(50);
    for (const run of lost) {
      if (run.state !== 'running') continue;
      if (run.attempts >= STEP_RUN_MAX_ATTEMPTS) {
        await ctx.db.patch(run._id, {
          state: 'failed',
          active: false,
          token: undefined,
          error: 'The run stopped before it finished. Start it again.',
          finishedAt: ts,
          updatedAt: ts,
        });
      } else {
        await ctx.db.patch(run._id, { state: 'queued', token: undefined, updatedAt: ts });
      }
    }
  },
});

export const deliver = internalAction({
  args: { ids: v.array(v.id('albatrossStepRuns')) },
  handler: async (ctx, args) => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL?.replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret) return;
    const runs = await ctx.runQuery(internal.albatrossStepRuns.targets, args);
    // This short request only acknowledges a durable run; it never waits for the agent.
    if (runs.length)
      await fanOutInternalPost(`${url}/api/cron/step-run`, secret, runs, { label: 'step runs' });
  },
});

export const recover = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.albatrossStepRuns.expireLost, {});
    const runs = await ctx.runQuery(internal.albatrossStepRuns.due, {});
    if (runs.length)
      await ctx.runAction(internal.albatrossStepRuns.deliver, { ids: runs.map((run) => run._id) });
  },
});

// ---------------------------------------------------------------------------
// Saved sign-ins: one Browserbase context per user.
// ---------------------------------------------------------------------------

/** A shared browser lives one hour; the writer lease never outlives it. */
export const CONTEXT_WRITER_LEASE_MS = 70 * 60_000;

async function contextRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('albatrossBrowserContexts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first();
}

export const browserContext = query({
  args: callerArgs,
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const row = await contextRow(ctx, userId);
    return row ? { contextId: row.contextId, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } : null;
  },
});

export const saveBrowserContext = mutation({
  args: { ...callerArgs, contextId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    if (!args.internalSecret) throw new Error('Only the server saves a sign-in context.');
    const ts = now();
    const row = await contextRow(ctx, userId);
    if (row) {
      await ctx.db.patch(row._id, { lastUsedAt: ts });
      // Two first sessions can create two contexts at once. The first saved
      // one stays; the other is recorded for deletion, so no cookies of the
      // user stay at Browserbase without a record.
      if (row.contextId !== args.contextId) await recordContextDeletion(ctx, args.contextId);
      return { contextId: row.contextId, created: false };
    }
    await ctx.db.insert('albatrossBrowserContexts', {
      userId,
      contextId: args.contextId,
      createdAt: ts,
      lastUsedAt: ts,
    });
    return { contextId: args.contextId, created: true };
  },
});

async function recordContextDeletion(ctx: MutationCtx, contextId: string) {
  const pending = await ctx.db
    .query('albatrossContextDeletions')
    .withIndex('by_context', (q) => q.eq('contextId', contextId))
    .first();
  if (!pending)
    await ctx.db.insert('albatrossContextDeletions', { contextId, requestedAt: now(), attempts: 0 });
}

/**
 * Claim the one writer place of the user's context. Atomic: of two sessions
 * that start at the same time, one gets persist and the other only reads.
 */
export const claimContextWriter = mutation({
  args: { ...callerArgs, token: v.string() },
  handler: async (ctx, args) => {
    if (!args.internalSecret) throw new Error('Only the server claims a sign-in context.');
    const userId = await resolveUserId(ctx, args);
    const row = await contextRow(ctx, userId);
    if (!row) return null;
    const ts = now();
    const free = !row.writerToken || (row.writerUntil ?? 0) <= ts;
    if (!free) return { contextId: row.contextId, persist: false };
    await ctx.db.patch(row._id, {
      writerToken: args.token,
      writerSessionId: undefined,
      writerUntil: ts + CONTEXT_WRITER_LEASE_MS,
      lastUsedAt: ts,
    });
    return { contextId: row.contextId, persist: true };
  },
});

/** Tie the claimed writer place to the session that got it. */
export const bindContextWriter = mutation({
  args: { ...callerArgs, token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    if (!args.internalSecret) throw new Error('Only the server binds a sign-in context.');
    const userId = await resolveUserId(ctx, args);
    const row = await contextRow(ctx, userId);
    if (!row || row.writerToken !== args.token) return false;
    await ctx.db.patch(row._id, { writerSessionId: args.sessionId });
    return true;
  },
});

/** Give the writer place back (the session did not start). */
export const releaseContextWriter = mutation({
  args: { ...callerArgs, token: v.string() },
  handler: async (ctx, args) => {
    if (!args.internalSecret) throw new Error('Only the server releases a sign-in context.');
    const userId = await resolveUserId(ctx, args);
    const row = await contextRow(ctx, userId);
    if (!row || row.writerToken !== args.token) return false;
    await ctx.db.patch(row._id, {
      writerToken: undefined,
      writerSessionId: undefined,
      writerUntil: undefined,
    });
    return true;
  },
});

/** A session ended: its writer place is free. Called where session rows end. */
export async function releaseContextWriterForSession(ctx: MutationCtx, userId: string, sessionId: string) {
  const row = await contextRow(ctx, userId);
  if (row?.writerSessionId === sessionId)
    await ctx.db.patch(row._id, {
      writerToken: undefined,
      writerSessionId: undefined,
      writerUntil: undefined,
    });
}

/**
 * Forget the saved sign-ins. The context rows go at once, so no new session
 * uses them; a deletion record (without a userId, so it outlives the account
 * cascade) keeps each id until Browserbase confirms the delete.
 */
export const forgetBrowserContext = mutation({
  args: callerArgs,
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossBrowserContexts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(5);
    for (const row of rows) {
      await recordContextDeletion(ctx, row.contextId);
      await ctx.db.delete(row._id);
    }
    return { contextIds: rows.map((row) => row.contextId) };
  },
});

/** Browserbase confirmed the delete (or the context was already gone). */
export const completeContextDeletion = mutation({
  args: { internalSecret: v.string(), contextId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('albatrossContextDeletions')
      .withIndex('by_context', (q) => q.eq('contextId', args.contextId))
      .take(5);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const failContextDeletion = mutation({
  args: { internalSecret: v.string(), contextId: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('albatrossContextDeletions')
      .withIndex('by_context', (q) => q.eq('contextId', args.contextId))
      .first();
    if (row)
      await ctx.db.patch(row._id, { attempts: row.attempts + 1, lastError: truncateText(args.error, 300) });
  },
});

export const pendingContextDeletions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('albatrossContextDeletions').withIndex('by_requested').take(50);
    return rows.map((row) => row.contextId);
  },
});

/** Hourly: retry the Browserbase deletes that did not finish. */
export const contextDeletionTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) return;
    const contextIds = await ctx.runQuery(internal.albatrossStepRuns.pendingContextDeletions, {});
    if (!contextIds.length) return;
    await fanOutInternalPost(`${appUrl}/api/cron/browser-contexts`, secret, [{ contextIds }], {
      label: 'saved sign-in deletions',
      timeoutMs: 60_000,
      concurrency: 1,
    });
  },
});
