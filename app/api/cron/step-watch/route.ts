import { type NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { type ContractProof, outstandingProofs } from '@/lib/albatross/contract';
import { evidenceSatisfies } from '@/lib/albatross/evidence-gate';
import { proofMatchScore, proofOfferAllowed, threadPrimaryCategory } from '@/lib/albatross/proof-match';
import { checkWaitingReplies } from '@/lib/albatross/reply-watch-runtime';
import { completeWorkStep } from '@/lib/albatross/step-execution';
import { type StepVerification, stepNeedsCheck } from '@/lib/albatross/step-verification';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { isStandingOrderPaused } from '@/lib/hosted/standing-orders';
import { truncateText } from '@/lib/shared/text';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Lexical floor before a thread may spend a gate call for a step. */
const WATCH_PREFILTER_FLOOR = 0.08;
const WATCH_STEP_LIMIT = 3;
const WATCH_THREADS_PER_STEP = 2;
const WATCH_RECENT_THREADS = 40;
/** The goal watch reads new threads in pages of 50, at most 10 pages in one pass. */
const GOAL_WATCH_PAGE = 50;
const GOAL_WATCH_PAGES = 10;

interface StepWatchDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  completeWorkStep: typeof completeWorkStep;
  evidenceSatisfies: typeof evidenceSatisfies;
  reportError: typeof console.error;
  watchesPaused: (userId: string) => Promise<boolean>;
}

const defaults: StepWatchDependencies = {
  isInternalCronRequest,
  convexMutation,
  convexQuery,
  completeWorkStep,
  evidenceSatisfies,
  reportError: console.error,
  watchesPaused: (userId) => isStandingOrderPaused(userId, 'watches'),
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

/** The row shape `mailCorpus.listRecentCorpusThreads` returns. */
export interface RecentCorpusThread {
  _id: string;
  account: string;
  subject?: string;
  snippet?: string;
  fromAddress?: string;
  lastDate?: number;
  labels?: string[];
  smartCategory?: { primary?: unknown; model?: unknown } | null;
}

/** One page of `mailCorpus.pageRecentCorpusThreads`, newest first. */
interface RecentCorpusThreadPage {
  items: RecentCorpusThread[];
  nextBefore?: number | null;
}

/** One page of `mailCorpus.pageCorpusThreadsAfter`, oldest first. */
interface CorpusThreadsAfterPage {
  items: RecentCorpusThread[];
  /** Every thread at or before this time is read. */
  lastDate: number;
  more: boolean;
}

/**
 * The threads to judge in one pass, and the new mark. The first pass (no
 * mark) reads the newest page only and marks its newest thread. A later pass
 * reads upward from the mark, oldest first, at most 10 pages, and the mark
 * moves to the last thread it read. So a burst of mail never stops the
 * watch: the next pass goes on where this one stopped.
 */
export async function goalThreadsSince(
  query: typeof convexQuery,
  userId: string,
  after: number,
): Promise<{ threads: RecentCorpusThread[]; mark: number }> {
  if (!after) {
    const page = await query<RecentCorpusThreadPage>(api.mailCorpus.pageRecentCorpusThreads, {
      userId,
      limit: GOAL_WATCH_PAGE,
    });
    const threads = page?.items || [];
    return { threads, mark: threads.reduce((newest, thread) => Math.max(newest, thread.lastDate || 0), 0) };
  }
  const threads: RecentCorpusThread[] = [];
  let mark = after;
  for (let page = 0; page < GOAL_WATCH_PAGES; page += 1) {
    const result = await query<CorpusThreadsAfterPage>(api.mailCorpus.pageCorpusThreadsAfter, {
      userId,
      after: mark,
      limit: GOAL_WATCH_PAGE,
    });
    threads.push(...(result?.items || []));
    if (result && result.lastDate > mark) mark = result.lastDate;
    if (!result?.more) break;
  }
  return { threads, mark };
}

/**
 * The evidence text of one thread for a goal proof. The folders say whether
 * the user sent it (SENT) or got it, which a proof such as "The message left
 * your account" needs.
 */
function goalWatchEvidence(thread: RecentCorpusThread): string {
  return [
    `Subject: ${thread.subject || '(no subject)'}`,
    thread.fromAddress ? `From: ${thread.fromAddress}` : null,
    thread.labels?.length ? `Folders: ${thread.labels.slice(0, 8).join(', ')}` : null,
    thread.lastDate ? `Date: ${new Date(thread.lastDate).toISOString().slice(0, 10)}` : null,
    thread.snippet ? `Text: ${thread.snippet}` : null,
  ]
    .filter(Boolean)
    .join('\n');
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
    // Settings, Standing orders: paused watches read and check off nothing.
    if (await deps.watchesPaused(userId)) return NextResponse.json({ ok: true, skipped: 'paused' });
    try {
      const detail = await deps.convexQuery<any>(api.albatrossWorkV2.workDetail, {
        userId,
        workId,
      });
      if (detail?.work?.replyWatch && detail.work.workState === 'waiting') {
        const replies = await checkWaitingReplies({ userId, workId }, deps);
        await deps.convexMutation(api.albatrossWorkV2.completeMailWatch, {
          userId,
          workId,
          stillWatching: true,
        });
        return NextResponse.json({ ok: true, ...replies, completedSteps: 0 });
      }
      const steps: WatchableStep[] = detail?.execution?.guideSteps || [];
      // A confirmed step is final. It is never watched again.
      const outstanding = steps.filter(
        (step) => stepNeedsCheck(step) && step.evidenceKind === 'mail_confirmation' && step.identity,
      );
      // A goal Work (docs/albatross-goal-runs.md) has no mail steps: the watch
      // reads mail against the open proofs of its contract instead.
      const openProofs: ContractProof[] =
        detail?.goalRuns && detail?.contract ? outstandingProofs(detail.contract) : [];
      if (!outstanding.length && !openProofs.length) {
        await deps.convexMutation(api.albatrossWorkV2.completeMailWatch, {
          userId,
          workId,
          stillWatching: false,
        });
        return NextResponse.json({ ok: true, watched: 0, completedSteps: 0 });
      }

      const threads = outstanding.length
        ? (await deps.convexQuery<RecentCorpusThread[]>(api.mailCorpus.listRecentCorpusThreads, {
            userId,
            limit: WATCH_RECENT_THREADS,
          })) || []
        : [];
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
          await deps.convexMutation(api.albatrossWorkV2.attachProof, {
            userId,
            workId,
            claim: truncateText(`${step.title}: ${verdict.reason || 'confirmed by mail'}`, 400),
            title: truncateText(String(candidate.thread.subject || 'Mail confirmation'), 300),
            summary: truncateText(String(candidate.thread.snippet || ''), 600) || undefined,
            sourceKind: 'mail_thread',
            // listRecentCorpusThreads returns the provider thread id as `_id`
            // and the account as `account` (WRK-2).
            sourceId: String(candidate.thread._id),
            accountId: String(candidate.thread.account),
            stepIdentity: step.identity,
            trust: 'observed',
            settleContract: true,
          });
          await deps.completeWorkStep({ userId, workId, stepKey: step.key, source: 'evidence' });
          completedSteps += 1;
          break;
        }
      }

      let settledProofs = 0;
      const outcome = String(detail?.contract?.outcome || '');
      // A goal proof can stay open for weeks. Each pass judges only threads
      // newer than the last pass, so the cost does not grow with time.
      const watchedAfter = Number(detail?.work?.goalWatchAfter) || 0;
      const read = openProofs.length
        ? await goalThreadsSince(deps.convexQuery, userId, watchedAfter)
        : { threads: [], mark: watchedAfter };
      const fresh = read.threads.filter((thread) => proofOfferAllowed(threadPrimaryCategory(thread)));
      const newestDate = read.mark;
      for (const proof of fresh.length ? openProofs : []) {
        const needle = [outcome, workTitle, proof.what].filter(Boolean).join(' ');
        const ranked = fresh
          .map((thread) => ({ thread, text: `${thread.subject || ''} ${thread.snippet || ''}`.trim() }))
          .map((row) => ({ ...row, score: proofMatchScore(needle, row.text) }))
          .filter((row) => row.score >= WATCH_PREFILTER_FLOOR && row.text)
          .sort((a, b) => b.score - a.score)
          .slice(0, WATCH_THREADS_PER_STEP);
        for (const candidate of ranked) {
          const verdict = await deps.evidenceSatisfies({
            userId,
            workTitle,
            outcome: outcome || null,
            requirement: proof.what,
            evidenceText: goalWatchEvidence(candidate.thread),
          });
          if (!verdict.satisfies || verdict.unavailable) continue;
          // The gate judged that this verified thread shows the named proof.
          // The contract then closes the Work by its own closeWhen rule.
          await deps.convexMutation(api.albatrossWorkV2.attachProof, {
            userId,
            workId,
            claim: truncateText(`${proof.what}: ${verdict.reason || 'shown by mail'}`, 400),
            title: truncateText(String(candidate.thread.subject || 'Mail'), 300),
            summary: truncateText(String(candidate.thread.snippet || ''), 600) || undefined,
            sourceKind: 'mail_thread',
            sourceId: String(candidate.thread._id),
            accountId: String(candidate.thread.account),
            trust: 'inferred',
            proofId: proof.id,
            settleContract: true,
          });
          settledProofs += 1;
          break;
        }
      }

      const stillWatching = outstanding.length - completedSteps > 0 || openProofs.length - settledProofs > 0;
      await deps.convexMutation(api.albatrossWorkV2.completeMailWatch, {
        userId,
        workId,
        stillWatching,
        ...(newestDate > watchedAfter ? { goalWatchAfter: newestDate } : {}),
      });
      return NextResponse.json({
        ok: true,
        watched: outstanding.length,
        completedSteps,
        ...(openProofs.length ? { watchedProofs: openProofs.length, settledProofs } : {}),
        stillWatching,
      });
    } catch (error) {
      deps.reportError('[cron/step-watch] watch failed', workId, describeModelError(error));
      return NextResponse.json({ ok: false, error: 'Step watch failed.', workId }, { status: 500 });
    }
  };
}

export const POST = createStepWatchPost();
