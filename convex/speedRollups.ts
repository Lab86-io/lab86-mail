import { v } from 'convex/values';
import {
  isRunSpeedName,
  isWebSpeedName,
  MAX_SPEED_ROWS_PER_WRITE,
  mergeSpeedBuckets,
  RUN_SPEED_FORM_FACTOR,
  RUN_SPEED_SURFACE,
  type RunLatencyInput,
  runLatencySamples,
  SPEED_BUCKET_COUNT,
  type SpeedRollup,
  speedDay,
  speedRollupOf,
} from '../lib/ops/speed';
import type { MutationCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { requireInternalSecret } from './lib';

// Daily speed rows (lib/ops/speed.ts). The web route sends one coalesced
// mutation at most once a minute, not one for each page event. A finished run
// writes its own rows here too.

/** Rows for each page of the hand-run report. Each row is small. */
const REPORT_PAGE = 500;

async function addRow(ctx: MutationCtx, row: SpeedRollup, at: number) {
  const existing = await ctx.db
    .query('speedRollups')
    .withIndex('by_key', (q) =>
      q
        .eq('day', row.day)
        .eq('metric', row.metric)
        .eq('surface', row.surface)
        .eq('formFactor', row.formFactor),
    )
    .first();
  if (existing)
    await ctx.db.patch(existing._id, {
      count: existing.count + row.count,
      sum: existing.sum + row.sum,
      buckets: mergeSpeedBuckets(existing.buckets, row.buckets),
      updatedAt: at,
    });
  else await ctx.db.insert('speedRollups', { ...row, updatedAt: at });
}

/** The latency of one finished run: at most three rows, with no user or run id in them. */
export async function recordRunLatency(ctx: MutationCtx, run: RunLatencyInput) {
  const day = speedDay(run.finishedAt);
  for (const sample of runLatencySamples(run))
    await addRow(
      ctx,
      speedRollupOf(
        { day, metric: sample.metric, surface: RUN_SPEED_SURFACE, formFactor: RUN_SPEED_FORM_FACTOR },
        sample.value,
      ),
      run.finishedAt,
    );
}

const rollupValidator = v.object({
  day: v.string(),
  metric: v.string(),
  surface: v.string(),
  formFactor: v.string(),
  count: v.number(),
  sum: v.number(),
  buckets: v.array(v.number()),
});

/** One coalesced batch of web speed rows. An unknown name or shape stops the whole batch. */
export const addWebRollups = mutation({
  args: { internalSecret: v.optional(v.string()), rows: v.array(rollupValidator) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.rows.length > MAX_SPEED_ROWS_PER_WRITE) throw new Error('Too many speed rows.');
    for (const row of args.rows) {
      if (!isWebSpeedName(row.metric, row.surface, row.formFactor)) throw new Error('Unknown speed name.');
      if (row.buckets.length !== SPEED_BUCKET_COUNT) throw new Error('Wrong speed bucket count.');
    }
    const at = Date.now();
    for (const row of args.rows) await addRow(ctx, row, at);
    return { rows: args.rows.length };
  },
});

/** One page of daily rows for the report. Counts only. */
export const rollupsPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    sinceDay: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('speedRollups')
      .withIndex('by_key', (q) => q.gte('day', args.sinceDay))
      .paginate({ cursor: args.cursor ?? null, numItems: REPORT_PAGE });
    return {
      rows: page.page
        .filter(
          (row) =>
            isWebSpeedName(row.metric, row.surface, row.formFactor) ||
            isRunSpeedName(row.metric, row.surface, row.formFactor),
        )
        .map(({ day, metric, surface, formFactor, count, sum, buckets }) => ({
          day,
          metric,
          surface,
          formFactor,
          count,
          sum,
          buckets,
        })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
