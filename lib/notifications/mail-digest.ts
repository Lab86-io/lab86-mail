import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { inQuietHours, type MailPushSettings, mailPushSettingsFromRow } from './mail-push';
import { dispatchNativeNotification } from './native-delivery';

// Sends held mail pushes (FEATURES item 12). The Convex cron calls the
// mail-digest route when a hold is due; Jev classification calls
// promoteHeldPriorityMail when held mail turns out to need a reply.

const notificationsApi = (api as any).albatrossNotifications;

export interface MailDigestDependencies {
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  dispatch: typeof dispatchNativeNotification;
  clock?: () => number;
}

const defaultDependencies: MailDigestDependencies = {
  query: convexQuery,
  mutate: convexMutation,
  dispatch: dispatchNativeNotification,
};

async function settingsFor(userId: string, deps: MailDigestDependencies): Promise<MailPushSettings> {
  const settings = await deps
    .query<MailPushSettings | null>(notificationsApi.mailPushSettings, { userId })
    .catch(() => null);
  return settings?.quietHours ? settings : mailPushSettingsFromRow(null);
}

/** Sends one digest (or the single held push) for each user with a due hold. */
export async function releaseDueMailDigests(deps: MailDigestDependencies = defaultDependencies) {
  const now = (deps.clock ?? Date.now)();
  const { userIds } = await deps.query<{ userIds: string[] }>(notificationsApi.dueMailDigestUsers, {
    now,
    limit: 500,
  });
  const outcome = { users: userIds.length, digests: 0, singles: 0, quiet: 0, failed: 0 };
  for (const userId of userIds) {
    try {
      // A priority hold can come due inside quiet hours; it waits for the end.
      if (inQuietHours(now, await settingsFor(userId, deps))) {
        outcome.quiet += 1;
        continue;
      }
      const claim = await deps.mutate<{ kind: 'none' | 'single' | 'digest'; notificationId?: string }>(
        notificationsApi.claimMailDigest,
        { userId, now },
      );
      if (claim.kind === 'none' || !claim.notificationId) continue;
      if (claim.kind === 'digest') outcome.digests += 1;
      else outcome.singles += 1;
      await deps.dispatch(userId, claim.notificationId).catch(() => undefined);
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/**
 * Pushes held mail whose thread Jev now marks as needing a reply or an
 * action. Runs after a classification sweep; quiet hours still hold it.
 */
export async function promoteHeldPriorityMail(
  userId: string,
  deps: MailDigestDependencies = defaultDependencies,
) {
  const now = (deps.clock ?? Date.now)();
  const settings = await settingsFor(userId, deps);
  if (settings.mode !== 'priority' || inQuietHours(now, settings)) return { pushed: 0 };
  const { notificationIds } = await deps.query<{ notificationIds: string[] }>(
    notificationsApi.priorityHeldMail,
    { userId },
  );
  let pushed = 0;
  for (const notificationId of notificationIds) {
    const released = await deps.mutate<{ released: boolean }>(notificationsApi.releaseHeldMailPush, {
      userId,
      notificationId,
    });
    if (!released.released) continue;
    await deps.dispatch(userId, notificationId).catch(() => undefined);
    pushed += 1;
  }
  return { pushed };
}
