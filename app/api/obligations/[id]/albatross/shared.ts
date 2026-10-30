import { captureWork } from '@/lib/albatross/capture-work';
import { startStepRun } from '@/lib/albatross/step-run-start';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import type { ObligationAlbatrossDependencies, ObligationLinkResult } from '@/lib/obligations/albatross';
import { needsYouFlagFor } from '@/lib/obligations/contract';
import type { ObligationRecord } from '@/lib/obligations/service';

// The real dependencies of "Start in Albatross"
// (lib/obligations/albatross.ts). The web route and the mobile route use the
// same ones.

export const obligationAlbatrossDefaults: ObligationAlbatrossDependencies = {
  flag: (userId) => needsYouFlagFor(userId),
  get: (userId, id) => convexQuery<ObligationRecord | null>(api.obligations.get, { userId, id }),
  link: (input) => convexMutation<ObligationLinkResult>(api.obligationViews.linkWork, input),
  runs: async (userId, workId) =>
    (await convexQuery<Array<{ id: string; state: string }> | null>(
      api.albatrossStepRuns.runsForWorkHistory,
      {
        userId,
        workId,
      },
    )) || [],
  steer: (input) =>
    convexMutation<boolean>(api.albatrossStepRuns.steer, {
      userId: input.userId,
      id: input.runId,
      text: input.note,
    }),
  startRun: (input) =>
    startStepRun({ userId: input.userId, workId: input.workId, trigger: 'user', note: input.note }),
  capture: (caller, item) =>
    captureWork(
      { rawText: item.rawText, source: 'text', reviewedItems: [item] },
      { userId: caller.userId, email: caller.email ?? '', name: caller.name ?? '', source: 'clerk' },
    ),
};
