import { recordJevUsage, resolveJevRuntime } from '../ai/gateway';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import type { DailyReport } from '../shared/types';
import { evaluateJev, mapConcurrent } from './client';
import type { JevCorrection, JevPreferences } from './contract';
import { assessmentFromResponse, buildMailQuestions, type JevMailInput } from './mail';

export function loadJevPolicy(userId: string) {
  return convexQuery<{ preferences: JevPreferences; corrections: JevCorrection[]; revision: number }>(
    (api as any).jev.policy,
    { userId },
  );
}

const sweepDefaults = {
  loadJevPolicy,
  resolveJevRuntime,
  convexMutation,
  evaluateJev,
  recordJevUsage,
  afterClassified: (userId: string) => {
    void import('../content/sync').then((module) => module.kickContentCycle(userId)).catch(() => undefined);
  },
};
export async function runJevSweep(userId: string, dependencies = sweepDefaults) {
  const { loadJevPolicy, resolveJevRuntime, convexMutation, evaluateJev, recordJevUsage } = dependencies;
  const policy = await loadJevPolicy(userId);
  if (!policy.preferences.enabled) return { classified: 0 };
  const runtime = await resolveJevRuntime(userId);
  let classified = 0;
  let moreRemaining = false;
  const deadline = Date.now() + 40_000;
  for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
    const page = await convexMutation<{
      items: Array<JevMailInput & { leaseId: string }>;
      moreRemaining: boolean;
    }>((api as any).jev.claimPending, { userId, limit: 12 });
    if (!page.items.length) {
      moreRemaining = false;
      break;
    }
    const items = await mapConcurrent(page.items, 4, async (input) => {
      const target = {
        accountId: input.accountId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceRevision: input.sourceRevision,
        leaseId: input.leaseId,
      };
      try {
        const result = await evaluateJev({
          apiKey: runtime.apiKey,
          state: {
            mailboxOwnerAddresses: input.selfAddresses,
            messagesOldestToNewest: input.messages,
            contextComplete: input.contextComplete,
          },
          questions: buildMailQuestions(input),
        });
        const assessment = assessmentFromResponse(input, result);
        await recordJevUsage(runtime, 'jev_mail', result);
        return { ...target, assessment };
      } catch {
        await recordJevUsage(runtime, 'jev_mail');
        return { ...target, error: 'unavailable' };
      }
    });
    const result = await convexMutation<{ stored: number }>((api as any).jev.storeAssessments, {
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
  await mutate((api as any).jev.markBriefItems, { userId, items });
}
