// Needs you push delivery (docs/needs-you.md, "Delivery rules"; phase 1 S4).
// The Convex claim decides each push in one transaction (quiet hours, VIP
// senders, the hourly limit, the switches) and writes the notification row of
// type `obligation`: title = the asker, body = the obligation title, and the
// deep link of the source thread. This module sends the APNs push with the
// obligation id as the collapse id. A failed push never fails the caller:
// the obligation is in the app either way.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { dispatchNativeNotification, type NativeDeliveryOptions } from '../notifications/native-delivery';

/** The collapse id of the hourly summary push: a new summary replaces the old one. */
export const SUMMARY_COLLAPSE_ID = 'needs-you-summary';

interface ClaimedPush {
  notificationId: string;
  collapseId: string;
  codeAvailable: boolean;
  timeSensitive: boolean;
}

type ClaimResult =
  | ({ action: 'push' } & ClaimedPush)
  | { action: 'hold'; reason: string; until: number }
  | { action: 'none'; reason: string };

type HeldClaimResult =
  | { kind: 'wait' }
  | { kind: 'later'; until: number }
  | { kind: 'push'; push: ClaimedPush }
  | { kind: 'summary'; notificationId: string; count: number };

export interface ObligationDeliveryDependencies {
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  dispatch: typeof dispatchNativeNotification;
  clock?: () => number;
}

const defaultDependencies: ObligationDeliveryDependencies = {
  query: convexQuery,
  mutate: convexMutation,
  dispatch: dispatchNativeNotification,
};

export function pushOptions(push: ClaimedPush): NativeDeliveryOptions {
  return {
    collapseId: push.collapseId,
    ...(push.codeAvailable ? ({ codeAvailable: true } as const) : {}),
    ...(push.timeSensitive ? ({ timeSensitive: true } as const) : {}),
  };
}

/** Decides and sends the push of each obligation id that a sync returned. */
export async function deliverObligationPushes(
  userId: string,
  ids: readonly string[],
  deps: ObligationDeliveryDependencies = defaultDependencies,
) {
  const outcome = { pushed: 0, held: 0, inApp: 0, failed: 0 };
  for (const id of [...new Set(ids)]) {
    try {
      const claim = await deps.mutate<ClaimResult>(api.obligations.claimPush, {
        userId,
        id,
        now: (deps.clock ?? Date.now)(),
      });
      if (claim.action === 'push') {
        await deps.dispatch(userId, claim.notificationId, undefined, pushOptions(claim));
        outcome.pushed += 1;
      } else if (claim.action === 'hold') outcome.held += 1;
      else outcome.inApp += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/**
 * Releases the held obligation pushes of each user with a due hold. The
 * Convex mail digest cron calls the route that runs this every 15 minutes.
 */
export async function releaseHeldObligationPushes(
  deps: ObligationDeliveryDependencies = defaultDependencies,
) {
  const now = (deps.clock ?? Date.now)();
  const { userIds } = await deps.query<{ userIds: string[] }>(api.obligations.dueHeldUsers, {
    now,
    limit: 500,
  });
  const outcome = { users: userIds.length, pushes: 0, summaries: 0, waiting: 0, failed: 0 };
  for (const userId of userIds) {
    try {
      const claim = await deps.mutate<HeldClaimResult>(api.obligations.claimHeldPushes, { userId, now });
      if (claim.kind === 'push') {
        await deps.dispatch(userId, claim.push.notificationId, undefined, pushOptions(claim.push));
        outcome.pushes += 1;
      } else if (claim.kind === 'summary') {
        await deps.dispatch(userId, claim.notificationId, undefined, { collapseId: SUMMARY_COLLAPSE_ID });
        outcome.summaries += 1;
      } else outcome.waiting += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}
