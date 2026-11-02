import { v } from 'convex/values';
import {
  evaluateOpsKind,
  OPS_HEALTH_KINDS,
  OPS_HEALTH_SHARDS,
  OPS_HOUR_MS,
  OPS_WINDOW_ROW_LIMIT,
  type OpsErrorClass,
  type OpsHealthKind,
  type OpsNotice,
  type OpsWatchState,
  opsDay,
  opsHourStart,
  opsStateKey,
  releaseOpsNotice,
  settleOpsNotice,
  toolCallOutcome,
} from '../lib/ops/health';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalAction, mutation, query } from './_generated/server';
import { fanOutInternalPost, requireInternalSecret } from './lib';

// The failure alarm (lib/ops/health.ts, docs/ops-signals.md). The write path
// adds one to an hourly bucket, with one point read. The 15-minute cron starts
// the app route, which reads `windowRows`, calls `evaluate`, and sends the mail.

/** Rows for each page of the hand-run report. */
const REPORT_PAGE = 500;
/** One day of tool rollups is a few rows for each tool that ran. */
const TOOL_PAGE = 500;

/** Adds one call to its bucket: one indexed read and one write of a small row. */
export async function recordOpsHealth(
  ctx: MutationCtx,
  input: { kind: OpsHealthKind; ok: boolean; errorClass?: OpsErrorClass | string; at: number },
) {
  const hourStart = opsHourStart(input.at);
  const shard = Math.floor(Math.random() * OPS_HEALTH_SHARDS);
  const row = await ctx.db
    .query('opsHealthBuckets')
    .withIndex('by_hour_kind_shard', (q) =>
      q.eq('hourStart', hourStart).eq('kind', input.kind).eq('shard', shard),
    )
    .first();
  const outcome = input.ok
    ? { lastOkAt: input.at }
    : {
        lastFailedAt: input.at,
        ...(input.errorClass ? { lastErrorClass: input.errorClass } : {}),
      };
  if (row)
    await ctx.db.patch(row._id, {
      ok: row.ok + (input.ok ? 1 : 0),
      failed: row.failed + (input.ok ? 0 : 1),
      ...outcome,
    });
  else
    await ctx.db.insert('opsHealthBuckets', {
      hourStart,
      kind: input.kind,
      shard,
      ok: input.ok ? 1 : 0,
      failed: input.ok ? 0 : 1,
      ...outcome,
    });
}

/**
 * One finished agent tool call: its bucket, and one daily row for its name and
 * class, for the report. `status` and `errorClass` are plain inputs, so a new
 * status of the tool writer needs no change here.
 */
export async function recordToolFinish(
  ctx: MutationCtx,
  input: { toolName: string; status: string; errorClass?: unknown; error?: string; at: number },
) {
  const outcome = toolCallOutcome(input);
  if (outcome.ok !== null)
    await recordOpsHealth(ctx, {
      kind: 'tool',
      ok: outcome.ok,
      errorClass: outcome.errorClass,
      at: input.at,
    });
  const day = opsDay(input.at);
  const row = await ctx.db
    .query('opsToolRollups')
    .withIndex('by_day_tool_class', (q) =>
      q.eq('day', day).eq('toolName', input.toolName).eq('errorClass', outcome.errorClass),
    )
    .first();
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else
    await ctx.db.insert('opsToolRollups', {
      day,
      toolName: input.toolName,
      errorClass: outcome.errorClass,
      count: 1,
    });
}

function stateOf(row: Doc<'opsHealthWatch'> | undefined): OpsWatchState {
  return {
    hours: row?.hours ?? [],
    ...(row?.lastOkAt === undefined ? {} : { lastOkAt: row.lastOkAt }),
    ...(row?.incident ? { incident: row.incident } : {}),
  };
}

async function watchRows(ctx: MutationCtx) {
  // One row for each kind, so this read has a low limit.
  const rows = await ctx.db.query('opsHealthWatch').take(OPS_HEALTH_KINDS.length + 4);
  return new Map(rows.map((row) => [row.kind, row]));
}

async function saveState(
  ctx: MutationCtx,
  kind: OpsHealthKind,
  row: Doc<'opsHealthWatch'> | undefined,
  state: OpsWatchState,
  now: number,
) {
  const { incident, lastOkAt, hours } = state;
  if (row)
    await ctx.db.patch(row._id, {
      hours,
      lastOkAt,
      // A patch with undefined removes the field: the incident is closed.
      incident,
      updatedAt: now,
    });
  else
    await ctx.db.insert('opsHealthWatch', {
      kind,
      hours,
      ...(lastOkAt === undefined ? {} : { lastOkAt }),
      ...(incident ? { incident } : {}),
      updatedAt: now,
    });
}

/**
 * The buckets of the current and the previous hour. A read only, so the
 * frequent usage writes cannot make it conflict during a burst of failures.
 */
export const windowRows = query({
  args: { internalSecret: v.optional(v.string()), now: v.number() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const from = opsHourStart(args.now) - OPS_HOUR_MS;
    const rows = await ctx.db
      .query('opsHealthBuckets')
      .withIndex('by_hour_kind_shard', (q) => q.gte('hourStart', from))
      .take(OPS_WINDOW_ROW_LIMIT);
    return rows.map(({ hourStart, kind, ok, failed, lastErrorClass, lastFailedAt, lastOkAt }) => ({
      hourStart,
      kind,
      ok,
      failed,
      ...(lastErrorClass ? { lastErrorClass } : {}),
      ...(lastFailedAt === undefined ? {} : { lastFailedAt }),
      ...(lastOkAt === undefined ? {} : { lastOkAt }),
    }));
  },
});

const windowRowValidator = v.object({
  hourStart: v.number(),
  kind: v.string(),
  ok: v.number(),
  failed: v.number(),
  lastErrorClass: v.optional(v.string()),
  lastFailedAt: v.optional(v.number()),
  lastOkAt: v.optional(v.number()),
});

/**
 * One alarm pass over the rows of `windowRows`: saves the next state of each
 * kind and returns the notices to send. The claim is in this transaction, so
 * two runs cannot send one notice twice.
 */
export const evaluate = mutation({
  args: { internalSecret: v.optional(v.string()), now: v.number(), rows: v.array(windowRowValidator) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const watches = await watchRows(ctx);
    const notices: OpsNotice[] = [];
    for (const kind of OPS_HEALTH_KINDS) {
      const row = watches.get(kind);
      const previous = stateOf(row);
      const { state, notice } = evaluateOpsKind(
        kind,
        previous,
        args.rows.filter((bucket) => bucket.kind === kind),
        args.now,
      );
      // An idle kind writes nothing, so a quiet night costs reads only.
      if (!row && !state.hours.length && !state.incident) continue;
      if (!row || opsStateKey(previous) !== opsStateKey(state))
        await saveState(ctx, kind, row, state, args.now);
      if (notice) notices.push(notice);
    }
    return { notices };
  },
});

const noticeRef = v.object({
  kind: v.string(),
  type: v.union(v.literal('opened'), v.literal('recovered')),
});

/** The mail went out. Saved, so that a restart does not send it again. */
export const settleNotices = mutation({
  args: { internalSecret: v.optional(v.string()), now: v.number(), notices: v.array(noticeRef) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const watches = await watchRows(ctx);
    for (const notice of args.notices) {
      const row = watches.get(notice.kind);
      if (row)
        await saveState(
          ctx,
          row.kind as OpsHealthKind,
          row,
          settleOpsNotice(stateOf(row), notice.type, args.now),
          args.now,
        );
    }
  },
});

/** The mail did not go out. The next run sends the notices again. */
export const releaseNotices = mutation({
  args: { internalSecret: v.optional(v.string()), now: v.number(), notices: v.array(noticeRef) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const watches = await watchRows(ctx);
    for (const notice of args.notices) {
      const row = watches.get(notice.kind);
      if (row) await saveState(ctx, row.kind as OpsHealthKind, row, releaseOpsNotice(stateOf(row)), args.now);
    }
  },
});

/** One page of hourly buckets for the report. Counts and classes only. */
export const bucketsPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    since: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('opsHealthBuckets')
      .withIndex('by_hour_kind_shard', (q) => q.gte('hourStart', args.since))
      .paginate({ cursor: args.cursor ?? null, numItems: REPORT_PAGE });
    return {
      rows: page.page.map(({ hourStart, kind, ok, failed, lastErrorClass }) => ({
        hourStart,
        kind,
        ok,
        failed,
        ...(lastErrorClass ? { lastErrorClass } : {}),
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** One page of daily tool rows for the report. Tool names and counts only. */
export const toolRollupsPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    sinceDay: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('opsToolRollups')
      .withIndex('by_day_tool_class', (q) => q.gte('day', args.sinceDay))
      .paginate({ cursor: args.cursor ?? null, numItems: TOOL_PAGE });
    return {
      rows: page.page.map(({ day, toolName, errorClass, count }) => ({ day, toolName, errorClass, count })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** The 15-minute cron: starts the app route, which reads the buckets and sends the mail. */
export const tick = internalAction({
  args: {},
  handler: async () => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[ops-health cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    await fanOutInternalPost(`${appUrl}/api/cron/ops-health`, secret, [{}], { label: 'ops-health cron' });
  },
});
