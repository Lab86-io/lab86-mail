import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalAction, internalQuery, mutation, query } from './_generated/server';
import { BRIEF_JOB_LEASE_MS, BRIEF_JOB_MAX_ATTEMPTS } from './briefJobState';
import { fanOutInternalPost, requireInternalSecret } from './lib';

const caller = { internalSecret: v.optional(v.string()), userId: v.string() };
const owned = { ...caller, id: v.id('briefJobs'), token: v.string() };

async function markAreaGenerating(ctx: MutationCtx, userId: string, areaId: Id<'areas'>) {
  const now = Date.now();
  const brief = await ctx.db
    .query('albatrossAreaBriefs')
    .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', areaId))
    .unique();
  if (brief) await ctx.db.patch(brief._id, { status: 'generating', error: undefined, updatedAt: now });
  else
    await ctx.db.insert('albatrossAreaBriefs', {
      userId,
      areaId,
      status: 'generating',
      lede: '',
      summary: '',
      sourceRefs: [],
      basedOnRevision: '',
      createdAt: now,
      updatedAt: now,
    });
}

// A daily edition with content (a fallback document or the older HTML) is a
// published edition. A retry keeps it ready and marks it `retrying`; only the
// empty placeholder written by enqueue shows as generating.
function hasEditionContent(doc: any) {
  return Boolean(doc?.document || (typeof doc?.html === 'string' && doc.html));
}

async function dailyReportRow(ctx: MutationCtx, userId: string, reportId: string | undefined) {
  if (!reportId) return null;
  return await ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q) =>
      q.eq('userId', userId).eq('kind', 'dailyReport').eq('key', reportId),
    )
    .unique();
}

// Ends the generation state of a job's artifact: the daily edition becomes
// ready (with whatever it holds), and an area brief leaves "generating".
async function publishJobArtifact(ctx: MutationCtx, job: any, now: number, error?: string) {
  if (job.kind === 'daily') {
    const report = await dailyReportRow(ctx, job.userId, job.reportId);
    if (report && (report.doc.status === 'partial' || report.doc.retrying || report.doc.progress)) {
      const { progress: _progress, retrying: _retrying, ...doc } = report.doc;
      const empty = !hasEditionContent(doc) && !doc.narrative;
      await ctx.db.patch(report._id, {
        doc: {
          ...doc,
          status: 'ready',
          ...(empty
            ? { narrative: 'This edition could not be written. Write a new edition to try again.' }
            : {}),
        },
        updatedAt: now,
      });
    }
  } else if (job.kind === 'area' && job.areaId) {
    const brief = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user_area', (q) => q.eq('userId', job.userId).eq('areaId', job.areaId))
      .unique();
    if (brief?.status === 'generating')
      await ctx.db.patch(
        brief._id,
        brief.lede
          ? { status: 'ready', updatedAt: now }
          : { status: 'error', error: error || 'The writer is unavailable.', updatedAt: now },
      );
  }
}

export const enqueue = mutation({
  args: {
    ...caller,
    kind: v.union(v.literal('daily'), v.literal('area'), v.literal('narrative')),
    edition: v.optional(v.union(v.literal('morning'), v.literal('manual'), v.literal('weekly'))),
    areaId: v.optional(v.id('areas')),
    timezone: v.optional(v.string()),
    force: v.optional(v.boolean()),
    reportId: v.optional(v.string()),
    // A weekend edition without the know, waiting, task, and tool sections.
    light: v.optional(v.boolean()),
    // The first edition after the first mailbox connects (FEATURES item 4).
    first: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.kind === 'area') {
      const area = args.areaId ? await ctx.db.get(args.areaId) : null;
      if (!area || area.userId !== args.userId) throw new Error('Area not found');
    }
    if (args.kind === 'daily' && (!args.reportId || !args.edition)) throw new Error('Edition required');
    const now = Date.now();
    // A slow earlier edition must not prevent tomorrow's cron from starting.
    // Each day's active edition is coalesced independently, without expiring it.
    // The weekly review has its own scope, so a manual edition on the same
    // Sunday neither joins nor cancels it.
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: args.timezone || 'UTC' }).format(now);
    const scope =
      args.kind === 'area'
        ? `area:${args.areaId}`
        : args.kind === 'daily'
          ? `${args.edition === 'weekly' ? 'weekly' : 'daily'}:${localDate}`
          : args.kind;
    const active = await ctx.db
      .query('briefJobs')
      .withIndex('by_user_scope_active', (q) =>
        q.eq('userId', args.userId).eq('scope', scope).eq('active', true),
      )
      .unique();
    if (args.kind === 'daily') {
      // A new day supersedes every earlier day's unfinished edition job.
      const earlier = await ctx.db
        .query('briefJobs')
        .withIndex('by_user_active', (q) => q.eq('userId', args.userId).eq('active', true))
        .collect();
      for (const job of earlier) {
        // Only an earlier day's job is replaced; the same day's other scope stays.
        if (job.kind !== 'daily' || job.scope === scope || job.scope.endsWith(`:${localDate}`)) continue;
        await ctx.db.patch(job._id, {
          state: 'cancelled',
          active: false,
          token: undefined,
          error: 'A newer day replaced this edition.',
          completedAt: now,
        });
        await publishJobArtifact(ctx, job, now);
      }
    }
    if (active) {
      if (args.kind === 'area' && args.force && !active.force) {
        await ctx.db.patch(active._id, { force: true });
        await markAreaGenerating(ctx, args.userId, args.areaId!);
      }
      return { jobId: active._id, reportId: active.reportId, started: false };
    }
    const id = await ctx.db.insert('briefJobs', {
      userId: args.userId,
      scope,
      kind: args.kind,
      edition: args.edition,
      areaId: args.areaId,
      timezone: args.timezone,
      force: args.force,
      reportId: args.reportId,
      ...(args.light ? { light: true } : {}),
      ...(args.first ? { first: true } : {}),
      state: 'queued',
      active: true,
      availableAt: now,
      createdAt: now,
      attempts: 0,
    });
    if (args.kind === 'daily') {
      // Persist the new edition atomically with its job. Readers immediately see
      // its generation state, never a substituted previous edition.
      await ctx.db.insert('userDocs', {
        userId: args.userId,
        kind: 'dailyReport',
        key: args.reportId!,
        createdAt: now,
        updatedAt: now,
        doc: {
          _id: args.reportId,
          kind: args.edition,
          ...(args.light ? { light: true } : {}),
          generatedAt: now,
          status: 'partial',
          progress: { stage: 'queued', done: 0, total: 1 },
          accounts: [],
          title: args.edition === 'weekly' ? 'Weekly Review' : 'Daily Brief',
          narrative: '',
          sections: {},
          stats: {},
        },
      });
    } else if (args.kind === 'area' && args.force) {
      await markAreaGenerating(ctx, args.userId, args.areaId!);
    }
    await ctx.scheduler.runAfter(0, (internal as any).briefJobs.deliver, { ids: [id] });
    return { jobId: id, reportId: args.reportId, started: true };
  },
});

export const claim = mutation({
  args: owned,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const job = await ctx.db.get(args.id);
    const now = Date.now();
    if (!job || job.userId !== args.userId || !job.active || job.availableAt > now) return null;
    if (job.kind === 'area') {
      const area = job.areaId ? await ctx.db.get(job.areaId) : null;
      if (!area || area.userId !== job.userId || area.status !== 'active') {
        await ctx.db.patch(job._id, {
          state: 'cancelled',
          active: false,
          token: undefined,
          error: 'Area no longer active',
          completedAt: now,
        });
        await publishJobArtifact(ctx, job, now, 'Area no longer active');
        return null;
      }
    }
    const patch = {
      state: 'running' as const,
      token: args.token,
      availableAt: now + BRIEF_JOB_LEASE_MS,
      attempts: job.attempts + 1,
      error: undefined,
    };
    await ctx.db.patch(job._id, patch);
    return { ...job, ...patch };
  },
});

export const heartbeat = mutation({
  args: owned,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const job = await ctx.db.get(args.id);
    if (!job || job.userId !== args.userId || job.state !== 'running' || job.token !== args.token)
      return false;
    await ctx.db.patch(job._id, { availableAt: Date.now() + BRIEF_JOB_LEASE_MS });
    return true;
  },
});

export const settle = mutation({
  args: {
    ...owned,
    error: v.optional(v.string()),
    force: v.optional(v.boolean()),
    // The writer cannot succeed on another attempt (no plan, key, or credits).
    terminal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const job = await ctx.db.get(args.id);
    if (!job || job.userId !== args.userId || job.state !== 'running' || job.token !== args.token)
      return false;
    const now = Date.now();
    // An explicit refresh arriving during an unchanged-revision check must
    // still get a newly written area edition after that check finishes.
    if (job.kind === 'area' && job.force && args.force === false && !args.error) {
      await ctx.db.patch(job._id, { state: 'queued', token: undefined, availableAt: now });
      await markAreaGenerating(ctx, job.userId, job.areaId!);
      await ctx.scheduler.runAfter(0, (internal as any).briefJobs.deliver, { ids: [job._id] });
      return true;
    }
    const final = !args.error || args.terminal === true || job.attempts >= BRIEF_JOB_MAX_ATTEMPTS;
    if (final) {
      // Completed, with the fallback edition published when the writer failed.
      await ctx.db.patch(job._id, {
        state: 'completed',
        active: false,
        token: undefined,
        completedAt: now,
        ...(args.error ? { error: args.error.slice(0, 300) } : {}),
      });
      await publishJobArtifact(ctx, job, now, args.error);
      return true;
    }
    const retryAt = now + Math.min(300_000, 5_000 * 2 ** Math.min(job.attempts, 6));
    await ctx.db.patch(job._id, {
      state: 'queued',
      token: undefined,
      availableAt: retryAt,
      error: args.error!.slice(0, 300),
    });
    if (job.kind === 'daily') {
      const report = await dailyReportRow(ctx, job.userId, job.reportId);
      if (
        report &&
        !(
          report.doc.status === 'ready' &&
          report.doc.artifactStatus === 'ready' &&
          report.doc.editorial?.mode === 'generated'
        )
      ) {
        const { progress: _progress, ...doc } = report.doc;
        await ctx.db.patch(report._id, {
          doc: hasEditionContent(doc)
            ? // The published fallback stays readable while the writer retries.
              { ...doc, status: 'ready', retrying: true }
            : { ...doc, status: 'partial', progress: { stage: 'Retrying the writer', done: 0, total: 1 } },
          updatedAt: now,
        });
      }
    } else if (job.kind === 'area' && job.force) {
      // Only an explicit refresh shows "generating" while it retries; a
      // scheduled refresh keeps the current area brief readable.
      const brief = await ctx.db
        .query('albatrossAreaBriefs')
        .withIndex('by_user_area', (q) => q.eq('userId', job.userId).eq('areaId', job.areaId!))
        .unique();
      if (brief) await ctx.db.patch(brief._id, { status: 'generating', error: undefined, updatedAt: now });
    }
    await ctx.scheduler.runAt(retryAt, (internal as any).briefJobs.deliver, { ids: [job._id] });
    return true;
  },
});

export const get = query({
  args: { ...caller, id: v.id('briefJobs') },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const job = await ctx.db.get(args.id);
    return job?.userId === args.userId ? job : null;
  },
});

export const due = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query('briefJobs')
      .withIndex('by_active_available', (q) => q.eq('active', true).lte('availableAt', Date.now()))
      .take(100),
});
export const targets = internalQuery({
  args: { ids: v.array(v.id('briefJobs')) },
  handler: async (ctx, args) =>
    (await Promise.all(args.ids.map((id) => ctx.db.get(id))))
      .filter((job) => job?.active && job.availableAt <= Date.now())
      .map((job) => ({ id: job!._id, userId: job!.userId })),
});
export const deliver = internalAction({
  args: { ids: v.array(v.id('briefJobs')) },
  handler: async (ctx, args) => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL?.replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret) return;
    const targets = await ctx.runQuery((internal as any).briefJobs.targets, args);
    // This short request only acknowledges a durable job; it never waits for AI.
    await fanOutInternalPost(`${url}/api/cron/brief-job`, secret, targets, { label: 'brief jobs' });
  },
});
export const recover = internalAction({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.runQuery((internal as any).briefJobs.due, {});
    if (jobs.length)
      await ctx.runAction((internal as any).briefJobs.deliver, { ids: jobs.map((job: any) => job._id) });
  },
});
