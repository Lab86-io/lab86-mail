import { type NextRequest, NextResponse } from 'next/server';
import { evidenceSatisfies } from '@/lib/albatross/evidence-gate';
import { proofMatchScore, proofOfferAllowed, threadPrimaryCategory } from '@/lib/albatross/proof-match';
import { completeWorkStep } from '@/lib/albatross/step-execution';
import { type StepVerification, stepNeedsCheck } from '@/lib/albatross/step-verification';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Lexical floor before a thread may spend a gate call for a step. */
const WATCH_PREFILTER_FLOOR = 0.08;
const WATCH_STEP_LIMIT = 3;
const WATCH_THREADS_PER_STEP = 2;
const WATCH_RECENT_THREADS = 40;

interface StepWatchDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  completeWorkStep: typeof completeWorkStep;
  evidenceSatisfies: typeof evidenceSatisfies;
  reportError: typeof console.error;
}

const defaults: StepWatchDependencies = {
  isInternalCronRequest,
  convexMutation,
  convexQuery,
  completeWorkStep,
  evidenceSatisfies,
  reportError: console.error,
};

interface WatchableStep {
  key: string;
  identity: string;
  title: string;
  doneWhen: string | null;
  evidenceKind: string | null;
  evidenceHint: string | null;
  done: boolean;
  verification?: StepVerification | null;
}

/**
 * One watch pass for one Work: does any recent confirmable thread satisfy an
 * unfinished step that expects a mail confirmation? The gate fails closed —
 * an unavailable check completes nothing, and the watch simply polls again.
 */
export function createStepWatchPost(overrides: Partial<StepWatchDependencies> = {}) {
  const deps: StepWatchDependencies = { ...defaults, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const workId = String(body?.workId || '').trim();
    if (!userId || !workId) {
      return NextResponse.json({ ok: false, error: 'userId and workId are required.' }, { status: 400 });
    }
    try {
      const detail = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
        userId,
        workId,
      });
      const steps: WatchableStep[] = detail?.execution?.guideSteps || [];
      // A confirmed step is final. It is never watched again.
      const outstanding = steps.filter(
        (step) => stepNeedsCheck(step) && step.evidenceKind === 'mail_confirmation' && step.identity,
      );
      if (!outstanding.length) {
        await deps.convexMutation((api as any).albatrossWorkV2.completeMailWatch, {
          userId,
          workId,
          stillWatching: false,
        });
        return NextResponse.json({ ok: true, watched: 0, completedSteps: 0 });
      }

      const threads =
        (await deps.convexQuery<any[]>((api as any).mailCorpus.listRecentCorpusThreads, {
          userId,
          limit: WATCH_RECENT_THREADS,
        })) || [];
      const confirmable = threads.filter((thread) => proofOfferAllowed(threadPrimaryCategory(thread)));
      const workTitle = String(detail?.plan?.outcome || detail?.work?.title || '');

      let completedSteps = 0;
      for (const step of outstanding.slice(0, WATCH_STEP_LIMIT)) {
        const needle = [step.title, step.doneWhen, step.evidenceHint].filter(Boolean).join(' ');
        const ranked = confirmable
          .map((thread) => ({
            thread,
            text: `${thread.subject || ''} ${thread.snippet || ''}`.trim(),
          }))
          .map((row) => ({ ...row, score: proofMatchScore(needle, row.text) }))
          .filter((row) => row.score >= WATCH_PREFILTER_FLOOR && row.text)
          .sort((a, b) => b.score - a.score)
          .slice(0, WATCH_THREADS_PER_STEP);
        for (const candidate of ranked) {
          const verdict = await deps.evidenceSatisfies({
            userId,
            workTitle,
            outcome: detail?.plan?.outcome ?? null,
            requirement:
              [step.doneWhen || `"${step.title}" is complete.`, step.evidenceHint]
                .filter(Boolean)
                .join(' Expected: ') || step.title,
            evidenceText: candidate.text,
          });
          if (!verdict.satisfies) continue;
          await deps.convexMutation((api as any).albatrossWorkV2.attachProof, {
            userId,
            workId,
            claim: `${step.title}: ${verdict.reason || 'confirmed by mail'}`.slice(0, 400),
            title: String(candidate.thread.subject || 'Mail confirmation').slice(0, 300),
            summary: String(candidate.thread.snippet || '').slice(0, 600) || undefined,
            sourceKind: 'mail_thread',
            sourceId: String(candidate.thread.providerThreadId),
            accountId: String(candidate.thread.accountId),
            stepIdentity: step.identity,
            trust: 'observed',
            settleContract: true,
          });
          await deps.completeWorkStep({ userId, workId, stepKey: step.key, source: 'evidence' });
          completedSteps += 1;
          break;
        }
      }

      const stillWatching = outstanding.length - completedSteps > 0;
      await deps.convexMutation((api as any).albatrossWorkV2.completeMailWatch, {
        userId,
        workId,
        stillWatching,
      });
      return NextResponse.json({
        ok: true,
        watched: outstanding.length,
        completedSteps,
        stillWatching,
      });
    } catch (error) {
      deps.reportError('[cron/step-watch] watch failed', workId, error);
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'Step watch failed.', workId },
        { status: 500 },
      );
    }
  };
}

export const POST = createStepWatchPost();
