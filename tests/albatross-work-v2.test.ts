import { describe, expect, test } from 'bun:test';
import {
  actionKeyFor,
  assignStableActionKeys,
  captureFallbackItem,
  checkinIsDue,
  fallbackEmailIsDue,
  localDateKey,
  parseClockMinutes,
  parseWorkSplit,
  projectPromotionDecision,
  shouldComposeWorkBrief,
  titleFromWorkText,
  unappliedActions,
} from '@/lib/albatross/work-v2';
import {
  isAllowedPushEndpoint,
  signNotificationLink,
  verifyNotificationLink,
} from '@/lib/notifications/delivery';

describe('Albatross Work capture', () => {
  test('fallback capture preserves an explicit Area assignment', () => {
    expect(captureFallbackItem('Ship the client release', ' area_client ')).toEqual({
      title: 'Ship the client release',
      rawText: 'Ship the client release',
      relatedAreaIds: [],
      primaryAreaId: 'area_client',
    });
    expect(captureFallbackItem('Unassigned thought')).not.toHaveProperty('primaryAreaId');
  });

  test('splits independent work without losing supplied detail', () => {
    const result = parseWorkSplit(
      JSON.stringify({
        work: [
          {
            title: 'Renew the passport',
            rawText: 'Finish my passport application before the trip.',
            primaryAreaName: 'Personal',
            relatedAreaNames: [],
          },
          {
            title: 'Ship the client release',
            rawText: 'Get the client release current and deployed.',
            primaryAreaName: 'Client work',
            relatedAreaNames: ['My apps'],
          },
        ],
      }),
      'passport and client release',
    );
    expect(result.work).toHaveLength(2);
    expect(result.work[0].rawText).toContain('passport application');
    expect(result.work[1].relatedAreaNames).toEqual(['My apps']);
  });

  test('falls back to one preserved Work item when model output is invalid', () => {
    const raw = '  Keep this exact\nmultiline dump.  ';
    const result = parseWorkSplit('not json', raw);
    expect(result.work).toHaveLength(1);
    expect(result.work[0].rawText).toBe('Keep this exact\nmultiline dump.');
  });

  test('titles remain concise', () => {
    expect(titleFromWorkText(`${'word '.repeat(40)}.`).length).toBeLessThanOrEqual(96);
  });
});

describe('Albatross Work projects and briefs', () => {
  test('three tasks promote Work into a Project/Epic', () => {
    const result = projectPromotionDecision({
      actions: [
        { kind: 'task', title: 'One' },
        { kind: 'task', title: 'Two' },
        { kind: 'task', title: 'Three' },
      ],
    });
    expect(result.promote).toBe(true);
    expect(result.reason).toContain('3 separate tasks');
  });

  test('multi-week work promotes even with fewer tasks', () => {
    const now = Date.UTC(2026, 6, 10);
    expect(
      projectPromotionDecision({
        now,
        actions: [{ kind: 'calendar_event', title: 'Follow up', startIso: '2026-07-25T15:00:00Z' }],
      }).promote,
    ).toBe(true);
  });

  test('small unscheduled errands stay lightweight', () => {
    const input = { actions: [{ kind: 'task', title: 'Pick up the package' }] };
    expect(projectPromotionDecision(input).promote).toBe(false);
    expect(shouldComposeWorkBrief(input)).toBe(false);
  });

  test('action identities are stable and source-sensitive', () => {
    const action = {
      kind: 'task',
      title: 'Prepare the release',
      sourceRefs: [{ kind: 'mail_thread', id: 'thread-1' }],
    };
    expect(actionKeyFor(action)).toBe(actionKeyFor({ ...action }));
    expect(actionKeyFor(action)).not.toBe(
      actionKeyFor({ ...action, sourceRefs: [{ kind: 'mail_thread', id: 'thread-2' }] }),
    );
    expect(assignStableActionKeys([action])[0].actionKey).toStartWith('action-');
  });

  test('reconciliation skips already-created actions but retries undone ones', () => {
    const actions = assignStableActionKeys([
      { kind: 'task', title: 'Draft outline' },
      { kind: 'task', title: 'Review outline' },
    ]);
    expect(
      unappliedActions(actions, [
        { status: 'applied', artifacts: [{ actionKey: actions[0].actionKey }] },
      ]).map((action) => action.title),
    ).toEqual(['Review outline']);
    expect(
      unappliedActions(actions, [{ status: 'undone', artifacts: [{ actionKey: actions[0].actionKey }] }]),
    ).toHaveLength(2);
  });
});

describe('Albatross evening check-ins', () => {
  test('defaults and clock parsing are bounded', () => {
    expect(parseClockMinutes('19:00')).toBe(19 * 60);
    expect(parseClockMinutes('99:00')).toBe(19 * 60);
  });

  test('fires inside the configured local-time window', () => {
    const preference = {
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      emailFallbackDelayMinutes: 90,
      timezone: 'America/New_York',
    };
    expect(checkinIsDue(preference, new Date('2026-07-10T23:05:00Z'))).toBe(true);
    expect(checkinIsDue(preference, new Date('2026-07-10T22:55:00Z'))).toBe(false);
    expect(localDateKey(preference.timezone, new Date('2026-07-11T01:00:00Z'))).toBe('2026-07-10');
  });

  test('fallback email waits and is suppressed by an answer', () => {
    const created = Date.UTC(2026, 6, 10, 23, 0);
    expect(
      fallbackEmailIsDue({ checkinCreatedAt: created, delayMinutes: 90, now: created + 89 * 60_000 }),
    ).toBe(false);
    expect(
      fallbackEmailIsDue({ checkinCreatedAt: created, delayMinutes: 90, now: created + 90 * 60_000 }),
    ).toBe(true);
    expect(
      fallbackEmailIsDue({
        checkinCreatedAt: created,
        answeredAt: created + 10_000,
        delayMinutes: 90,
        now: created + 120 * 60_000,
      }),
    ).toBe(false);
  });
});

describe('Albatross notification links', () => {
  test('signatures bind notification, user, redirect, and expiry', () => {
    const previous = process.env.LAB86_NOTIFICATION_LINK_SECRET;
    process.env.LAB86_NOTIFICATION_LINK_SECRET = 'test-notification-secret';
    try {
      const now = 1_800_000_000_000;
      const expiresAt = now + 60_000;
      const signature = signNotificationLink('notice-1', 'user-1', '/?checkin=one', expiresAt);
      expect(verifyNotificationLink('notice-1', 'user-1', '/?checkin=one', signature, expiresAt, now)).toBe(
        true,
      );
      expect(verifyNotificationLink('notice-1', 'user-2', '/?checkin=one', signature, expiresAt, now)).toBe(
        false,
      );
      expect(verifyNotificationLink('notice-1', 'user-1', '/?checkin=two', signature, expiresAt, now)).toBe(
        false,
      );
      expect(
        verifyNotificationLink('notice-1', 'user-1', '/?checkin=one', signature, expiresAt, expiresAt),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
      else process.env.LAB86_NOTIFICATION_LINK_SECRET = previous;
    }
  });

  test('push subscriptions only accept approved HTTPS services', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://db5p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1/push')).toBe(false);
    expect(isAllowedPushEndpoint('not a url')).toBe(false);
  });

  test('notification links do not reuse the Convex internal secret', () => {
    const previousNotification = process.env.LAB86_NOTIFICATION_LINK_SECRET;
    const previousConvex = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'must-not-sign-notification-links';
    try {
      expect(signNotificationLink('notice-1', 'user-1', '/', Date.now() + 60_000)).toBe('');
    } finally {
      if (previousNotification === undefined) delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
      else process.env.LAB86_NOTIFICATION_LINK_SECRET = previousNotification;
      if (previousConvex === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousConvex;
    }
  });
});
