import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createMailDigestPost } from '../app/api/cron/mail-digest/route';
import { apnsCollapseId, buildAPNsPayload } from '../lib/notifications/apns';
import { DEFAULT_MAIL_PUSH_SETTINGS, decideMailPush } from '../lib/notifications/mail-push';
import { dispatchNativeNotification } from '../lib/notifications/native-delivery';
import { PUSH_HOURLY_LIMIT } from '../lib/obligations/contract';
import {
  deliverObligationPushes,
  pushOptions,
  releaseHeldObligationPushes,
  SUMMARY_COLLAPSE_ID,
} from '../lib/obligations/delivery';
import {
  decideObligationPush,
  type ObligationPushSettings,
  obligationPushSettingsFromRow,
  PUSH_WINDOW_MS,
  type PushCandidate,
  pushesInWindow,
  releasePlan,
  summaryCopy,
} from '../lib/obligations/push-policy';

// 2026-09-26 23:30 in New York (quiet hours 22-7) and 14:00 the next day.
const LATE = Date.parse('2026-09-27T03:30:00.000Z');
const AFTERNOON = Date.parse('2026-09-27T18:00:00.000Z');
const QUIET_END = Date.parse('2026-09-27T11:00:00.000Z');

function settings(patch: Partial<ObligationPushSettings> = {}): ObligationPushSettings {
  return {
    ...obligationPushSettingsFromRow({
      quietHoursEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      timezone: 'America/New_York',
    }),
    ...patch,
  };
}
const reply: PushCandidate = {
  kind: 'reply',
  state: 'open',
  pushLevel: 'normal',
  askerAddress: 'maya@university.test',
};

describe('push policy (decideObligationPush)', () => {
  test('preference defaults: every switch on', () => {
    expect(obligationPushSettingsFromRow(null)).toMatchObject({
      nativePushEnabled: true,
      obligationPushEnabled: true,
      codesEnabled: true,
      timezone: 'UTC',
    });
    expect(
      obligationPushSettingsFromRow({
        nativePushEnabled: false,
        obligationPushEnabled: false,
        oneTimeCodeAutofillEnabled: false,
      }),
    ).toMatchObject({ nativePushEnabled: false, obligationPushEnabled: false, codesEnabled: false });
  });

  test('closed, in-app-only, and switched-off items do not push', () => {
    const base = { settings: settings(), now: AFTERNOON, recentPushes: [] };
    expect(decideObligationPush({ ...base, obligation: { ...reply, state: 'snoozed' } })).toEqual({
      action: 'none',
      reason: 'closed',
    });
    expect(decideObligationPush({ ...base, obligation: { ...reply, pushLevel: 'none' } })).toEqual({
      action: 'none',
      reason: 'in_app_only',
    });
    expect(
      decideObligationPush({ ...base, settings: settings({ nativePushEnabled: false }), obligation: reply }),
    ).toEqual({ action: 'none', reason: 'disabled' });
    expect(
      decideObligationPush({
        ...base,
        settings: settings({ obligationPushEnabled: false }),
        obligation: reply,
      }),
    ).toEqual({ action: 'none', reason: 'disabled' });
  });

  test('a code pushes at once: quiet hours, the limit, and the push switch never hold it', () => {
    const code: PushCandidate = { kind: 'code', state: 'open', pushLevel: 'time_sensitive' };
    const full = Array.from({ length: PUSH_HOURLY_LIMIT }, (_, i) => LATE - i * 1_000);
    expect(
      decideObligationPush({
        obligation: code,
        settings: settings({ obligationPushEnabled: false }),
        now: LATE,
        recentPushes: full,
      }),
    ).toEqual({ action: 'push', timeSensitive: true, codeAvailable: true });
    expect(
      decideObligationPush({
        obligation: code,
        settings: settings({ codesEnabled: false }),
        now: LATE,
        recentPushes: [],
      }),
    ).toEqual({ action: 'none', reason: 'disabled' });
  });

  test('quiet hours hold a normal push until they end; time-sensitive and VIP items go now', () => {
    expect(
      decideObligationPush({ obligation: reply, settings: settings(), now: LATE, recentPushes: [] }),
    ).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: QUIET_END,
    });
    expect(
      decideObligationPush({
        obligation: { ...reply, pushLevel: 'time_sensitive' },
        settings: settings(),
        now: LATE,
        recentPushes: [],
      }),
    ).toEqual({ action: 'push', timeSensitive: true, codeAvailable: false });
    expect(
      decideObligationPush({
        obligation: reply,
        settings: settings({ vipSenders: ['@university.test'] }),
        now: LATE,
        recentPushes: [],
      }),
    ).toEqual({ action: 'push', timeSensitive: false, codeAvailable: false });
  });

  test('the hourly limit holds the fifth push for the summary', () => {
    const recent = [AFTERNOON - 50 * 60_000, AFTERNOON - 30 * 60_000, AFTERNOON - 20 * 60_000];
    expect(
      decideObligationPush({ obligation: reply, settings: settings(), now: AFTERNOON, recentPushes: recent }),
    ).toEqual({ action: 'push', timeSensitive: false, codeAvailable: false });
    const full = [...recent, AFTERNOON - 60_000];
    expect(
      decideObligationPush({ obligation: reply, settings: settings(), now: AFTERNOON, recentPushes: full }),
    ).toEqual({
      action: 'hold',
      reason: 'limit',
      until: AFTERNOON + 10 * 60_000,
    });
    // A summary in the last hour moves the next one out.
    expect(
      decideObligationPush({
        obligation: reply,
        settings: settings(),
        now: AFTERNOON,
        recentPushes: full,
        lastSummaryAt: AFTERNOON - 5 * 60_000,
      }),
    ).toMatchObject({ until: AFTERNOON + 55 * 60_000 });
    // Pushes older than the window do not count.
    expect(pushesInWindow([AFTERNOON - PUSH_WINDOW_MS, AFTERNOON + 1, AFTERNOON], AFTERNOON)).toEqual([
      AFTERNOON,
    ]);
  });
});

describe('held pushes (releasePlan)', () => {
  const base = { settings: settings(), now: AFTERNOON, recentPushes: [] as number[] };
  test('nothing due, or still in quiet hours: wait', () => {
    expect(releasePlan({ ...base, due: [] })).toEqual({ action: 'wait' });
    expect(releasePlan({ ...base, now: LATE, due: [{ id: 'a', reason: 'quiet_hours' }] })).toEqual({
      action: 'wait',
    });
  });

  test('one item from quiet hours pushes as itself', () => {
    expect(releasePlan({ ...base, due: [{ id: 'a', reason: 'quiet_hours' }] })).toEqual({
      action: 'single',
      id: 'a',
    });
  });

  test('more items, or items over the limit, become one summary, at most one each hour', () => {
    expect(
      releasePlan({
        ...base,
        due: [
          { id: 'a', reason: 'quiet_hours' },
          { id: 'b', reason: 'quiet_hours' },
        ],
      }),
    ).toEqual({ action: 'summary', ids: ['a', 'b'], title: 'Needs you', body: '2 things need you.' });
    expect(
      releasePlan({
        ...base,
        due: [
          { id: 'a', reason: 'limit' },
          { id: 'b', reason: 'limit' },
          { id: 'c', reason: 'limit' },
        ],
      }),
    ).toEqual({
      action: 'summary',
      ids: ['a', 'b', 'c'],
      title: 'Needs you',
      body: '3 more things need you.',
    });
    expect(
      releasePlan({
        ...base,
        recentPushes: Array.from({ length: PUSH_HOURLY_LIMIT }, () => AFTERNOON - 1_000),
        due: [{ id: 'a', reason: 'quiet_hours' }],
      }),
    ).toMatchObject({ action: 'summary', body: '1 thing needs you.' });
    expect(
      releasePlan({ ...base, lastSummaryAt: AFTERNOON - 10 * 60_000, due: [{ id: 'a', reason: 'limit' }] }),
    ).toEqual({ action: 'later', until: AFTERNOON + 50 * 60_000 });
    expect(summaryCopy(1, true)).toEqual({ title: 'Needs you', body: '1 more thing needs you.' });
  });
});

describe('APNs collapse id and the time-sensitive level', () => {
  const envelope = {
    id: 'n1',
    userId: 'u',
    type: 'obligation',
    title: 'Maya Chen',
    body: 'Reply',
    deepLink: '/mail/thread?account=a&thread=t',
  };
  test('the collapse id goes in only when it fits the 64-byte limit', () => {
    expect(apnsCollapseId({ ...envelope, collapseId: ' ob_1 ' })).toBe('ob_1');
    expect(apnsCollapseId({ ...envelope, collapseId: 'x'.repeat(65) })).toBeUndefined();
    expect(apnsCollapseId(envelope)).toBeUndefined();
  });

  test('a time-sensitive obligation takes the urgent level; a normal one does not', () => {
    expect(buildAPNsPayload({ ...envelope, timeSensitive: true }).aps).toMatchObject({
      category: 'LAB86_URGENT',
      'interruption-level': 'time-sensitive',
    });
    const normal = buildAPNsPayload(envelope);
    expect(normal.aps['interruption-level']).toBeUndefined();
    expect(normal.aps.category).toBe('LAB86_MAIL');
  });

  test('native delivery puts the collapse id and the level on the envelope', async () => {
    const envelopes: any[] = [];
    await dispatchNativeNotification(
      'u',
      'n1',
      {
        query: (async () => ({
          notification: {
            _id: 'n1',
            userId: 'u',
            title: 'T',
            body: 'B',
            deepLink: '/mail/thread?account=a&thread=t',
            type: 'obligation',
          },
          mobileDevices: [{ token: 'aa'.repeat(32), environment: 'production' }],
          deliveries: [],
          nativeDeviceDeliveries: [],
          preference: null,
        })) as any,
        mutate: (async () => null) as any,
        send: (async (sent: any) => {
          envelopes.push(sent);
          return { providerId: 'p' };
        }) as any,
      },
      { collapseId: 'ob_1', timeSensitive: true, codeAvailable: true, obligationId: 'ob_1' },
    );
    expect(envelopes[0]).toMatchObject({
      collapseId: 'ob_1',
      timeSensitive: true,
      codeAvailable: true,
      type: 'obligation',
      obligationId: 'ob_1',
    });
  });

  test('the payload names the type and the obligation for the push tap, and keeps the code flag', () => {
    const code = buildAPNsPayload({
      ...envelope,
      obligationId: 'ob_1',
      codeAvailable: true,
      timeSensitive: true,
    });
    expect(code).toMatchObject({ type: 'obligation', obligationId: 'ob_1', codeAvailable: true });
    // The hourly summary names no item: a tap opens the page.
    const summary = buildAPNsPayload({ ...envelope, collapseId: SUMMARY_COLLAPSE_ID });
    expect(summary.type).toBe('obligation');
    expect('obligationId' in summary).toBe(false);
    expect('codeAvailable' in summary).toBe(false);
    // A push without a type or an item keeps the phase 1 keys only.
    const { type: _type, ...plain } = envelope;
    const bare = buildAPNsPayload(plain);
    expect('type' in bare).toBe(false);
    expect('obligationId' in bare).toBe(false);
    expect(bare).toMatchObject({ notificationId: 'n1', accountId: 'a', threadId: 't' });
  });
});

describe('code push fix for all users (decideMailPush)', () => {
  test('a push that carries a code never waits for quiet hours or priority-only', () => {
    const quiet = {
      ...DEFAULT_MAIL_PUSH_SETTINGS,
      mode: 'priority' as const,
      quietHours: { enabled: true, start: 22, end: 7 },
      timezone: 'America/New_York',
    };
    expect(
      decideMailPush({ now: LATE, settings: quiet, from: 'x@y.com', priority: true, code: true }),
    ).toEqual({
      action: 'push',
      reason: 'code',
    });
    expect(decideMailPush({ now: LATE, settings: quiet, from: 'x@y.com', priority: true })).toMatchObject({
      action: 'hold',
    });
  });
});

function deliveryHarness(claims: any[]) {
  const dispatched: Array<{ userId: string; notificationId: string; options: any }> = [];
  const calls: Array<{ fn: string; args: any }> = [];
  let index = 0;
  const deps = {
    query: (async (fn: any, args: any) => {
      calls.push({ fn: getFunctionName(fn), args });
      return { userIds: ['u1', 'u2', 'u3', 'u4', 'u5'] };
    }) as any,
    mutate: (async (fn: any, args: any) => {
      calls.push({ fn: getFunctionName(fn), args });
      const claim = claims[index++];
      if (claim instanceof Error) throw claim;
      return claim;
    }) as any,
    dispatch: (async (userId: string, notificationId: string, _deps: any, options: any) => {
      dispatched.push({ userId, notificationId, options });
      return { sent: 1, failed: 0 };
    }) as any,
    clock: () => AFTERNOON,
  };
  return { deps, dispatched, calls };
}

describe('delivery (lib/obligations/delivery.ts)', () => {
  test('each id is claimed once; a push carries the collapse id, the code flag, and the level', async () => {
    const { deps, dispatched, calls } = deliveryHarness([
      { action: 'push', notificationId: 'n1', collapseId: 'ob1', codeAvailable: true, timeSensitive: true },
      { action: 'hold', reason: 'quiet_hours', until: QUIET_END },
      { action: 'none', reason: 'in_app_only' },
      new Error('Convex down'),
    ]);
    const outcome = await deliverObligationPushes('u', ['ob1', 'ob2', 'ob1', 'ob3', 'ob4'], deps);
    expect(outcome).toEqual({ pushed: 1, held: 1, inApp: 1, failed: 1 });
    expect(calls.map((call) => [call.fn, call.args.id, call.args.now])).toEqual([
      ['obligations:claimPush', 'ob1', AFTERNOON],
      ['obligations:claimPush', 'ob2', AFTERNOON],
      ['obligations:claimPush', 'ob3', AFTERNOON],
      ['obligations:claimPush', 'ob4', AFTERNOON],
    ]);
    expect(dispatched).toEqual([
      {
        userId: 'u',
        notificationId: 'n1',
        options: { collapseId: 'ob1', obligationId: 'ob1', codeAvailable: true, timeSensitive: true },
      },
    ]);
    expect(
      pushOptions({ notificationId: 'n', collapseId: 'c', codeAvailable: false, timeSensitive: false }),
    ).toEqual({
      collapseId: 'c',
      obligationId: 'c',
    });
  });

  test('held pushes release per user: a single push, a summary that replaces the last one, or a wait', async () => {
    const { deps, dispatched } = deliveryHarness([
      {
        kind: 'push',
        push: { notificationId: 'n1', collapseId: 'ob1', codeAvailable: false, timeSensitive: false },
      },
      { kind: 'summary', notificationId: 'n2', count: 3 },
      { kind: 'wait' },
      { kind: 'later', until: AFTERNOON + 1 },
      new Error('Convex down'),
    ]);
    expect(await releaseHeldObligationPushes(deps)).toEqual({
      users: 5,
      pushes: 1,
      summaries: 1,
      waiting: 2,
      failed: 1,
    });
    expect(dispatched).toEqual([
      { userId: 'u1', notificationId: 'n1', options: { collapseId: 'ob1', obligationId: 'ob1' } },
      { userId: 'u2', notificationId: 'n2', options: { collapseId: SUMMARY_COLLAPSE_ID } },
    ]);
  });

  test('the digest cron route releases mail digests and held obligation pushes', async () => {
    const mailDigests = async () => ({ users: 0, digests: 0, singles: 0, quiet: 0, failed: 0 });
    let released = 0;
    const route = createMailDigestPost({
      isInternalCronRequest: () => true,
      releaseDueMailDigests: mailDigests,
      releaseHeldObligationPushes: async () => {
        released += 1;
        throw new Error('logged, not raised');
      },
    });
    const response = await route(
      new NextRequest('http://localhost/api/cron/mail-digest', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(1);
  });
});
