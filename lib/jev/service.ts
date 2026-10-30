import { recordClassifierUsage, resolveClassifierRuntime } from '../ai/gateway';
import { classifierFailureText, evaluateClassifier, mapConcurrent } from '../classifier/client';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { needsYouFlagFor } from '../obligations/contract';
import { deliverObligationPushes } from '../obligations/delivery';
import type { DailyReport } from '../shared/types';
import {
  buildPrepareQuestions,
  JEV_CALENDAR_FEATURE,
  type JevCalendarEvent,
  prepareProbability,
  prepareState,
} from './calendar';
import type { JevCorrection, JevPreferences } from './contract';
import {
  assessmentFromResponse,
  buildMailQuestions,
  classifierState,
  factsAnswerSettles,
  factsInput,
  type JevFactsView,
  type JevMailInput,
} from './mail';

/** Usage feature of the first Jev stage (thread facts and snippets). */
export const JEV_FACTS_FEATURE = 'jev_mail';
/** Usage feature of the body stage (the start of the newest message bodies). */
export const JEV_BODY_FEATURE = 'jev_mail_body';

export function loadJevPolicy(userId: string) {
  return convexQuery<{ preferences: JevPreferences; corrections: JevCorrection[]; revision: number }>(
    api.jev.policy,
    { userId },
  );
}

export interface JevSweepDependencies {
  loadJevPolicy: typeof loadJevPolicy;
  resolveClassifierRuntime: typeof resolveClassifierRuntime;
  convexMutation: typeof convexMutation;
  evaluateClassifier: typeof evaluateClassifier;
  recordClassifierUsage: typeof recordClassifierUsage;
  afterClassified?: (userId: string) => void;
  /** Needs you (LAB86_NEEDS_YOU). Left out: the sweep passes no flag, as before. */
  needsYouFor?: (userId: string) => boolean;
  deliverObligations?: (userId: string, ids: string[]) => Promise<unknown>;
}

const sweepDefaults: JevSweepDependencies = {
  loadJevPolicy,
  resolveClassifierRuntime,
  convexMutation,
  evaluateClassifier,
  recordClassifierUsage,
  afterClassified: (userId: string) => {
    void import('../content/sync').then((module) => module.kickContentCycle(userId)).catch(() => undefined);
  },
  // Needs you (LAB86_NEEDS_YOU). Off: the sweep works as before.
  needsYouFor: (userId: string) => needsYouFlagFor(userId),
  deliverObligations: (userId: string, ids: string[]) => deliverObligationPushes(userId, ids),
};
export async function runJevSweep(userId: string, dependencies: JevSweepDependencies = sweepDefaults) {
  const {
    loadJevPolicy,
    resolveClassifierRuntime,
    convexMutation,
    evaluateClassifier,
    recordClassifierUsage,
  } = dependencies;
  const policy = await loadJevPolicy(userId);
  if (!policy.preferences.enabled) return { classified: 0 };
  // The flag is read once for the sweep. The claim records it for the page;
  // the store syncs the obligations of each stored thread.
  const needsYou = dependencies.needsYouFor?.(userId) ?? false;
  const flagArgs = dependencies.needsYouFor ? { needsYou } : {};
  const runtime = await resolveClassifierRuntime(userId);
  let classified = 0;
  let moreRemaining = false;
  const deadline = Date.now() + 40_000;
  for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
    const page = await convexMutation<{
      items: Array<JevMailInput & { leaseId: string; facts?: JevFactsView }>;
      moreRemaining: boolean;
    }>(api.jev.claimPending, { userId, limit: 12, ...flagArgs });
    if (!page.items.length) {
      // The claim can take gated rows off the queue and return no items. It
      // then reports more rows, and the next claim reads further down.
      moreRemaining = page.moreRemaining;
      if (!moreRemaining) break;
      continue;
    }
    const items = await mapConcurrent(page.items, 4, async ({ facts, ...input }) => {
      const target = {
        accountId: input.accountId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceRevision: input.sourceRevision,
        leaseId: input.leaseId,
      };
      // Two stages (IO-1). The first stage reads the thread facts and the
      // snippet of the newest message. Only an answer below the confidence
      // threshold, or one that finds an obligation, reads the bodies.
      const evaluate = async (stageInput: JevMailInput, feature: string) => {
        try {
          const result = await evaluateClassifier({
            apiKey: runtime.apiKey,
            model: runtime.model,
            state: classifierState(stageInput),
            questions: buildMailQuestions(stageInput, runtime.model),
            // Choice-only models answer one question per request.
            timeoutMs: runtime.model.protocol === 'systemone' ? 5_000 : 10_000,
          });
          await recordClassifierUsage(runtime, feature, result);
          return result;
        } catch (error) {
          // The reason (timeout, provider, invalid_response) stays on the row.
          await recordClassifierUsage(runtime, feature, undefined, undefined, classifierFailureText(error));
          return null;
        }
      };
      try {
        if (facts) {
          const first = factsInput(input, facts);
          const result = await evaluate(first, JEV_FACTS_FEATURE);
          // A failed call retries later; it does not buy a second call now.
          if (!result) return { ...target, error: 'unavailable' };
          if (factsAnswerSettles(first, result, runtime.model))
            return {
              ...target,
              assessment: assessmentFromResponse(first, result, Date.now(), runtime.model),
            };
        }
        const result = await evaluate(input, JEV_BODY_FEATURE);
        if (!result) return { ...target, error: 'unavailable' };
        return { ...target, assessment: assessmentFromResponse(input, result, Date.now(), runtime.model) };
      } catch {
        return { ...target, error: 'unavailable' };
      }
    });
    const result = await convexMutation<{ stored: number; obligationIds?: string[] }>(
      api.jev.storeAssessments,
      {
        userId,
        items,
        ...(needsYou ? { needsYou: true } : {}),
      },
    );
    classified += result.stored;
    // Best effort, after each stored batch: a later batch that fails cannot
    // drop the pushes of obligations that are already stored.
    const stored = result.obligationIds ?? [];
    if (stored.length && dependencies.deliverObligations)
      await dependencies.deliverObligations(userId, stored).catch(() => undefined);
    moreRemaining = page.moreRemaining;
    if (!moreRemaining) break;
  }
  if (classified) dependencies.afterClassified?.(userId);
  // Needs you, phase 4: the `prepare` question for the events of the next 24
  // hours. Best effort: a failure here never fails the mail sweep.
  if (needsYou) await runPrepareSweep(userId, runtime, dependencies).catch(() => undefined);
  return { classified, moreRemaining };
}

/**
 * Asks Jev the `prepare` question for the events that Convex claims (at most
 * six each sweep, each revision once) and stores the answers. A new `prepare`
 * item that passes the push bar pushes.
 */
export async function runPrepareSweep(
  userId: string,
  runtime: Awaited<ReturnType<typeof resolveClassifierRuntime>>,
  dependencies: Pick<
    JevSweepDependencies,
    'convexMutation' | 'evaluateClassifier' | 'recordClassifierUsage' | 'deliverObligations'
  >,
) {
  const { convexMutation, evaluateClassifier, recordClassifierUsage } = dependencies;
  const claim = await convexMutation<{ events: JevCalendarEvent[] }>(api.obligations.claimPrepareEvents, {
    userId,
  });
  if (!claim.events.length) return { asked: 0, stored: 0 };
  const results = await mapConcurrent(claim.events, 3, async (event) => {
    const target = {
      accountId: event.accountId,
      providerCalendarId: event.providerCalendarId,
      providerEventId: event.providerEventId,
      revision: event.revision,
    };
    try {
      const result = await evaluateClassifier({
        apiKey: runtime.apiKey,
        model: runtime.model,
        state: prepareState(event),
        questions: buildPrepareQuestions(),
        timeoutMs: 10_000,
      });
      await recordClassifierUsage(runtime, JEV_CALENDAR_FEATURE, result);
      const probability = prepareProbability(result);
      return probability === undefined ? target : { ...target, probability };
    } catch (error) {
      // The claim counted the attempt; the event is asked again later.
      await recordClassifierUsage(
        runtime,
        JEV_CALENDAR_FEATURE,
        undefined,
        undefined,
        classifierFailureText(error),
      );
      return target;
    }
  });
  const stored = await convexMutation<{ obligationIds: string[] }>(api.obligations.storePrepare, {
    userId,
    results,
  });
  if (stored.obligationIds.length && dependencies.deliverObligations)
    await dependencies.deliverObligations(userId, stored.obligationIds).catch(() => undefined);
  return { asked: claim.events.length, stored: stored.obligationIds.length };
}

/** Mark only a successfully persisted display edition, never a candidate pass. */
export async function markJevBriefItems(report: DailyReport, userId: string, mutate = convexMutation) {
  const selected = [
    ...(report.sections.answer || []),
    ...(report.sections.today || []),
    ...(report.sections.know || []),
  ];
  const items = selected
    .filter((item) => item.jev)
    .map((item) => ({
      accountId: item.account,
      threadId: item.threadId,
      sourceRevision: item.jev!.sourceRevision,
    }));
  if (!items.length) return;
  await mutate(api.jev.markBriefItems, { userId, items });
}
