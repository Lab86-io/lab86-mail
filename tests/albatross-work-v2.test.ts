import { describe, expect, test } from 'bun:test';
import {
  actionKeyFor,
  assignStableActionKeys,
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
import { signNotificationLink, verifyNotificationLink } from '@/lib/notifications/delivery';

describe('Albatross Work capture', () => {
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
  test('signatures bind notification, user, and redirect', () => {
    const previous = process.env.LAB86_NOTIFICATION_LINK_SECRET;
    process.env.LAB86_NOTIFICATION_LINK_SECRET = 'test-notification-secret';
    try {
      const signature = signNotificationLink('notice-1', 'user-1', '/?checkin=one');
      expect(verifyNotificationLink('notice-1', 'user-1', '/?checkin=one', signature)).toBe(true);
      expect(verifyNotificationLink('notice-1', 'user-2', '/?checkin=one', signature)).toBe(false);
      expect(verifyNotificationLink('notice-1', 'user-1', '/?checkin=two', signature)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_NOTIFICATION_LINK_SECRET;
      else process.env.LAB86_NOTIFICATION_LINK_SECRET = previous;
    }
  });
});
