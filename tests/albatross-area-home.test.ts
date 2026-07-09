import { describe, expect, test } from 'bun:test';
import {
  AREA_PLACE_CAP,
  areaHasNoLinks,
  areaHomeSections,
  areaNeedsYouRows,
  areaPulse,
  extractAreaPlaces,
  formatEventTime,
  intentDisplayTitle,
  mapsSearchUrl,
  planActionLabel,
  planStatusMeta,
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

// ---------------------------------------------------------------------------
// Area Brief helpers
// ---------------------------------------------------------------------------

const planRow = (over: Partial<Parameters<typeof areaNeedsYouRows>[0]['plans'][number]> = {}) => ({
  intentId: 'i1',
  title: 'Plan a trip',
  status: 'planning',
  planId: 'p1',
  planStatus: null,
  outcome: null,
  summary: null,
  proposedProjectTitle: null,
  updatedAt: 0,
  ...over,
});

describe('areaPulse', () => {
  test('only non-zero facets, in fixed meaning-first order', () => {
    const segments = areaPulse({ needsYou: 2, plans: 0, projects: 1, places: 3, upcoming: 0 });
    expect(segments.map((s) => s.id)).toEqual(['needsYou', 'projects', 'places']);
    expect(segments.map((s) => s.label)).toEqual(['2 need you', '1 project', '3 places']);
  });

  test('singular vs plural wording per facet', () => {
    const segments = areaPulse({ needsYou: 1, plans: 1, projects: 1, places: 1, upcoming: 1 });
    expect(segments.map((s) => s.label)).toEqual([
      '1 needs you',
      '1 active plan',
      '1 project',
      '1 place',
      '1 upcoming',
    ]);
  });

  test('a fully quiet area yields no segments (strip hides)', () => {
    expect(areaPulse({ needsYou: 0, plans: 0, projects: 0, places: 0, upcoming: 0 })).toEqual([]);
  });
});

describe('planStatusMeta', () => {
  test('needs_answers outranks the intent status for tone', () => {
    expect(planStatusMeta('planning', 'needs_answers')).toEqual({
      label: 'Needs answers',
      tone: 'attention',
    });
    expect(planStatusMeta('needs_answers')).toEqual({ label: 'Needs answers', tone: 'attention' });
  });

  test('maps each known intent status to a label and tone', () => {
    expect(planStatusMeta('captured').tone).toBe('neutral');
    expect(planStatusMeta('planning').tone).toBe('active');
    expect(planStatusMeta('ready').tone).toBe('ready');
    expect(planStatusMeta('applied').tone).toBe('active');
    expect(planStatusMeta('done').tone).toBe('done');
    expect(planStatusMeta('archived').tone).toBe('neutral');
  });

  test('unknown status falls back to a neutral echo', () => {
    expect(planStatusMeta('weird')).toEqual({ label: 'weird', tone: 'neutral' });
    expect(planStatusMeta('')).toEqual({ label: 'Plan', tone: 'neutral' });
  });
});

describe('planActionLabel', () => {
  test('the verb matches the next user move', () => {
    expect(planActionLabel('needs_answers')).toBe('Answer questions');
    expect(planActionLabel('planning', 'needs_answers')).toBe('Answer questions');
    expect(planActionLabel('ready')).toBe('Review plan');
    expect(planActionLabel('applied')).toBe('Open plan');
    expect(planActionLabel('done')).toBe('Open plan');
    expect(planActionLabel('captured')).toBe('Open');
  });
});

describe('intentDisplayTitle', () => {
  test('prefers the explicit title', () => {
    expect(intentDisplayTitle({ title: '  Book flights ', rawText: 'ignore me' })).toBe('Book flights');
  });

  test('falls back to a one-line, collapsed slice of raw text', () => {
    expect(intentDisplayTitle({ title: '', rawText: 'plan\n  the   whole   week' })).toBe(
      'plan the whole week',
    );
  });

  test('truncates a long raw dump with an ellipsis', () => {
    const raw = 'a'.repeat(120);
    const out = intentDisplayTitle({ rawText: raw });
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  test('never empty', () => {
    expect(intentDisplayTitle({})).toBe('Untitled plan');
    expect(intentDisplayTitle({ title: '   ', rawText: '   ' })).toBe('Untitled plan');
  });
});

describe('mapsSearchUrl', () => {
  test('builds an encoded Google Maps search link', () => {
    expect(mapsSearchUrl('Blue Bottle, Oakland CA')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Blue%20Bottle%2C%20Oakland%20CA',
    );
  });
});

describe('areaNeedsYouRows', () => {
  const now = at(2026, 6, 8, 12, 0);

  test('ranks plan answers, then overdue tasks, then suggested context', () => {
    const rows = areaNeedsYouRows(
      {
        plans: [planRow({ intentId: 'i9', title: 'Renew passport', status: 'needs_answers' })],
        tasks: [
          { cardId: 'c1', title: 'File taxes', completedAt: null, dueAt: at(2026, 6, 1) },
          { cardId: 'c2', title: 'Not due', completedAt: null, dueAt: at(2026, 6, 20) },
          { cardId: 'c3', title: 'Done', completedAt: at(2026, 6, 2), dueAt: at(2026, 6, 1) },
        ],
        candidateFacts: [{ _id: 'f1', kind: 'preference', value: 'Window seat' }],
      },
      now,
    );
    expect(rows.map((r) => r.kind)).toEqual(['plan_answers', 'overdue_task', 'suggested_context']);
    expect(rows[0].intentId).toBe('i9');
    expect(rows[1].title).toBe('File taxes');
    expect(rows[2].title).toBe('Window seat');
  });

  test('only needs-answers plans and past-due incomplete tasks qualify', () => {
    const rows = areaNeedsYouRows(
      {
        plans: [planRow({ status: 'planning' })],
        tasks: [{ cardId: 'c1', title: 'Future', completedAt: null, dueAt: at(2026, 6, 20) }],
        candidateFacts: [],
      },
      now,
    );
    expect(rows).toHaveLength(0);
  });

  test('a plan whose latest plan needs answers still surfaces', () => {
    const rows = areaNeedsYouRows(
      { plans: [planRow({ status: 'planning', planStatus: 'needs_answers' })] },
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('plan_answers');
  });

  test('caps the queue', () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({ _id: `f${i}`, kind: 'note', value: `v${i}` }));
    expect(areaNeedsYouRows({ candidateFacts: facts }, now, 3)).toHaveLength(3);
  });

  test('null/undefined inputs are treated as empty', () => {
    expect(areaNeedsYouRows({}, now)).toEqual([]);
    expect(areaNeedsYouRows({ plans: null, tasks: null, candidateFacts: null }, now)).toEqual([]);
  });
});

describe('extractAreaPlaces', () => {
  test('structured plan places lead and dedupe by name (case-insensitive)', () => {
    const places = extractAreaPlaces(
      [
        {
          places: [
            { name: 'Tartine', detail: 'Bakery', address: '600 Guerrero St', mapsQuery: 'Tartine SF' },
            { name: 'tartine' }, // duplicate collapses
          ],
          mapQuery: null,
        },
      ],
      null,
    );
    expect(places).toHaveLength(1);
    expect(places[0].name).toBe('Tartine');
    expect(places[0].detail).toBe('Bakery');
    expect(places[0].mapsUrl).toBe(mapsSearchUrl('Tartine SF'));
  });

  test('a plan mapQuery is only a fallback when no structured places exist', () => {
    const withStructured = extractAreaPlaces(
      [{ places: [{ name: 'Real Place' }], mapQuery: 'Fallback' }],
      null,
    );
    expect(withStructured.map((p) => p.name)).toEqual(['Real Place']);
    const withoutStructured = extractAreaPlaces([{ places: [], mapQuery: 'Fallback' }], null);
    expect(withoutStructured.map((p) => p.name)).toEqual(['Fallback']);
  });

  test('answer options contribute only when they carry a real address', () => {
    const places = extractAreaPlaces(null, [
      [
        { title: 'Free-text answer', detail: 'no address' },
        { title: 'Hotel Zephyr', address: 'Pier 39, San Francisco' },
      ],
    ]);
    expect(places.map((p) => p.name)).toEqual(['Hotel Zephyr']);
    expect(places[0].mapsUrl).toBe(mapsSearchUrl('Hotel Zephyr, Pier 39, San Francisco'));
  });

  test('blank names are skipped and the result is capped', () => {
    const many = Array.from({ length: AREA_PLACE_CAP + 5 }, (_, i) => ({ name: `Place ${i}` }));
    const places = extractAreaPlaces([{ places: [{ name: '  ' }, ...many], mapQuery: null }], null);
    expect(places).toHaveLength(AREA_PLACE_CAP);
    expect(places[0].name).toBe('Place 0');
  });
});
