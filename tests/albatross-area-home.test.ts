import { describe, expect, test } from 'bun:test';
import {
  AREA_PLACE_CAP,
  areaBrandingFromFacts,
  areaBriefHeadline,
  areaHasNoLinks,
  areaHomeSections,
  areaIndexStatusSummary,
  areaNeedsYouRows,
  areaOverviewBadges,
  areaOverviewPriority,
  areaOverviewStatus,
  areaPulse,
  extractAreaPlaces,
  faviconUrlForDomain,
  formatEventTime,
  intentDisplayTitle,
  mapsSearchUrl,
  normalizeAreaDomain,
  PERSONAL_AREA_EXTERNAL_ID,
  planActionLabel,
  planStatusMeta,
  RAIL_AREA_CAP,
  railAreaBadge,
  railAreaRows,
  resolveAreaSelection,
  splitBriefRows,
  suggestIntentArea,
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

describe('area branding helpers', () => {
  test('normalizes domains from URLs, emails, @domains, and plain domains', () => {
    expect(normalizeAreaDomain('https://www.statpearls.com/path?x=1')).toBe('statpearls.com');
    expect(normalizeAreaDomain('Inbox <alerts@sub.example.org>')).toBe('sub.example.org');
    expect(normalizeAreaDomain('@linear.app')).toBe('linear.app');
    expect(normalizeAreaDomain('Not a domain')).toBeNull();
  });

  test('builds a bounded favicon URL from the normalized domain', () => {
    expect(faviconUrlForDomain('https://www.linear.app', 256)).toBe(
      'https://www.google.com/s2/favicons?domain=linear.app&sz=128',
    );
    expect(faviconUrlForDomain('not a domain')).toBeNull();
  });

  test('prefers explicit area branding, then verified facts, then candidate facts', () => {
    expect(
      areaBrandingFromFacts(
        { primaryDomain: 'https://area.example', imageUrl: 'https://cdn.example/hero.png' },
        [{ kind: 'domain', value: 'fact.example', status: 'verified' }],
      ),
    ).toEqual({
      primaryDomain: 'area.example',
      faviconUrl: 'https://www.google.com/s2/favicons?domain=area.example&sz=64',
      imageUrl: 'https://cdn.example/hero.png',
    });

    expect(
      areaBrandingFromFacts(null, [
        { kind: 'domain', value: 'candidate.example', status: 'candidate' },
        { kind: 'email', value: 'alerts@verified.example', status: 'verified' },
      ]),
    ).toEqual({
      primaryDomain: 'verified.example',
      faviconUrl: 'https://www.google.com/s2/favicons?domain=verified.example&sz=64',
      imageUrl: null,
    });
  });
});

describe('suggestIntentArea', () => {
  const areas = [
    {
      _id: 'personal',
      name: 'Personal',
      externalId: PERSONAL_AREA_EXTERNAL_ID,
      primaryDomain: null,
    },
    {
      _id: 'work',
      name: 'StatPearls',
      kind: 'work',
      description: 'medical education contracts and editorial deadlines',
      primaryDomain: 'statpearls.com',
    },
    {
      _id: 'home',
      name: 'House',
      kind: 'property',
      description: 'repairs, utilities, and neighborhood messages',
      primaryDomain: null,
    },
  ];

  test('uses strong name or domain evidence when it is present in the capture text', () => {
    expect(suggestIntentArea('follow up on the StatPearls renewal', areas)).toEqual({
      areaId: 'work',
      confidence: 'high',
      reason: 'StatPearls',
    });
    expect(suggestIntentArea('email legal@statpearls.com about the contract', areas)?.areaId).toBe('work');
  });

  test('defaults only when there is exactly one active area', () => {
    expect(suggestIntentArea('buy replacement filters', [areas[0]])).toEqual({
      areaId: 'personal',
      confidence: 'medium',
      reason: 'Only active area',
    });
    expect(suggestIntentArea('buy replacement filters', areas)).toBeNull();
  });
});

describe('resolveAreaSelection', () => {
  const areas = [
    { _id: 'area_personal_doc', name: 'Personal', kind: 'personal', externalId: PERSONAL_AREA_EXTERNAL_ID },
    { _id: 'area_work_doc', name: 'Work', kind: 'work' },
  ];

  test('maps the persisted Personal external id to the live document id', () => {
    expect(resolveAreaSelection(PERSONAL_AREA_EXTERNAL_ID, areas)).toEqual({
      areaId: 'area_personal_doc',
      state: 'replaced',
    });
  });

  test('keeps valid document ids and drops stale ids', () => {
    expect(resolveAreaSelection('area_work_doc', areas)).toEqual({
      areaId: 'area_work_doc',
      state: 'ready',
    });
    expect(resolveAreaSelection('missing_area', areas)).toEqual({ areaId: null, state: 'missing' });
  });

  test('distinguishes chooser from loading so the UI does not query a stale id too early', () => {
    expect(resolveAreaSelection(null, areas)).toEqual({ areaId: null, state: 'chooser' });
    expect(resolveAreaSelection('area_work_doc', undefined)).toEqual({
      areaId: 'area_work_doc',
      state: 'loading',
    });
  });
});

describe('areaIndexStatusSummary', () => {
  test('describes queued and running area filing runs', () => {
    expect(areaIndexStatusSummary({ latestRun: { status: 'queued' }, mail: { total: 1 } })).toEqual({
      label: 'Area filing queued',
      tone: 'active',
    });
    expect(
      areaIndexStatusSummary({
        latestRun: { status: 'running', scanned: 250 },
        mail: { total: 1 },
      }),
    ).toEqual({ label: 'Filing areas · 250 scanned', tone: 'active' });
  });

  test('falls back to mailbox indexing when no area run is active', () => {
    expect(
      areaIndexStatusSummary({
        latestRun: { status: 'done', scanned: 500, inserted: 20 },
        mail: { total: 2, indexing: 1, messagesSynced: 1200 },
      }),
    ).toEqual({ label: '1 mailbox indexing · 1,200 messages', tone: 'active' });
    expect(
      areaIndexStatusSummary({ latestRun: { status: 'done', inserted: 4 }, mail: { total: 1 } }),
    ).toEqual({
      label: 'Area filing done · 4 filed',
      tone: 'done',
    });
  });
});

const overviewCounts = (over: Partial<ReturnType<typeof baseOverviewCounts>> = {}) => ({
  ...baseOverviewCounts(),
  ...over,
  facts: { ...baseOverviewCounts().facts, ...(over.facts ?? {}) },
});

function baseOverviewCounts() {
  return {
    facts: { verified: 0, candidate: 0 },
    mail: 0,
    events: 0,
    tasks: 0,
    plans: 0,
    projects: 0,
    needsYou: 0,
    overdueTasks: 0,
    unreadMail: 0,
    suggestedLinks: 0,
  };
}

describe('area overview chooser helpers', () => {
  test('priority favors blockers over ordinary volume', () => {
    const blocker = overviewCounts({ needsYou: 1 });
    const busy = overviewCounts({ mail: 12, tasks: 3, projects: 2 });
    expect(areaOverviewPriority(blocker)).toBeGreaterThan(areaOverviewPriority(busy));
  });

  test('badges are capped and attention states lead', () => {
    const badges = areaOverviewBadges(
      overviewCounts({
        needsYou: 1,
        overdueTasks: 2,
        plans: 3,
        events: 4,
        tasks: 5,
        facts: { verified: 0, candidate: 6 },
      }),
      3,
    );
    expect(badges.map((badge) => badge.id)).toEqual(['needsYou', 'overdueTasks', 'candidateFacts']);
    expect(badges.map((badge) => badge.tone)).toEqual(['attention', 'attention', 'attention']);
  });

  test('status line names the most useful current reason to open the area', () => {
    expect(areaOverviewStatus(overviewCounts({ needsYou: 2 }))).toBe('2 items need you');
    expect(areaOverviewStatus(overviewCounts({ plans: 1 }))).toBe('1 active plan');
    expect(areaOverviewStatus(overviewCounts({ events: 1, tasks: 2 }))).toBe('3 scheduled items');
    expect(areaOverviewStatus(overviewCounts({ facts: { verified: 0, candidate: 1 } }))).toBe(
      '1 context ask',
    );
    expect(areaOverviewStatus(overviewCounts())).toBe('Quiet');
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

describe('areaBriefHeadline', () => {
  test('blockers produce the lead sentence', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Household',
        needsYou: 2,
        upcoming: 1,
        plans: 1,
        projects: 0,
        mail: 3,
        tasks: 4,
        candidateFacts: 1,
      }),
    ).toBe('2 items need you before Household can move cleanly.');
  });

  test('otherwise it summarizes upcoming events and active plans', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Job Search',
        needsYou: 0,
        upcoming: 1,
        plans: 2,
        projects: 0,
        mail: 0,
        tasks: 0,
        candidateFacts: 0,
      }),
    ).toBe('1 upcoming event and 2 active plans are shaping Job Search today.');
  });

  test('quiet areas get a quiet sentence', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Garden',
        needsYou: 0,
        upcoming: 0,
        plans: 0,
        projects: 0,
        mail: 0,
        tasks: 0,
        candidateFacts: 0,
      }),
    ).toBe('Garden is quiet right now.');
  });
});

describe('splitBriefRows', () => {
  test('returns visible rows, overflow, and total without mutating input', () => {
    const rows = [1, 2, 3, 4, 5];
    const split = splitBriefRows(rows, 3);
    expect(split).toEqual({ visible: [1, 2, 3], overflow: 2, total: 5 });
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  test('null input and negative limits are safe', () => {
    expect(splitBriefRows(null, 3)).toEqual({ visible: [], overflow: 0, total: 0 });
    expect(splitBriefRows([1, 2], -1)).toEqual({ visible: [], overflow: 2, total: 2 });
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
