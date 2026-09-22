import { randomUUID } from 'node:crypto';
import { runWithAiRequestContext } from '../ai/context';
import { generateAreaLivingBrief } from '../albatross/area-living-brief';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { refreshNarrative } from '../narrative/service';
import { getDailyReport } from '../store/daily-reports';
import { generateAgentReport } from './agent-report';
import { notifyBriefReady } from './brief-ready';

const functions = (api as any).briefJobs;
export async function enqueueBriefJob(input: {
  userId: string;
  kind: 'daily' | 'area' | 'narrative';
  edition?: 'morning' | 'evening' | 'manual';
  timezone?: string;
  areaId?: string;
  force?: boolean;
}) {
  return convexMutation<{ jobId: string; reportId?: string; started: boolean }>(functions.enqueue, {
    ...input,
    ...(input.kind === 'daily' ? { reportId: randomUUID() } : {}),
  });
}

export async function waitForBriefJob(userId: string, id: string) {
  for (;;) {
    const job = await convexQuery<any>(functions.get, { userId, id });
    if (!job) throw new Error('Brief job not found');
    if (job.state === 'cancelled') throw new Error(job.error || 'Brief job cancelled');
    if (job.state === 'completed') return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const defaults = {
  mutation: convexMutation,
  query: convexQuery,
  daily: generateAgentReport,
  area: generateAreaLivingBrief,
  narrative: refreshNarrative,
  readDaily: getDailyReport,
  notify: notifyBriefReady,
};

// The HTTP handler returns after scheduling this work. The persisted queue and
// renewable ownership survive deploys; no generation duration is enforced here.
export async function runBriefJob(userId: string, id: string, deps = defaults) {
  const owner = { userId, id, token: randomUUID() };
  const job = await deps.mutation<any>(functions.claim, owner);
  if (!job) return;
  let lost = false;
  const heartbeat = setInterval(() => {
    void deps
      .mutation<boolean>(functions.heartbeat, owner)
      .then((owned) => {
        if (!owned) lost = true;
      })
      .catch(() => {});
  }, 30_000);
  try {
    await runWithAiRequestContext(
      { userId, agent: 'ai', userTimezone: job.timezone, briefJob: { id, token: owner.token } },
      async () => {
        if (job.kind === 'daily') {
          const saved = await deps.readDaily(job.reportId);
          const report =
            saved?.artifactStatus === 'ready' && saved.editorial?.mode === 'generated'
              ? saved
              : await deps.daily({ userId, kind: job.edition, reportId: job.reportId, now: job.createdAt });
          if (report.editorial?.mode !== 'generated')
            throw new Error('Editorial writer needs another attempt');
          if (lost || !(await deps.mutation<boolean>(functions.heartbeat, owner))) return;
          await deps.notify(userId, job.edition, report, job.timezone);
        } else if (job.kind === 'area') {
          const home = await deps.query<any>((api as any).albatross.areaHome, { userId, areaId: job.areaId });
          const saved = home.livingBrief;
          if (
            !(
              saved?.status === 'ready' &&
              saved.pulseUpdatedAt >= job.createdAt &&
              saved.pulse?.model &&
              saved.pulse.model !== 'local'
            )
          ) {
            const result = await deps.area({ userId, areaId: job.areaId, force: job.force });
            if (!result?.pulse?.model || result.pulse.model === 'local')
              throw new Error('Area writer needs another attempt');
          }
        } else {
          const result = await deps.narrative(userId, job.edition === 'manual' ? 'manual' : 'scheduled');
          if (result.status !== 'ready' && result.status !== 'disabled')
            throw new Error('Narrative needs another attempt');
        }
      },
    );
    if (!lost)
      await deps.mutation(functions.settle, {
        ...owner,
        ...(job.kind === 'area' ? { force: job.force === true } : {}),
      });
  } catch {
    // Keep retrying failed provider calls without a daily quota or attempt cap.
    // Persist only a fixed diagnostic, never private provider/source text.
    await deps.mutation(functions.settle, { ...owner, error: 'The writer will retry automatically.' });
  } finally {
    clearInterval(heartbeat);
  }
}
