import { describe, expect, test } from 'bun:test';
import {
  mailSourceKey,
  NEEDS_YOU_GROUP_ORDER,
  needsYouFlagFor,
  type ObligationView,
} from '../lib/obligations/contract';
import {
  NEEDS_YOU_FIXTURE_NOW,
  NEEDS_YOU_FIXTURE_TIMEZONE,
  needsYouFixture,
} from '../lib/obligations/fixtures';
import {
  compareEntries,
  groupNeedsYou,
  isClosedObligation,
  laterOptions,
  type NeedsYouEntry,
  type NeedsYouExtraLike,
  needsYouSummary,
  nextCodeExpiry,
  obligationGroup,
  settleExpiredCodes,
  threadObligations,
  withObligationOverrides,
} from '../lib/obligations/groups';

/* The groups of the Needs you page (docs/needs-you-phase-1.md, W1). */

const TZ = NEEDS_YOU_FIXTURE_TIMEZONE;
// Wednesday, October 28, 2026, 11:05 AM in Los Angeles.
const NOW = NEEDS_YOU_FIXTURE_NOW;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Midnight in Los Angeles on October 28 (PDT, UTC-7).
const START_OF_TODAY = Date.UTC(2026, 9, 28, 7, 0, 0);

const item = (overrides: Partial<ObligationView> & { id: string }): ObligationView => ({
  kind: 'reply',
  state: 'open',
  source: 'mail',
  sourceKey: `mail:acct:${overrides.id}`,
  title: 'Asks for a reply.',
  asker: 'Ada Example',
  due: 'none',
  pushLevel: 'normal',
  probability: 0.9,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  ...overrides,
});
const extra = (overrides: Partial<NeedsYouExtraLike> & { id: string }): NeedsYouExtraLike => ({
  kind: 'question',
  attention: true,
  createdAt: NOW - 2 * HOUR,
  ...overrides,
});
const group = (obligation: ObligationView) => obligationGroup(obligation, NOW, TZ);

describe('which group an obligation sits in', () => {
  test('closed today stays, closed before today hides', () => {
    expect(group(item({ id: 'a', state: 'done', closedAt: START_OF_TODAY + HOUR }))).toBe('closed_today');
    expect(group(item({ id: 'b', state: 'resolved', closedAt: START_OF_TODAY - 1 }))).toBeNull();
    // Without a close time, the last change stands in for it.
    expect(group(item({ id: 'c', state: 'expired', updatedAt: START_OF_TODAY + 1 }))).toBe('closed_today');
    expect(isClosedObligation(item({ id: 'd', state: 'dismissed' }))).toBe(true);
    expect(isClosedObligation(item({ id: 'e', state: 'snoozed' }))).toBe(false);
  });

  test('a snoozed item hides until its time, then reads as open', () => {
    expect(group(item({ id: 'a', state: 'snoozed', snoozedUntil: NOW + HOUR }))).toBeNull();
    expect(group(item({ id: 'b', state: 'snoozed', snoozedUntil: NOW - 1 }))).toBe('no_date');
    expect(group(item({ id: 'c', state: 'snoozed' }))).toBe('no_date');
  });

  test('waiting, codes, time-sensitive changes, and overdue items', () => {
    expect(group(item({ id: 'a', kind: 'waiting' }))).toBe('waiting');
    expect(group(item({ id: 'b', kind: 'code', code: { value: '123456' } }))).toBe('now');
    expect(group(item({ id: 'c', kind: 'change', pushLevel: 'time_sensitive', due: 'later' }))).toBe('now');
    expect(group(item({ id: 'd', dueAt: NOW - 1 }))).toBe('now');
  });

  test('phase 1.1: a change is Now only while it is time-sensitive and new', () => {
    const hot = { kind: 'change' as const, pushLevel: 'time_sensitive' as const };
    expect(group(item({ id: 'a', ...hot, createdAt: NOW - 47 * HOUR }))).toBe('now');
    // Older than CHANGE_NOW_WINDOW_MS: Today, whatever the due word says.
    expect(group(item({ id: 'b', ...hot, createdAt: NOW - 49 * HOUR, due: 'later' }))).toBe('today');
    expect(group(item({ id: 'c', ...hot, createdAt: NOW - 3 * DAY, due: 'none' }))).toBe('today');
    // A change that is not time-sensitive never sits in Now, not even past its due time.
    expect(group(item({ id: 'd', kind: 'change', pushLevel: 'normal', dueAt: NOW - 1 }))).toBe('today');
    expect(group(item({ id: 'e', kind: 'change', pushLevel: 'none', due: 'soon' }))).toBe('this_week');
    expect(group(item({ id: 'f', kind: 'change', pushLevel: 'none', due: 'none' }))).toBe('no_date');
    expect(group(item({ id: 'g', kind: 'change', pushLevel: 'normal', dueAt: NOW + HOUR }))).toBe('today');
  });

  test('a concrete due time decides the day', () => {
    expect(group(item({ id: 'a', dueAt: NOW + HOUR }))).toBe('today');
    expect(group(item({ id: 'b', dueAt: START_OF_TODAY + DAY + HOUR }))).toBe('this_week');
    expect(group(item({ id: 'c', dueAt: START_OF_TODAY + 6 * DAY + HOUR }))).toBe('this_week');
    expect(group(item({ id: 'd', dueAt: START_OF_TODAY + 7 * DAY + HOUR }))).toBe('after_this_week');
    // The concrete time wins over the word.
    expect(group(item({ id: 'e', due: 'today', dueAt: START_OF_TODAY + 10 * DAY }))).toBe('after_this_week');
  });

  test('without a time, the due word decides', () => {
    expect(group(item({ id: 'a', due: 'today' }))).toBe('today');
    expect(group(item({ id: 'b', due: 'soon' }))).toBe('this_week');
    expect(group(item({ id: 'c', due: 'later' }))).toBe('after_this_week');
    expect(group(item({ id: 'd', due: 'none' }))).toBe('no_date');
  });

  test('an invalid time zone falls back to the device clock and does not throw', () => {
    expect(obligationGroup(item({ id: 'a', due: 'today' }), NOW, 'Not/AZone')).toBe('today');
  });
});

describe('the list', () => {
  test('groups come in display order, empty groups are left out, Albatross items join', () => {
    const groups = groupNeedsYou(
      [
        item({ id: 'later', due: 'later' }),
        item({ id: 'today', due: 'today' }),
        item({ id: 'done', state: 'done', closedAt: NOW - HOUR }),
        item({ id: 'wait', kind: 'waiting' }),
      ],
      [
        extra({ id: 'question:1' }),
        extra({ id: 'approval:1', kind: 'approval', createdAt: NOW - 3 * HOUR }),
        extra({ id: 'checkin:1', kind: 'checkin' }),
        extra({ id: 'update:1', kind: 'update' }),
        extra({ id: 'question:old', attention: false }),
      ],
      NOW,
      TZ,
    );
    expect(groups.map((entry) => entry.id)).toEqual([
      'now',
      'today',
      'after_this_week',
      'waiting',
      'closed_today',
    ]);
    expect(groups.map((entry) => entry.label)).toEqual([
      'Now',
      'Today',
      'After this week',
      'Waiting on others',
      'Closed today',
    ]);
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['question:1', 'approval:1']);
    expect(groups[1].entries.map((entry) => entry.id)).toEqual(['today', 'checkin:1']);
    const order = groups.map((entry) => NEEDS_YOU_GROUP_ORDER.indexOf(entry.id));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('dated items come first by date, then the newest first, ties by id', () => {
    const entries: NeedsYouEntry[] = [
      { type: 'obligation', id: 'b', obligation: item({ id: 'b', createdAt: NOW - 3 * HOUR }) },
      { type: 'obligation', id: 'a', obligation: item({ id: 'a', createdAt: NOW - 3 * HOUR }) },
      { type: 'obligation', id: 'new', obligation: item({ id: 'new', createdAt: NOW - HOUR }) },
      { type: 'obligation', id: 'late', obligation: item({ id: 'late', dueAt: NOW + 5 * HOUR }) },
      { type: 'obligation', id: 'soon', obligation: item({ id: 'soon', dueAt: NOW + HOUR }) },
      { type: 'albatross', id: 'q', item: extra({ id: 'q', createdAt: undefined }) },
    ];
    expect([...entries].sort(compareEntries).map((entry) => entry.id)).toEqual([
      'soon',
      'late',
      'new',
      'a',
      'b',
      'q',
    ]);
    // Two dated items with the same time fall through to recency.
    const sameDue = [
      {
        type: 'obligation',
        id: 'x',
        obligation: item({ id: 'x', dueAt: NOW + HOUR, createdAt: NOW - HOUR }),
      },
      { type: 'obligation', id: 'y', obligation: item({ id: 'y', dueAt: NOW + HOUR, createdAt: NOW }) },
    ] as NeedsYouEntry[];
    expect(sameDue.sort(compareEntries).map((entry) => entry.id)).toEqual(['y', 'x']);
  });

  test('closed rows sort by their close time, newest first', () => {
    const groups = groupNeedsYou(
      [
        item({ id: 'first', state: 'done', closedAt: NOW - 3 * HOUR, createdAt: NOW - HOUR }),
        item({ id: 'second', state: 'done', closedAt: NOW - HOUR, createdAt: NOW - 5 * HOUR }),
      ],
      [],
      NOW,
      TZ,
    );
    expect(groups[0].entries.map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  test('the summary counts now, open, and closed today', () => {
    const fixture = needsYouFixture(NOW, TZ);
    const groups = groupNeedsYou(fixture.items, fixture.extras, NOW, TZ);
    expect(groups.map((entry) => entry.id)).toEqual([
      'now',
      'today',
      'this_week',
      'after_this_week',
      'no_date',
      'waiting',
      'closed_today',
    ]);
    expect(needsYouSummary(groups)).toEqual({ now: 3, open: 19, closedToday: 5 });
    expect(needsYouSummary([])).toEqual({ now: 0, open: 0, closedToday: 0 });
  });

  test('the fixture spreads the connected sources and the calendar over the groups', () => {
    const fixture = needsYouFixture(NOW, TZ);
    const groups = groupNeedsYou(fixture.items, [], NOW, TZ);
    const ids = Object.fromEntries(groups.map((entry) => [entry.id, entry.entries.map((row) => row.id)]));
    expect(ids.now).toEqual(['ob_code_now', 'ob_flight']);
    // The GitHub review has a due time, so it leads Today; the old card failure sits here, not in Now.
    expect(ids.today).toEqual([
      'ob_github_491',
      'ob_pipeline',
      'ob_prepare',
      'ob_review',
      'ob_granola_nda',
      'ob_card',
    ]);
    expect(ids.this_week).toEqual([
      'ob_rsvp',
      'ob_jira_lab212',
      'ob_slack_numbers',
      'ob_sow',
      'ob_nda',
      'ob_drive_memo',
    ]);
    expect(ids.closed_today).toContain('ob_pipeline_passed');
  });
});

describe('what the user just did', () => {
  test('an override wins while it is newer than the server row', () => {
    const server = item({ id: 'a', updatedAt: NOW });
    const newer = { ...server, state: 'done' as const, updatedAt: NOW + 1 };
    const older = { ...server, state: 'done' as const, updatedAt: NOW - 1 };
    expect(withObligationOverrides([server], new Map([['a', newer]]))[0].state).toBe('done');
    expect(withObligationOverrides([server], new Map([['a', older]]))[0].state).toBe('open');
    expect(withObligationOverrides([server], new Map())[0]).toBe(server);
  });

  test('a thread shows its items in time order and hides a snoozed one', () => {
    const items = [
      item({ id: 'late', createdAt: NOW - HOUR }),
      item({ id: 'early', createdAt: NOW - DAY }),
      item({ id: 'tie', createdAt: NOW - HOUR }),
      item({ id: 'snoozed', state: 'snoozed', snoozedUntil: NOW + HOUR, createdAt: NOW - 2 * DAY }),
      item({ id: 'woke', state: 'snoozed', snoozedUntil: NOW - 1, createdAt: NOW - 3 * DAY }),
    ];
    expect(threadObligations(items, NOW).map((row) => row.id)).toEqual(['woke', 'early', 'late', 'tie']);
  });
});

describe('the Later menu', () => {
  test('in the morning: later today, tomorrow at 9, next Monday at 9', () => {
    const options = laterOptions(NOW, TZ);
    expect(options.map((option) => [option.id, option.label])).toEqual([
      ['later_today', 'Later today'],
      ['tomorrow_morning', 'Tomorrow morning'],
      ['next_week', 'Next week'],
    ]);
    expect(options[0].until).toBe(NOW + 3 * HOUR);
    expect(options[1].until).toBe(Date.UTC(2026, 9, 29, 16, 0, 0));
    // November 2 is the next Monday; PST starts November 1, so 9 AM is 17:00 UTC.
    expect(options[2].until).toBe(Date.UTC(2026, 10, 2, 17, 0, 0));
  });

  test('late in the evening, "later today" would be tomorrow, so it goes', () => {
    const evening = Date.UTC(2026, 9, 29, 5, 30, 0); // 10:30 PM on October 28 in Los Angeles
    expect(laterOptions(evening, TZ).map((option) => option.id)).toEqual(['tomorrow_morning', 'next_week']);
  });

  test('on a Monday, next week means the Monday after', () => {
    const monday = Date.UTC(2026, 10, 2, 18, 0, 0);
    const next = laterOptions(monday, TZ).find((option) => option.id === 'next_week');
    expect(next?.until).toBe(Date.UTC(2026, 10, 9, 17, 0, 0));
  });
});

describe('the flag', () => {
  test('LAB86_NEEDS_YOU is off when empty, on for all, or on for the listed ids', () => {
    expect(needsYouFlagFor('user_1', '')).toBe(false);
    expect(needsYouFlagFor('user_1', undefined)).toBe(false);
    expect(needsYouFlagFor('', 'all')).toBe(false);
    expect(needsYouFlagFor('user_1', 'ALL')).toBe(true);
    expect(needsYouFlagFor('user_2', 'user_1, user_2')).toBe(true);
    expect(needsYouFlagFor('user_3', 'user_1,user_2')).toBe(false);
    expect(mailSourceKey('acct', 'thread')).toBe('mail:acct:thread');
  });
});

describe('code expiry on an open page', () => {
  const code = (id: string, expiresAt?: number, state: ObligationView['state'] = 'open') =>
    item({
      id,
      kind: 'code',
      state,
      code: { value: '482913', ...(expiresAt === undefined ? {} : { expiresAt }) },
    });

  test('an open code past its expiry reads as expired and leaves Now', () => {
    const [expired, live, noExpiry, reply] = settleExpiredCodes(
      [code('old', NOW - 1), code('live', NOW + 5 * 60_000), code('none'), item({ id: 'r' })],
      NOW,
    );
    expect(expired).toMatchObject({ state: 'expired', closeReason: 'expired', closedAt: NOW - 1 });
    expect(group(expired)).toBe('closed_today');
    expect(live.state).toBe('open');
    expect(noExpiry.state).toBe('open');
    expect(reply.state).toBe('open');
  });

  test('a closed code keeps its own close reason', () => {
    const [used] = settleExpiredCodes([code('used', NOW - 1, 'done')], NOW);
    expect(used.state).toBe('done');
    expect(used.closeReason).toBeUndefined();
  });

  test('the next wake is the soonest open code expiry after now', () => {
    expect(
      nextCodeExpiry(
        [
          code('past', NOW - 1),
          code('late', NOW + 9 * 60_000),
          code('soon', NOW + 2 * 60_000),
          code('closed', NOW + 60_000, 'expired'),
        ],
        NOW,
      ),
    ).toBe(NOW + 2 * 60_000);
    expect(nextCodeExpiry([code('none'), item({ id: 'r' })], NOW)).toBeUndefined();
  });
});
