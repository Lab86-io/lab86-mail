import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BRIEF_JOB_MAX_ATTEMPTS } from '../../convex/briefJobState';
import { runWithAiRequestContext } from '../ai/context';
import { isTerminalAiError, resolveAiRuntime } from '../ai/gateway';
import { generateAreaLivingBrief } from '../albatross/area-living-brief';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { refreshNarrative } from '../narrative/service';
import type { DailyReport } from '../shared/types';
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

export async function waitForBriefJob(userId: string, id: string, signal?: AbortSignal) {
  for (;;) {
    signal?.throwIfAborted();
    const job = await convexQuery<any>(functions.get, { userId, id }, signal);
    if (!job) throw new Error('Brief job not found');
    if (job.state === 'cancelled') throw new Error(job.error || 'Brief job cancelled');
    if (job.state === 'completed') return job;
    // Only the caller's wait ends on disconnect; the persisted writer continues.
    await delay(2_000, undefined, { signal });
  }
}

// Another attempt is pointless when the writer has no model access at all.
async function writerHasNoAccess(userId: string, feature: string) {
  try {
    await resolveAiRuntime({ userId, speed: 'primary', feature });
    return false;
  } catch (err) {
    return isTerminalAiError(err);
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
  noAccess: writerHasNoAccess,
  now: () => Date.now(),
};

const RETRY_NOTE = 'The writer will retry automatically.';
const FINAL_NOTE = 'The writer is unavailable. The edition was published without it.';

// The daily writer recorded, during this run, that it cannot reach a model.
function recordedNoAccess(report: DailyReport, since: number) {
  return (report.artifactErrors ?? []).some(
    (error) => error.stage === 'ai_availability' && error.at >= since,
  );
}

// A published edition (fallback document or older HTML) that a retry must
// keep readable instead of reverting to a progress state.
function isPublishedEdition(report: DailyReport | null | undefined) {
  return Boolean(report && report.status !== 'partial' && (report.document || report.html));
}

// The HTTP handler returns after scheduling this work. The persisted queue and
// renewable ownership survive deploys; no generation duration is enforced here.
// A writer failure retries with backoff until BRIEF_JOB_MAX_ATTEMPTS, or ends
// at once when the failure is final (no plan, key, or credits). Either way the
// fallback edition is published as ready.
export async function runBriefJob(userId: string, id: string, overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  const owner = { userId, id, token: randomUUID() };
  const job = await deps.mutation<any>(functions.claim, owner);
  if (!job) return;
  const finalAttempt = Number(job.attempts) >= BRIEF_JOB_MAX_ATTEMPTS;
  const startedAt = deps.now();
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
              : await deps.daily({
                  userId,
                  kind: job.edition,
                  reportId: job.reportId,
                  now: job.createdAt,
                  quiet: isPublishedEdition(saved),
                });
          if (report.editorial?.mode !== 'generated' && !finalAttempt && !recordedNoAccess(report, startedAt))
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
            // A matching source revision must not preserve a deterministic fallback.
            const force = job.force === true || !saved?.pulse?.model || saved.pulse.model === 'local';
            const result = await deps.area({ userId, areaId: job.areaId, force });
            if (
              (!result?.pulse?.model || result.pulse.model === 'local') &&
              !finalAttempt &&
              !(await deps.noAccess(userId, 'albatross_area_pulse'))
            )
              throw new Error('Area writer needs another attempt');
          }
        } else {
          const result = await deps.narrative(userId, job.edition === 'manual' ? 'manual' : 'scheduled');
          if (
            result.status !== 'ready' &&
            result.status !== 'disabled' &&
            !finalAttempt &&
            !(await deps.noAccess(userId, 'narrative_write'))
          )
            throw new Error('Narrative needs another attempt');
        }
      },
    );
    if (!lost)
      await deps.mutation(functions.settle, {
        ...owner,
        ...(job.kind === 'area' ? { force: job.force === true } : {}),
      });
  } catch (err) {
    // Persist only a fixed diagnostic, never private provider/source text.
    const terminal = finalAttempt || isTerminalAiError(err);
    await deps.mutation(functions.settle, {
      ...owner,
      error: terminal ? FINAL_NOTE : RETRY_NOTE,
      ...(terminal ? { terminal: true } : {}),
    });
  } finally {
    clearInterval(heartbeat);
  }
}
