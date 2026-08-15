import { describe, expect, test } from 'bun:test';
import {
  dailyCheckinAnswerPayload,
  dailyCheckinDraftHydration,
  dailyCheckinResponseError,
  dailyCheckinSectionPayload,
} from '@/components/albatross/DailyCheckin';
import {
  checkinCallerArgs,
  checkinRetryDelayMs,
  parseCheckinReconciliation,
  tomorrowWorkPlanStatus,
} from '@/lib/albatross/checkin';

describe('Albatross check-in server caller', () => {
  test('passes the authenticated Clerk user through to internal-secret Convex calls', () => {
    expect(checkinCallerArgs(' user_123 ')).toEqual({ userId: 'user_123' });
    expect(() => checkinCallerArgs(' ')).toThrow('userId is required');
  });

  test('retries an interrupted tomorrow plan but never duplicates applied work or its question', () => {
    expect(tomorrowWorkPlanStatus(null)).toBe('advance');
    expect(tomorrowWorkPlanStatus({ plan: { status: 'ready' }, questions: [] })).toBe('advance');
    expect(tomorrowWorkPlanStatus({ plan: { status: 'applied' }, questions: [] })).toBe('already_applied');
    expect(
      tomorrowWorkPlanStatus({
        plan: { status: 'needs_answers' },
        questions: [{ status: 'pending' }],
      }),
    ).toBe('needs_input');
  });
});

describe('daily check-in answer payload', () => {
  const checkin = {
    _id: 'checkin-1',
    localDate: '2026-08-14',
    status: 'open',
    candidateItems: [
      { kind: 'work' as const, id: 'work-1', title: 'Renew passport' },
      { kind: 'event' as const, id: 'event-1', title: 'Passport appointment' },
    ],
  };

  test('submits a tomorrow-only check-in without inventing completed work', () => {
    expect(
      dailyCheckinAnswerPayload(
        checkin,
        new Set(),
        '   ',
        '  Submit the passport renewal before lunch.  ',
        'America/New_York',
      ),
    ).toEqual({
      responseText: '',
      tomorrowIntentText: 'Submit the passport renewal before lunch.',
      completed: [],
      timezone: 'America/New_York',
    });
  });

  test('includes only explicitly selected candidate evidence', () => {
    expect(
      dailyCheckinAnswerPayload(checkin, new Set(['event:event-1']), ' Appointment done. ', '', 'UTC'),
    ).toEqual({
      responseText: 'Appointment done.',
      tomorrowIntentText: '',
      completed: [{ kind: 'event', id: 'event-1' }],
      timezone: 'UTC',
    });
  });

  test('builds independently saveable section payloads', () => {
    expect(
      dailyCheckinSectionPayload(
        checkin,
        'reflection',
        ' Appointment done. ',
        new Set(['event:event-1']),
        'UTC',
      ),
    ).toEqual({
      promptKind: 'reflection',
      responseText: 'Appointment done.',
      completed: [{ kind: 'event', id: 'event-1' }],
      timezone: 'UTC',
    });
    expect(dailyCheckinSectionPayload(checkin, 'tomorrow', ' Call the DMV. ', new Set(), 'UTC')).toEqual({
      promptKind: 'tomorrow',
      responseText: 'Call the DMV.',
      timezone: 'UTC',
    });
  });

  test('reports only durable-write failures to the form', () => {
    expect(dailyCheckinResponseError(true, {})).toBeNull();
    expect(dailyCheckinResponseError(false, { error: 'Try later.' })).toBe('Try later.');
  });

  test('a saved reflection never overwrites an unsaved tomorrow draft', () => {
    const next = dailyCheckinDraftHydration({
      previousCheckinId: 'checkin-1',
      checkinId: 'checkin-1',
      previousSavedReflection: 'Started the form.',
      savedReflection: 'Submitted the form.',
      previousSavedTomorrow: null,
      savedTomorrow: null,
      currentReflection: 'Submitted the form.',
      currentTomorrow: 'Call the county clerk before lunch.',
      reflectionDirty: false,
      tomorrowDirty: true,
    });

    expect(next).toMatchObject({
      checkinChanged: false,
      hydrateReflection: true,
      hydrateTomorrow: false,
      reflection: 'Submitted the form.',
      tomorrow: 'Call the county clerk before lunch.',
    });
  });
});

describe('check-in background work', () => {
  test('parses only bounded candidate identities from the model envelope', () => {
    expect(parseCheckinReconciliation('before {"completed":[{"kind":"work","id":"work-1"}]} after')).toEqual({
      completed: [{ kind: 'work', id: 'work-1' }],
    });
    expect(parseCheckinReconciliation('not json')).toEqual({ completed: [] });
    expect(parseCheckinReconciliation('{not json}')).toEqual({ completed: [] });
    const rows = Array.from({ length: 65 }, (_, index) => ({ kind: 'work', id: `work-${index}` }));
    const bounded = parseCheckinReconciliation(JSON.stringify({ completed: rows }));
    expect(bounded.completed).toHaveLength(60);
    expect(bounded.completed.at(-1)).toEqual({ kind: 'work', id: 'work-59' });
    expect(
      parseCheckinReconciliation(
        JSON.stringify({ completed: [{ kind: 'k'.repeat(80), id: 'i'.repeat(300) }] }),
      ).completed[0],
    ).toEqual({ kind: 'k'.repeat(40), id: 'i'.repeat(160) });
  });

  test('backs retries off without exceeding one hour', () => {
    expect(checkinRetryDelayMs(1)).toBe(120_000);
    expect(checkinRetryDelayMs(3)).toBe(480_000);
    expect(checkinRetryDelayMs(99)).toBe(3_600_000);
  });
});
