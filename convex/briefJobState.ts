import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

// A renewable ownership lease, never a generation deadline.
export const BRIEF_JOB_LEASE_MS = 120_000;
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
