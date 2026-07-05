import { describe, expect, test } from 'bun:test';
import {
  areaHasNoLinks,
  areaHomeSections,
  formatEventTime,
  RAIL_AREA_CAP,
  railAreaBadge,
  railAreaRows,
  taskRowMeta,
} from '../lib/albatross/area-home';

const counts = (mail: number, events: number, tasks: number, verified = 0, candidate = 0) => ({
  mail,
  events,
  tasks,
  facts: { verified, candidate },
});

// Local-time constructors keep assertions independent of the machine timezone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();

describe('areaHomeSections', () => {
  test('always returns the four sections in fixed order', () => {
    const sections = areaHomeSections(counts(3, 0, 2, 1, 1));
    expect(sections.map((s) => s.id)).toEqual(['mail', 'events', 'tasks', 'context']);
    expect(sections.map((s) => s.label)).toEqual(['Mail', 'Events', 'Tasks', 'Context']);
  });

  test('carries per-section counts; context sums verified and candidate facts', () => {
    const sections = areaHomeSections(counts(7, 2, 5, 3, 4));
    expect(sections.find((s) => s.id === 'mail')?.count).toBe(7);
    expect(sections.find((s) => s.id === 'events')?.count).toBe(2);
    expect(sections.find((s) => s.id === 'tasks')?.count).toBe(5);
    expect(sections.find((s) => s.id === 'context')?.count).toBe(7);
  });

  test('empty sections still render (count 0), never dropped', () => {
    const sections = areaHomeSections(counts(0, 0, 0));
    expect(sections).toHaveLength(4);
    expect(sections.every((s) => s.count === 0)).toBe(true);
  });
});

describe('areaHasNoLinks', () => {
  test('true only when mail, events, and tasks are all empty', () => {
    expect(areaHasNoLinks(counts(0, 0, 0))).toBe(true);
    expect(areaHasNoLinks(counts(0, 0, 0, 5, 2))).toBe(true); // facts alone are not links
    expect(areaHasNoLinks(counts(1, 0, 0))).toBe(false);
    expect(areaHasNoLinks(counts(0, 1, 0))).toBe(false);
    expect(areaHasNoLinks(counts(0, 0, 1))).toBe(false);
  });
});

describe('railAreaRows', () => {
  const areas = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `a${i}`, name: `Area ${i}` }));

  test('short lists pass through with no overflow', () => {
    const { rows, overflow } = railAreaRows(areas(3));
    expect(rows).toHaveLength(3);
    expect(overflow).toBe(0);
  });

  test('caps at RAIL_AREA_CAP and reports the overflow count', () => {
    const { rows, overflow } = railAreaRows(areas(12));
    expect(rows).toHaveLength(RAIL_AREA_CAP);
    expect(rows[0]._id).toBe('a0');
    expect(rows[RAIL_AREA_CAP - 1]._id).toBe(`a${RAIL_AREA_CAP - 1}`);
    expect(overflow).toBe(12 - RAIL_AREA_CAP);
  });

  test('exactly at the cap shows all rows without an overflow row', () => {
    const { rows, overflow } = railAreaRows(areas(RAIL_AREA_CAP));
    expect(rows).toHaveLength(RAIL_AREA_CAP);
    expect(overflow).toBe(0);
  });

  test('undefined and null inputs behave as empty lists', () => {
    expect(railAreaRows(undefined)).toEqual({ rows: [], overflow: 0 });
    expect(railAreaRows(null)).toEqual({ rows: [], overflow: 0 });
  });

  test('a custom cap is respected', () => {
    const { rows, overflow } = railAreaRows(areas(5), 2);
    expect(rows).toHaveLength(2);
    expect(overflow).toBe(3);
  });
});

describe('railAreaBadge', () => {
  test('shows the candidate (awaiting confirmation) count', () => {
    expect(railAreaBadge({ verified: 4, candidate: 3 } as any)).toBe('3');
    expect(railAreaBadge({ candidate: 1 })).toBe('1');
  });

  test('zero, missing, or malformed counts render nothing', () => {
    expect(railAreaBadge({ verified: 9, candidate: 0 } as any)).toBeNull();
    expect(railAreaBadge({})).toBeNull();
    expect(railAreaBadge(undefined)).toBeNull();
    expect(railAreaBadge(null)).toBeNull();
    expect(railAreaBadge({ candidate: Number.NaN })).toBeNull();
    expect(railAreaBadge({ candidate: -2 })).toBeNull();
  });

  test('caps at 99+', () => {
    expect(railAreaBadge({ candidate: 99 })).toBe('99');
    expect(railAreaBadge({ candidate: 100 })).toBe('99+');
    expect(railAreaBadge({ candidate: 4000 })).toBe('99+');
  });
});

describe('formatEventTime', () => {
  test('timed same-day event: day plus a time range', () => {
    const out = formatEventTime(at(2026, 6, 8, 14, 0), at(2026, 6, 8, 15, 30), false);
    expect(out).toBe('Wed, Jul 8 · 2:00 PM – 3:30 PM');
  });

  test('timed event crossing midnight names both days', () => {
    const out = formatEventTime(at(2026, 6, 8, 22, 0), at(2026, 6, 9, 1, 0), false);
    expect(out).toBe('Wed, Jul 8 10:00 PM – Thu, Jul 9 1:00 AM');
  });

  test('single all-day event (midnight-to-midnight) reads as one day', () => {
    const out = formatEventTime(at(2026, 6, 8), at(2026, 6, 9), true);
    expect(out).toBe('Wed, Jul 8 · all day');
  });

  test('multi-day all-day event shows the inclusive date range', () => {
    const out = formatEventTime(at(2026, 6, 8), at(2026, 6, 11), true);
    expect(out).toBe('Wed, Jul 8 – Fri, Jul 10 · all day');
  });
});

describe('taskRowMeta', () => {
  const now = at(2026, 6, 8, 12, 0);

  test('completed tasks are done regardless of due date', () => {
    const meta = taskRowMeta({ completedAt: at(2026, 6, 5), dueAt: at(2026, 6, 1) }, now);
    expect(meta.state).toBe('done');
    expect(meta.label).toBe('Done Jul 5');
  });

  test('future due date reads as due', () => {
    const meta = taskRowMeta({ completedAt: null, dueAt: at(2026, 6, 12) }, now);
    expect(meta.state).toBe('due');
    expect(meta.label).toBe('Due Jul 12');
  });

  test('past due date reads as overdue with the missed date', () => {
    const meta = taskRowMeta({ completedAt: null, dueAt: at(2026, 6, 1) }, now);
    expect(meta.state).toBe('overdue');
    expect(meta.label).toBe('Overdue · Jul 1');
  });

  test('open task without a due date stays quiet', () => {
    const meta = taskRowMeta({ completedAt: null, dueAt: null }, now);
    expect(meta.state).toBe('open');
    expect(meta.label).toBe('No due date');
  });
});
