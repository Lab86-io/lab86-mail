// The real dependencies of the Needs you actions: Done, Later, Not mine, and
// Undo. The API routes (app/api/obligations/shared.ts) and the chat tools
// (lib/tools/needs-you.ts) both give them to runObligationAction, so the two
// paths have one set of rules.

import { briefSteeringCorrection } from '../brief/steering';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { cancelOutbox } from '../send/outbox';
import { needsYouFlagFor } from './contract';
import type { ObligationActionDependencies, ObligationRecord } from './service';

export const obligationActionDefaults: ObligationActionDependencies = {
  flag: (userId) => needsYouFlagFor(userId),
  get: (userId, id) => convexQuery<ObligationRecord | null>(api.obligations.get, { userId, id }),
  act: (input) => convexMutation(api.obligations.act, input),
  correctionFor: (target) =>
    briefSteeringCorrection(
      { mode: 'not_for_me', account: target.accountId, threadId: target.threadId },
      null,
    ),
  cancelSend: (userId, pendingId) => cancelOutbox(userId, pendingId),
};
