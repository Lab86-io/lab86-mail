import { describe, expect, test } from 'bun:test';
import {
  briefFreshness,
  briefIsStale,
  type Capacity,
  dayShapeLine,
  dayWindow,
  eventWindowLabel,
  fixedSchedule,
  needsYouToday,
  openWork,
  readyToMove,
  type TodayEvent,
  type TodayWork,
  todayDateline,
  waitingOnSomebody,
} from '../lib/albatross/today';

const work = (over: Partial<TodayWork>): TodayWork => ({
  _id: over._id || 'w',
  title: over.title ?? 'Something',
  rawText: over.rawText ?? 'raw',
  workState: 'workState' in over ? over.workState : 'active',
  agentState: over.agentState ?? null,
  status: over.status ?? 'ready',
  openQuestions: over.openQuestions ?? 0,
  updatedAt: over.updatedAt ?? 1,
  areaName: over.areaName ?? null,
  nextStep: over.nextStep ?? null,
  scheduledStartAt: over.scheduledStartAt ?? null,
  scheduledEndAt: over.scheduledEndAt ?? null,
});

const event = (over: Partial<TodayEvent>): TodayEvent => ({
  _id: over._id || 'e',
  title: over.title ?? 'Meeting',
  startAt: over.startAt ?? 0,
  endAt: over.endAt ?? 0,
  allDay: over.allDay ?? false,
  location: over.location ?? null,
  status: 'status' in over ? over.status : null,
});

describe('dayWindow', () => {
  test('covers midnight to midnight in the viewer clock', () => {
    const noon = new Date(2026, 7, 2, 12, 30).getTime();
    const { startAt, endAt } = dayWindow(noon);
    expect(new Date(startAt).getHours()).toBe(0);
    expect(new Date(startAt).getDate()).toBe(2);
    expect(endAt - startAt).toBe(24 * 60 * 60 * 1000);
  });
});

describe('needsYouToday', () => {
  test('is the short list, ordered by how much is waiting', () => {
    const result = needsYouToday(
      [
        work({ _id: 'one', openQuestions: 1 }),
        work({ _id: 'three', openQuestions: 3 }),
        work({ _id: 'quiet' }),
      ],
      [],
    );
    expect(result.work.map((row) => row._id)).toEqual(['three', 'one']);
  });

  test('only counts approvals that are actually still waiting', () => {
    const result = needsYouToday(
      [],
      [
        { _id: 'a', title: 'Send the 1099', status: 'pending' },
        { _id: 'b', title: 'Already decided', status: 'approved' },
      ],
    );
    expect(result.approvals.map((row) => row._id)).toEqual(['a']);
  });

  test('a put-down Albatross never appears, even with open questions', () => {
    const result = needsYouToday([work({ workState: 'archived', openQuestions: 3 })], []);
    expect(result.work).toEqual([]);
  });
});

describe('readyToMove', () => {
  const rows = Array.from({ length: 8 }, (_, index) => work({ _id: `w${index}`, updatedAt: index }));

  test('never repeats what already appears under Needs you', () => {
    const { items } = readyToMove(
      [work({ _id: 'asks', openQuestions: 2 }), work({ _id: 'quiet' })],
      'normal',
    );
    expect(items.map((row) => row._id)).toEqual(['quiet']);
  });

  test('leaves out what is waiting, paused or finished', () => {
    const { items } = readyToMove(
      [
        work({ _id: 'waiting', workState: 'waiting' }),
        work({ _id: 'paused', workState: 'paused' }),
        work({ _id: 'done', workState: 'done' }),
        work({ _id: 'live' }),
      ],
      'normal',
    );
    expect(items.map((row) => row._id)).toEqual(['live']);
  });

  test('capacity changes how much is put in front of the user', () => {
    const counts: Record<Capacity, number> = {
      low: readyToMove(rows, 'low').items.length,
      normal: readyToMove(rows, 'normal').items.length,
      high: readyToMove(rows, 'high').items.length,
    };
    expect(counts.low).toBe(1);
    expect(counts.normal).toBe(3);
    expect(counts.high).toBe(6);
    expect(counts.low).toBeLessThan(counts.normal);
    expect(counts.normal).toBeLessThan(counts.high);
  });

  test('says how much it held back, rather than dropping it quietly', () => {
    // A cap that hides without saying so is a list of overdue work in a nicer
    // coat. The surface offers the remainder; it never silently truncates.
    const low = readyToMove(rows, 'low');
    expect(low.items).toHaveLength(1);
    expect(low.heldBack).toBe(7);
    expect(low.items.length + low.heldBack).toBe(openWork(rows).length);

    const high = readyToMove(rows, 'high');
    expect(high.items.length + high.heldBack).toBe(openWork(rows).length);
  });

  test('holds nothing back when everything already fits', () => {
    const few = [work({ _id: 'a' }), work({ _id: 'b' })];
    expect(readyToMove(few, 'normal').heldBack).toBe(0);
  });

  test('does not offer Work today when Albatross already put its next step on the calendar', () => {
    const now = Date.parse('2026-08-11T13:00:00Z');
    const { items, heldBack } = readyToMove(
      [work({ _id: 'booked', scheduledEndAt: now + 60 * 60_000 }), work({ _id: 'open' })],
      'normal',
      now,
    );
    expect(items.map((row) => row._id)).toEqual(['open']);
    expect(heldBack).toBe(0);
  });

  test('offers Work again after its calendar hold ends', () => {
    const end = Date.parse('2026-08-11T14:00:00Z');
    const rows = [work({ _id: 'booked', scheduledEndAt: end })];
    expect(readyToMove(rows, 'normal', end - 1).items).toEqual([]);
    expect(readyToMove(rows, 'normal', end).items.map((row) => row._id)).toEqual(['booked']);
  });
});

describe('waitingOnSomebody', () => {
  test('gathers waiting and blocked, newest movement first', () => {
    const items = waitingOnSomebody([
      work({ _id: 'old', workState: 'waiting', updatedAt: 1 }),
      work({ _id: 'new', workState: 'blocked', updatedAt: 9 }),
      work({ _id: 'live' }),
    ]);
    expect(items.map((row) => row._id)).toEqual(['new', 'old']);
  });
});

describe('fixedSchedule', () => {
  test('drops cancelled events — they are not part of anybody day', () => {
    const items = fixedSchedule([
      event({ _id: 'gone', status: 'cancelled', startAt: 1 }),
      event({ _id: 'real', startAt: 2 }),
    ]);
    expect(items.map((row) => row._id)).toEqual(['real']);
  });

  test('all-day events sit above timed ones', () => {
    const items = fixedSchedule([
      event({ _id: 'timed', startAt: 5 }),
      event({ _id: 'allday', allDay: true, startAt: 9 }),
    ]);
    expect(items.map((row) => row._id)).toEqual(['allday', 'timed']);
  });

  test('an all-day event says so rather than printing a fake window', () => {
    expect(eventWindowLabel(event({ allDay: true }))).toBe('All day');
  });
});

describe('dayShapeLine', () => {
  test('an empty day says so, and does not invent work', () => {
    expect(dayShapeLine({ needsYouCount: 0, eventCount: 0, capacity: 'normal' })).toBe(
      'Nothing needs you and nothing is booked. The day is yours.',
    );
  });

  test('a day with carried work does not claim to be empty', () => {
    // Live defect: the header read "The day is yours" while "Could move today"
    // showed an Albatross underneath it — a system not reading its own page.
    expect(dayShapeLine({ needsYouCount: 0, eventCount: 0, capacity: 'normal', carryingCount: 1 })).toBe(
      'Nothing needs you today. Albatross is carrying one thing on its own.',
    );
    expect(dayShapeLine({ needsYouCount: 0, eventCount: 0, capacity: 'normal', carryingCount: 3 })).toContain(
      'carrying 3 things',
    );
  });

  test('counts read as sentences, not as tallies', () => {
    expect(dayShapeLine({ needsYouCount: 1, eventCount: 2, capacity: 'normal' })).toBe(
      'One thing needs you, and 2 things are booked.',
    );
  });

  test('capacity colours the sentence without scolding', () => {
    const low = dayShapeLine({ needsYouCount: 1, eventCount: 0, capacity: 'low' });
    expect(low).toContain('Keeping the rest light.');
    const high = dayShapeLine({ needsYouCount: 1, eventCount: 0, capacity: 'high' });
    expect(high).toContain('There is room for more.');
  });

  test('never uses the words that make a plan feel like a debt', () => {
    for (const capacity of ['low', 'normal', 'high'] as Capacity[]) {
      for (const needsYouCount of [0, 1, 4]) {
        const line = dayShapeLine({ needsYouCount, eventCount: 2, capacity }).toLowerCase();
        expect(line).not.toContain('overdue');
        expect(line).not.toContain('behind');
        expect(line).not.toContain('should');
        expect(line).not.toContain('failed');
      }
    }
  });
});

describe('brief freshness', () => {
  const now = new Date(2026, 7, 2, 12, 0).getTime();

  test('says nothing when no brief has ever been written', () => {
    expect(briefFreshness(null, now)).toBeNull();
    expect(briefIsStale(null, now)).toBe(false);
  });

  test('says plainly how old it is', () => {
    expect(briefFreshness(now - 30 * 60_000, now)).toBe('Written just now');
    expect(briefFreshness(now - 3 * 3_600_000, now)).toBe('Written 3 hours ago');
    expect(briefFreshness(now - 26 * 3_600_000, now)).toBe('Written yesterday');
    expect(briefFreshness(now - 24 * 24 * 3_600_000, now)).toBe('Written 24 days ago');
  });

  test('a brief describing an older day is called stale', () => {
    // The audit found one presenting a 24-day-old day under a "Live" label.
    expect(briefIsStale(now - 24 * 24 * 3_600_000, now)).toBe(true);
    expect(briefIsStale(now - 6 * 3_600_000, now)).toBe(false);
  });
});

describe('todayDateline', () => {
  test('reads as a date a person would say out loud', () => {
    expect(todayDateline(new Date(2026, 7, 2, 9, 0).getTime())).toBe('Sunday, August 2');
  });
});
