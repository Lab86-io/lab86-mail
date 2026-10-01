// Direct Google push: make, renew, and stop the Gmail watches and the
// Calendar and Drive channels of one user (docs/google-direct-transport.md,
// "Push"). The hourly Convex cron googlePush:renewalTick calls
// /api/cron/google-push for each user, and that route runs
// `reconcileGooglePush`.
//
// - With a flag on, each live target gets its watch or channel: a Gmail watch
//   for each connected direct mailbox (renewed each day), a Calendar channel
//   for each calendar of those mailboxes, and a Drive channel for each
//   connected Google Drive connection when content indexing is on. A channel
//   gets a replacement two days before it ends; then the old one stops.
// - With a flag off, the rows of that kind stop at Google and go. This is
//   the rollback: set the flag to 0, and within one hour no watch or channel
//   of that kind stays.
// - A row whose mailbox, calendar, or connection is gone stops and goes. A
//   row whose sign-in is gone cannot stop at Google; it goes, and Google ends
//   it at its expiration (at most 7 days). The push routes ignore messages
//   that have no row.
// - When a push flag is on, a disconnect stops the push of its grant or
//   connection first (`stopGooglePushForGrant`, `stopDrivePushForConnection`),
//   while the sign-in still works.

import { randomUUID } from 'node:crypto';
import { getCloudFileAccess } from '@/lib/files/connections';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { hashChannelToken, newChannelToken } from './channel-token';
import { anyGooglePushEnabled, gmailPushConfig, googlePushAddress, googlePushFlags } from './config';
import {
  driveStartPageToken,
  stopCalendarChannel,
  stopDriveChannel,
  stopGmailMailbox,
  watchCalendarEvents,
  watchDriveChanges,
  watchGmailMailbox,
} from './google-api';
import {
  channelRenewDue,
  type GooglePushKind,
  type GooglePushStatus,
  gmailWatchDue,
  PUSH_CHANNEL_TTL_MS,
  PUSH_RETRY_AFTER_FAILURE_MS,
  PUSH_RETRY_AFTER_UNSUPPORTED_MS,
  pushRowLive,
} from './rules';

/** The most watch calls in one run for one user. The rest wait for the next run. */
export const MAX_REGISTRATIONS_PER_RUN = 40;

export interface PlanChannel {
  userId: string;
  kind: GooglePushKind;
  channelId: string;
  accountId?: string;
  grantId?: string;
  calendarId?: string;
  connectionId?: string;
  resourceId?: string;
  status: GooglePushStatus;
  expiration?: number;
  requestedAt: number;
  renewedAt?: number;
  lastMessageAt?: number;
  retryAfter?: number;
  unsupported?: boolean;
}

interface PlanAccount {
  accountId: string;
  grantId: string;
  email: string;
  status: string;
}

interface PlanDrive {
  connectionId: string;
  status: string;
  pageToken?: string;
}

export interface GooglePushPlan {
  accounts: PlanAccount[];
  calendars: Array<{ accountId: string; calendarId: string }>;
  drives: PlanDrive[];
  contentEnabled: boolean;
  channels: PlanChannel[];
}

export interface GooglePushReconcileSummary {
  registered: number;
  renewed: number;
  failed: number;
  stopped: number;
  removed: number;
  skipped?: 'busy';
}

const defaults = {
  flags: () => googlePushFlags(),
  gmailConfig: () => gmailPushConfig(),
  address: (kind: 'calendar' | 'drive') => googlePushAddress(kind),
  query: convexQuery,
  mutate: convexMutation,
  watchGmailMailbox,
  stopGmailMailbox,
  watchCalendarEvents,
  stopCalendarChannel,
  watchDriveChanges,
  stopDriveChannel,
  driveStartPageToken,
  driveAccessToken: async (userId: string, connectionId: string): Promise<string | null> =>
    (await getCloudFileAccess({ userId, connectionId }))?.accessToken ?? null,
  newChannelId: (): string => randomUUID(),
  newChannelToken,
  now: () => Date.now(),
};

type Deps = typeof defaults;
let deps: Deps = defaults;
const running = new Set<string>();

export function __setGooglePushRenewalDepsForTest(overrides: Partial<Deps> = {}) {
  deps = { ...defaults, ...overrides };
  running.clear();
}

function errorText(err: unknown): string {
  const status = Number((err as { statusCode?: unknown })?.statusCode);
  const message = (err as Error)?.message || String(err);
  return Number.isFinite(status) && status > 0 ? `${status}: ${message}` : message;
}

/** Google cannot watch this calendar: a holiday or a birthday calendar answers so. */
function unsupportedChannel(err: unknown): boolean {
  const reason = String((err as { reason?: unknown })?.reason || '');
  const message = String((err as Error)?.message || '');
  return (
    reason === 'pushNotSupportedForRequestedResource' || /push notifications are not supported/i.test(message)
  );
}

interface RunContext {
  userId: string;
  plan: GooglePushPlan;
  now: number;
  budget: number;
  summary: GooglePushReconcileSummary;
  remove: Set<string>;
}

function liveAccounts(plan: GooglePushPlan) {
  return new Map(
    plan.accounts.filter((row) => row.status === 'connected').map((row) => [row.accountId, row]),
  );
}

/** Stops a Calendar or Drive channel at Google when it can, and marks the row to go. */
async function retireChannel(run: RunContext, row: PlanChannel) {
  run.remove.add(row.channelId);
  if (row.status === 'failed' || !row.resourceId) return;
  const target = { channelId: row.channelId, resourceId: row.resourceId };
  try {
    if (row.kind === 'calendar') {
      const account = row.accountId ? liveAccounts(run.plan).get(row.accountId) : undefined;
      // Only the grant that made the channel can stop it.
      if (!account || account.grantId !== row.grantId) return;
      await deps.stopCalendarChannel(account.grantId, target);
    } else if (row.kind === 'drive') {
      const known = run.plan.drives.some((drive) => drive.connectionId === row.connectionId);
      if (!known || !row.connectionId) return;
      const accessToken = await deps.driveAccessToken(run.userId, row.connectionId);
      if (!accessToken) return;
      await deps.stopDriveChannel(accessToken, target);
    }
    run.summary.stopped += 1;
  } catch (err) {
    console.warn(
      `[google-push] could not stop a ${row.kind} channel; it ends at its expiration`,
      errorText(err),
    );
  }
}

async function reconcileGmail(run: RunContext, enabled: boolean) {
  const config = enabled ? deps.gmailConfig() : null;
  const live = liveAccounts(run.plan);
  const rows = run.plan.channels.filter((row) => row.kind === 'gmail');
  if (config) {
    const byAccount = new Map(rows.map((row) => [row.accountId, row]));
    for (const account of live.values()) {
      const row = byAccount.get(account.accountId);
      if (row && row.grantId === account.grantId && !gmailWatchDue(row, run.now)) continue;
      if (run.budget <= 0) break;
      run.budget -= 1;
      const channelId = row?.channelId ?? deps.newChannelId();
      await deps.mutate(api.googlePush.beginRegistration, {
        userId: run.userId,
        kind: 'gmail',
        channelId,
        accountId: account.accountId,
        grantId: account.grantId,
      });
      try {
        const watch = await deps.watchGmailMailbox(account.grantId, config.topic);
        await deps.mutate(api.googlePush.finishRegistration, {
          userId: run.userId,
          channelId,
          outcome: 'active',
          expiration: watch.expiration,
          ...(watch.historyId ? { historyId: watch.historyId } : {}),
        });
        if (row) run.summary.renewed += 1;
        else run.summary.registered += 1;
      } catch (err) {
        console.warn(`[google-push] Gmail watch failed for ${account.accountId}`, errorText(err));
        await deps.mutate(api.googlePush.finishRegistration, {
          userId: run.userId,
          channelId,
          outcome: 'failed',
          error: errorText(err),
          retryAfter: run.now + PUSH_RETRY_AFTER_FAILURE_MS,
        });
        run.summary.failed += 1;
      }
    }
  }
  for (const row of rows) {
    const account = row.accountId ? live.get(row.accountId) : undefined;
    if (config && account) continue;
    run.remove.add(row.channelId);
    // Only a live sign-in can stop the watch. Without one, the watch ends by
    // itself within 7 days, and the route finds no direct account for it.
    if (!config && account && account.grantId === row.grantId && row.status !== 'failed') {
      try {
        await deps.stopGmailMailbox(account.grantId);
        run.summary.stopped += 1;
      } catch (err) {
        console.warn('[google-push] could not stop a Gmail watch; it ends at its expiration', errorText(err));
      }
    }
  }
}

/**
 * One slot (a calendar, or a Drive connection): keep the newest row, make a
 * new channel when it is due, and retire the rest. The newest live active
 * row stays until a newer row is active.
 */
async function settleSlot(
  run: RunContext,
  rows: PlanChannel[],
  stale: (row: PlanChannel) => boolean,
  register: () => Promise<PlanChannel | null>,
) {
  const mine = rows.filter((row) => !stale(row)).sort((a, b) => b.requestedAt - a.requestedAt);
  for (const row of rows) if (stale(row)) await retireChannel(run, row);
  let newest: PlanChannel | undefined = mine[0];
  if (channelRenewDue(newest, run.now) && run.budget > 0) {
    run.budget -= 1;
    const created = await register();
    if (created) newest = created;
  }
  const keep = new Set<string>();
  if (newest) keep.add(newest.channelId);
  if (newest?.status !== 'active') {
    const live = mine.find((row) => pushRowLive(row, run.now));
    if (live) keep.add(live.channelId);
  }
  for (const row of mine) if (!keep.has(row.channelId)) await retireChannel(run, row);
}

/**
 * Makes one Calendar or Drive channel. Returns the new row, active or failed,
 * or null when nothing was written.
 */
async function registerChannel(
  run: RunContext,
  kind: 'calendar' | 'drive',
  scope: { accountId?: string; grantId?: string; calendarId?: string; connectionId?: string },
  watch: (channel: { id: string; token: string; address: string; expiration: number }) => Promise<{
    resourceId: string;
    expiration: number;
  }>,
): Promise<PlanChannel | null> {
  const address = deps.address(kind);
  if (!address) return null;
  const channelId = deps.newChannelId();
  const token = deps.newChannelToken();
  const begun = await deps.mutate<{ requestedAt: number }>(api.googlePush.beginRegistration, {
    userId: run.userId,
    kind,
    channelId,
    tokenHash: hashChannelToken(token),
    ...scope,
  });
  const base: PlanChannel = {
    userId: run.userId,
    kind,
    channelId,
    ...scope,
    status: 'pending',
    requestedAt: Number(begun?.requestedAt) || run.now,
  };
  try {
    const result = await watch({ id: channelId, token, address, expiration: run.now + PUSH_CHANNEL_TTL_MS });
    await deps.mutate(api.googlePush.finishRegistration, {
      userId: run.userId,
      channelId,
      outcome: 'active',
      resourceId: result.resourceId,
      expiration: result.expiration,
    });
    run.summary.registered += 1;
    return { ...base, status: 'active', resourceId: result.resourceId, expiration: result.expiration };
  } catch (err) {
    const unsupported = unsupportedChannel(err);
    if (!unsupported) console.warn(`[google-push] ${kind} watch failed`, errorText(err));
    const retryAfter =
      run.now + (unsupported ? PUSH_RETRY_AFTER_UNSUPPORTED_MS : PUSH_RETRY_AFTER_FAILURE_MS);
    await deps.mutate(api.googlePush.finishRegistration, {
      userId: run.userId,
      channelId,
      outcome: 'failed',
      error: errorText(err),
      retryAfter,
      ...(unsupported ? { unsupported: true } : {}),
    });
    run.summary.failed += 1;
    return { ...base, status: 'failed', retryAfter, ...(unsupported ? { unsupported: true } : {}) };
  }
}

async function reconcileCalendars(run: RunContext, enabled: boolean) {
  const live = liveAccounts(run.plan);
  const rows = run.plan.channels.filter((row) => row.kind === 'calendar');
  const wanted = enabled ? run.plan.calendars.filter((calendar) => live.has(calendar.accountId)) : [];
  const slotKey = (accountId?: string, calendarId?: string) => `${accountId}\n${calendarId}`;
  const wantedKeys = new Set(wanted.map((calendar) => slotKey(calendar.accountId, calendar.calendarId)));
  for (const calendar of wanted) {
    const account = live.get(calendar.accountId) as PlanAccount;
    const slot = rows.filter(
      (row) => row.accountId === calendar.accountId && row.calendarId === calendar.calendarId,
    );
    await settleSlot(
      run,
      slot,
      // A row of another grant (a rollback and a new switch) cannot stop or renew.
      (row) => row.grantId !== account.grantId,
      () =>
        registerChannel(
          run,
          'calendar',
          { accountId: account.accountId, grantId: account.grantId, calendarId: calendar.calendarId },
          (channel) => deps.watchCalendarEvents(account.grantId, calendar.calendarId, channel),
        ),
    );
  }
  for (const row of rows) {
    if (!wantedKeys.has(slotKey(row.accountId, row.calendarId))) await retireChannel(run, row);
  }
}

async function reconcileDrives(run: RunContext, enabled: boolean) {
  const rows = run.plan.channels.filter((row) => row.kind === 'drive');
  const wanted =
    enabled && run.plan.contentEnabled ? run.plan.drives.filter((drive) => drive.status === 'connected') : [];
  const wantedIds = new Set(wanted.map((drive) => drive.connectionId));
  for (const drive of wanted) {
    const slot = rows.filter((row) => row.connectionId === drive.connectionId);
    await settleSlot(
      run,
      slot,
      () => false,
      async () => {
        let accessToken: string | null;
        try {
          accessToken = await deps.driveAccessToken(run.userId, drive.connectionId);
        } catch (err) {
          console.warn('[google-push] no Drive access for a channel', errorText(err));
          return null;
        }
        if (!accessToken) return null;
        const token = accessToken;
        return await registerChannel(run, 'drive', { connectionId: drive.connectionId }, async (channel) =>
          deps.watchDriveChanges(token, drive.pageToken || (await deps.driveStartPageToken(token)), channel),
        );
      },
    );
  }
  for (const row of rows) {
    if (!row.connectionId || !wantedIds.has(row.connectionId)) await retireChannel(run, row);
  }
}

/** One renewal pass for one user. */
export async function reconcileGooglePush(userId: string): Promise<GooglePushReconcileSummary> {
  const summary: GooglePushReconcileSummary = {
    registered: 0,
    renewed: 0,
    failed: 0,
    stopped: 0,
    removed: 0,
  };
  if (running.has(userId)) return { ...summary, skipped: 'busy' };
  running.add(userId);
  try {
    const flags = deps.flags();
    const plan = await deps.query<GooglePushPlan>(api.googlePush.userPlan, { userId });
    const run: RunContext = {
      userId,
      plan,
      now: deps.now(),
      budget: MAX_REGISTRATIONS_PER_RUN,
      summary,
      remove: new Set(),
    };
    await reconcileGmail(run, flags.gmail);
    await reconcileCalendars(run, flags.calendar);
    await reconcileDrives(run, flags.drive);
    if (run.remove.size) {
      const result = await deps.mutate<{ removed: number }>(api.googlePush.removeChannels, {
        userId,
        channelIds: [...run.remove],
      });
      summary.removed = Number(result?.removed) || 0;
    }
    return summary;
  } finally {
    running.delete(userId);
  }
}

/**
 * Before a direct grant goes (grants.destroy): stop its Gmail watch and its
 * Calendar channels while the sign-in still works, and delete the rows. A
 * Gmail stop ends the watch of the whole mailbox, so it is left out while
 * another connected direct account has the same address. This never throws.
 */
export async function stopGooglePushForGrant(grantId: string): Promise<void> {
  // With all flags off, the renewal cron has stopped (or soon stops) every
  // row, and the routes ignore all messages, so a disconnect reads nothing.
  if (!anyGooglePushEnabled(deps.flags())) return;
  try {
    const plan = await deps.query<{ userId: string; sharedMailbox: boolean; channels: PlanChannel[] } | null>(
      api.googlePush.stopPlanForGrant,
      { grantId },
    );
    if (!plan?.channels?.length) return;
    let gmailStopped = false;
    for (const row of plan.channels) {
      try {
        if (row.kind === 'gmail' && !plan.sharedMailbox && !gmailStopped && row.status !== 'failed') {
          gmailStopped = true;
          await deps.stopGmailMailbox(grantId);
        } else if (row.kind === 'calendar' && row.resourceId && row.status !== 'failed') {
          await deps.stopCalendarChannel(grantId, { channelId: row.channelId, resourceId: row.resourceId });
        }
      } catch (err) {
        console.warn(`[google-push] could not stop a ${row.kind} push before the disconnect`, errorText(err));
      }
    }
    await deps.mutate(api.googlePush.removeChannels, {
      userId: plan.userId,
      channelIds: plan.channels.map((row) => row.channelId),
    });
  } catch (err) {
    console.warn('[google-push] push cleanup before the disconnect failed', errorText(err));
  }
}

/** Before a Drive connection goes: stop its channels and delete the rows. This never throws. */
export async function stopDrivePushForConnection(userId: string, connectionId: string): Promise<void> {
  if (!anyGooglePushEnabled(deps.flags())) return;
  try {
    const rows = await deps.query<PlanChannel[]>(api.googlePush.channelsForConnection, {
      userId,
      connectionId,
    });
    if (!rows?.length) return;
    const accessToken = await deps.driveAccessToken(userId, connectionId).catch(() => null);
    for (const row of rows) {
      if (!accessToken || !row.resourceId || row.status === 'failed') continue;
      await deps
        .stopDriveChannel(accessToken, { channelId: row.channelId, resourceId: row.resourceId })
        .catch((err) => console.warn('[google-push] could not stop a Drive channel', errorText(err)));
    }
    await deps.mutate(api.googlePush.removeChannels, {
      userId,
      channelIds: rows.map((row) => row.channelId),
    });
  } catch (err) {
    console.warn('[google-push] Drive push cleanup failed', errorText(err));
  }
}
