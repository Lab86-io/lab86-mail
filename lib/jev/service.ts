import { recordClassifierUsage, resolveClassifierRuntime } from '../ai/gateway';
import { classifierFailureText, evaluateClassifier, mapConcurrent } from '../classifier/client';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import type { DailyReport } from '../shared/types';
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

const sweepDefaults = {
  loadJevPolicy,
  resolveClassifierRuntime,
  convexMutation,
  evaluateClassifier,
  recordClassifierUsage,
  afterClassified: (userId: string) => {
    void import('../content/sync').then((module) => module.kickContentCycle(userId)).catch(() => undefined);
  },
};
export async function runJevSweep(userId: string, dependencies = sweepDefaults) {
  const {
    loadJevPolicy,
    resolveClassifierRuntime,
    convexMutation,
    evaluateClassifier,
    recordClassifierUsage,
  } = dependencies;
  const policy = await loadJevPolicy(userId);
  if (!policy.preferences.enabled) return { classified: 0 };
  const runtime = await resolveClassifierRuntime(userId);
  let classified = 0;
  let moreRemaining = false;
  const deadline = Date.now() + 40_000;
  for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
    const page = await convexMutation<{
      items: Array<JevMailInput & { leaseId: string; facts?: JevFactsView }>;
      moreRemaining: boolean;
    }>(api.jev.claimPending, { userId, limit: 12 });
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
    const result = await convexMutation<{ stored: number }>(api.jev.storeAssessments, {
      userId,
      items,
    });
    classified += result.stored;
    moreRemaining = page.moreRemaining;
    if (!moreRemaining) break;
  }
  if (classified) dependencies.afterClassified?.(userId);
  return { classified, moreRemaining };
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
