import { v } from 'convex/values';
import { isStoredWebhookPayload, webhookPayloadForStorage } from '../lib/mail/webhook-storage';
import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './_generated/server';
import { now } from './lib';
import { purgeExpiredCodes } from './mailOneTimeCodes';

const DAY_MS = 86_400_000;

/** Processed webhook rows are kept this long. */
export const WEBHOOK_EVENT_RETENTION_MS = 14 * DAY_MS;

/**
 * The TTL of each webhook status (M5). Error and received rows stay longer
 * for diagnosis and for the durable retry, but no row stays forever.
 */
export const WEBHOOK_EVENT_TTL_MS = {
  processed: WEBHOOK_EVENT_RETENTION_MS,
  error: 30 * DAY_MS,
  received: 30 * DAY_MS,
} as const;

// Per-run batch sizes. Webhook rows carry mail payloads, so their batch is
// small enough that one run stays far below the Convex transaction limits.
export const RETENTION_BATCH = {
  oneTimeCodes: 200,
  webhookEvents: 10,
  rateLimits: 500,
  oauthStates: 100,
} as const;

type Counts = Record<string, number>;

async function deleteAll(ctx: MutationCtx, rows: Array<{ _id: any }>) {
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * One bounded retention pass over tables that otherwise grow with no limit.
 * Each table gets its own batch; when any batch comes back full, the pass
 * schedules itself again, so a backlog drains and an empty run is a few
 * cheap indexed reads.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const counts: Counts = {};
    let more = false;

    const codes = await purgeExpiredCodes(ctx, ts, RETENTION_BATCH.oneTimeCodes);
    counts.mailOneTimeCodes = codes.deleted;
    counts.mailOneTimeCodesExpired = codes.expired;
    more ||= codes.more;

    // Each status has its own TTL; error and received rows stay longer.
    counts.mailWebhookEvents = 0;
    for (const status of ['processed', 'error', 'received'] as const) {
      const webhookEvents = await ctx.db
        .query('mailWebhookEvents')
        .withIndex('by_status', (q) =>
          q.eq('status', status).lt('_creationTime', ts - WEBHOOK_EVENT_TTL_MS[status]),
        )
        .take(RETENTION_BATCH.webhookEvents);
      counts.mailWebhookEvents += await deleteAll(ctx, webhookEvents);
      more ||= webhookEvents.length === RETENTION_BATCH.webhookEvents;
    }

    const rateLimits = await ctx.db
      .query('rateLimits')
      .withIndex('by_expires', (q) => q.lt('expiresAt', ts))
      .take(RETENTION_BATCH.rateLimits);
    counts.rateLimits = await deleteAll(ctx, rateLimits);
    more ||= rateLimits.length === RETENTION_BATCH.rateLimits;

    // nylasOAuthStates has no expiry index. Its TTL is minutes, so every row
    // older than a day is expired or consumed.
    const nylasStates = await ctx.db
      .query('nylasOAuthStates')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', ts - DAY_MS))
      .take(RETENTION_BATCH.oauthStates);
    counts.nylasOAuthStates = await deleteAll(
      ctx,
      nylasStates.filter((row) => row.expiresAt < ts),
    );
    more ||= counts.nylasOAuthStates === RETENTION_BATCH.oauthStates;

    for (const table of [
      'mcpOAuthStates',
      'cloudFileOAuthStates',
      'cloudFileOAuthCompletions',
      'oauthCompletions',
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_expires', (q) => q.lt('expiresAt', ts))
        .take(RETENTION_BATCH.oauthStates);
      counts[table] = await deleteAll(ctx, rows);
      more ||= rows.length === RETENTION_BATCH.oauthStates;
    }

    if (more) await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
    return { counts, more };
  },
});

/** Rows per page of the one-time webhook payload cleanup. Old rows are large. */
export const WEBHOOK_SLIM_BATCH = 10;

/**
 * One-time cleanup (M5): cut the payload of each stored webhook row to ids.
 * New rows store ids only; this handles the rows from before. Error rows go
 * first, because they are the large rows that stay longest. Each page
 * schedules the next one. A dry run reports one page and changes nothing.
 */
export const slimWebhookPayloads = internalMutation({
  args: {
    status: v.optional(v.union(v.literal('processed'), v.literal('error'), v.literal('received'))),
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const status = args.status ?? 'error';
    const page = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_status', (q) => q.eq('status', status))
      .paginate({ cursor: args.cursor ?? null, numItems: WEBHOOK_SLIM_BATCH });
    let slimmed = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    for (const row of page.page) {
      if (isStoredWebhookPayload(row.payload)) continue;
      const stored = webhookPayloadForStorage(row.payload);
      bytesBefore += JSON.stringify(row.payload ?? null).length;
      bytesAfter += JSON.stringify(stored).length;
      slimmed += 1;
      if (!args.dryRun) await ctx.db.patch(row._id, { payload: stored });
    }
    if (!args.dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.slimWebhookPayloads, {
        status,
        cursor: page.continueCursor,
      });
    }
    return {
      status,
      scanned: page.page.length,
      slimmed,
      bytesBefore,
      bytesAfter,
      dryRun: Boolean(args.dryRun),
      isDone: page.isDone,
    };
  },
});
