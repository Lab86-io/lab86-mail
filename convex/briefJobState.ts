import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

// A renewable ownership lease, never a generation deadline.
export const BRIEF_JOB_LEASE_MS = 120_000;
// After this many claims a job stops retrying. The daily job publishes its
// fallback edition as ready, and the area brief leaves "generating". The
// backoff (10 s doubling to 5 min) spreads the attempts over about 20 minutes.
export const BRIEF_JOB_MAX_ATTEMPTS = 8;
export const briefJobFence = v.object({ id: v.id('briefJobs'), token: v.string() });

export async function assertBriefJobOwner(
  ctx: MutationCtx,
  userId: string,
  fence: { id: Id<'briefJobs'>; token: string } | undefined,
  target: { reportId?: string; areaId?: string },
) {
  if (!fence) return;
  const job = await ctx.db.get(fence.id);
  if (
    !job ||
    job.userId !== userId ||
    job.state !== 'running' ||
    job.token !== fence.token ||
    job.availableAt <= Date.now() ||
    (target.reportId && (job.kind !== 'daily' || job.reportId !== target.reportId)) ||
    (target.areaId && (job.kind !== 'area' || job.areaId !== target.areaId))
  )
    throw new Error('Brief job ownership changed');
}
