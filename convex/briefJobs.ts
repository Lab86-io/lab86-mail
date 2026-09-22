import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalQuery, mutation, query } from './_generated/server';
import { BRIEF_JOB_LEASE_MS } from './briefJobState';
import { fanOutInternalPost, requireInternalSecret } from './lib';

const caller = { internalSecret: v.optional(v.string()), userId: v.string() };
const owned = { ...caller, id: v.id('briefJobs'), token: v.string() };

export const enqueue = mutation({
  args: {
    ...caller,
    kind: v.union(v.literal('daily'), v.literal('area'), v.literal('narrative')),
    edition: v.optional(v.union(v.literal('morning'), v.literal('evening'), v.literal('manual'))),
    areaId: v.optional(v.id('areas')),
    timezone: v.optional(v.string()),
    force: v.optional(v.boolean()),
    reportId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.kind === 'area') {
      const area = args.areaId ? await ctx.db.get(args.areaId) : null;
      if (!area || area.userId !== args.userId) throw new Error('Area not found');
    }
    if (args.kind === 'daily' && (!args.reportId || !args.edition)) throw new Error('Edition required');
    const scope = args.kind === 'area' ? `area:${args.areaId}` : args.kind;
    const active = await ctx.db
      .query('briefJobs')
      .withIndex('by_user_scope_active', (q) =>
        q.eq('userId', args.userId).eq('scope', scope).eq('active', true),
      )
      .unique();
    if (active) return { jobId: active._id, reportId: active.reportId, started: false };
    const now = Date.now();
    const id = await ctx.db.insert('briefJobs', {
      userId: args.userId,
      scope,
      kind: args.kind,
      edition: args.edition,
      areaId: args.areaId,
      timezone: args.timezone,
      force: args.force,
      reportId: args.reportId,
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
          generatedAt: now,
          status: 'partial',
          progress: { stage: 'queued', done: 0, total: 1 },
          accounts: [],
          title: 'Daily Brief',
          narrative: '',
          sections: {},
          stats: {},
        },
      });
    } else if (args.kind === 'area' && args.force) {
      const brief = await ctx.db
        .query('albatrossAreaBriefs')
        .withIndex('by_user_area', (q) => q.eq('userId', args.userId).eq('areaId', args.areaId!))
        .unique();
      if (brief) await ctx.db.patch(brief._id, { status: 'generating', error: undefined, updatedAt: now });
      else
        await ctx.db.insert('albatrossAreaBriefs', {
          userId: args.userId,
          areaId: args.areaId!,
          status: 'generating',
          lede: '',
          summary: '',
          sourceRefs: [],
          basedOnRevision: '',
          createdAt: now,
          updatedAt: now,
        });
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
  args: { ...owned, error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const job = await ctx.db.get(args.id);
    if (!job || job.userId !== args.userId || job.state !== 'running' || job.token !== args.token)
      return false;
    const retryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(job.attempts, 6));
    await ctx.db.patch(
      job._id,
      args.error
        ? {
            state: 'queued',
            token: undefined,
            availableAt: retryAt,
            error: args.error.slice(0, 300),
          }
        : { state: 'completed', active: false, token: undefined, completedAt: Date.now() },
    );
    if (args.error) {
      if (job.kind === 'daily') {
        const report = await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_key', (q) =>
            q.eq('userId', job.userId).eq('kind', 'dailyReport').eq('key', job.reportId!),
          )
          .unique();
        if (report)
          await ctx.db.patch(report._id, {
            doc: {
              ...report.doc,
              status: 'partial',
              progress: { stage: 'Retrying the writer', done: 0, total: 1 },
            },
            updatedAt: Date.now(),
          });
      } else if (job.kind === 'area') {
        const brief = await ctx.db
          .query('albatrossAreaBriefs')
          .withIndex('by_user_area', (q) => q.eq('userId', job.userId).eq('areaId', job.areaId!))
          .unique();
        if (brief)
          await ctx.db.patch(brief._id, { status: 'generating', error: undefined, updatedAt: Date.now() });
      }
      await ctx.scheduler.runAt(retryAt, (internal as any).briefJobs.deliver, { ids: [job._id] });
    }
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
