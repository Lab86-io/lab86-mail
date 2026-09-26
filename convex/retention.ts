import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './_generated/server';
import { now } from './lib';
import { purgeExpiredCodes } from './mailOneTimeCodes';

const DAY_MS = 86_400_000;

/** Processed webhook rows hold full mail payloads; keep them this long. */
export const WEBHOOK_EVENT_RETENTION_MS = 14 * DAY_MS;

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

    // Only processed rows go. Received and error rows stay for diagnosis.
    const webhookEvents = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_status', (q) =>
        q.eq('status', 'processed').lt('_creationTime', ts - WEBHOOK_EVENT_RETENTION_MS),
      )
      .take(RETENTION_BATCH.webhookEvents);
    counts.mailWebhookEvents = await deleteAll(ctx, webhookEvents);
    more ||= webhookEvents.length === RETENTION_BATCH.webhookEvents;

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

    for (const table of ['mcpOAuthStates', 'cloudFileOAuthStates', 'cloudFileOAuthCompletions'] as const) {
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
