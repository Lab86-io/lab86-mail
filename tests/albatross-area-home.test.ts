import { describe, expect, test } from 'bun:test';
import type { NeedsYouRow } from '../lib/albatross/area-home';
import {
  AREA_PLACE_CAP,
  areaBrandingFromFacts,
  areaBriefHeadline,
  areaBriefState,
  areaFreshness,
  areaHasNoLinks,
  areaHomeSections,
  areaIndexStatusSummary,
  areaNeedsYouRows,
  areaOverviewBadges,
  areaOverviewPriority,
  areaOverviewStatus,
  areaPulse,
  evidenceRollup,
  extractAreaPlaces,
  faviconUrlForDomain,
  formatEventTime,
  intentDisplayTitle,
  mapsSearchUrl,
  mergeNeedsYouRows,
  normalizeAreaDomain,
  PERSONAL_AREA_EXTERNAL_ID,
  planActionLabel,
  planStatusMeta,
  projectProgress,
  projectStateMeta,
  RAIL_AREA_CAP,
  railAreaBadge,
  railAreaRows,
  resolveAreaSelection,
  shouldShowEvidenceBand,
  splitBriefRows,
  suggestIntentArea,
  taskRowMeta,
  workNeedsYouRows,
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
  test('true only when every rendered and other artifact link is empty', () => {
    expect(areaHasNoLinks(counts(0, 0, 0))).toBe(true);
    expect(areaHasNoLinks(counts(0, 0, 0, 5, 2))).toBe(true); // facts alone are not links
    expect(areaHasNoLinks(counts(1, 0, 0))).toBe(false);
    expect(areaHasNoLinks(counts(0, 1, 0))).toBe(false);
    expect(areaHasNoLinks(counts(0, 0, 1))).toBe(false);
    expect(areaHasNoLinks(counts(0, 0, 0), 1)).toBe(false);
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

  test('a bounded blockers queue qualifies the count', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Garden',
        needsYou: 6,
        needsYouBounded: true,
        upcoming: 0,
        plans: 0,
        projects: 0,
        mail: 0,
        tasks: 0,
        candidateFacts: 0,
      }),
    ).toBe('at least 6 items need you before Garden can move cleanly.');
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

  test('bounded upcoming evidence qualifies the event count', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Garden',
        needsYou: 0,
        upcoming: 3,
        upcomingBounded: true,
        plans: 1,
        projects: 0,
        mail: 0,
        tasks: 0,
        candidateFacts: 0,
      }),
    ).toBe('at least 3 upcoming events and 1 active plan are shaping Garden today.');
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

  test('exact filed-signals count when evidence is not bounded', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Household',
        needsYou: 0,
        upcoming: 1,
        plans: 0,
        projects: 0,
        mail: 3,
        tasks: 2,
        candidateFacts: 0,
      }),
    ).toBe('Household has 6 filed signals to review.');
  });

  test('bounded evidence avoids an exact claim it cannot stand behind', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Household',
        needsYou: 0,
        upcoming: 0,
        plans: 0,
        projects: 0,
        mail: 30,
        tasks: 0,
        candidateFacts: 0,
        evidenceBounded: true,
      }),
    ).toBe('Household has at least 30 filed signals to review.');
  });

  test('a single bounded signal keeps singular wording', () => {
    expect(
      areaBriefHeadline({
        areaName: 'Household',
        needsYou: 0,
        upcoming: 0,
        plans: 0,
        projects: 0,
        mail: 1,
        tasks: 0,
        candidateFacts: 0,
        evidenceBounded: true,
      }),
    ).toBe('Household has at least 1 filed signal to review.');
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

  test('returns the complete queue so presentation can collapse it without losing actions', () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({ _id: `f${i}`, kind: 'note', value: `v${i}` }));
    expect(areaNeedsYouRows({ candidateFacts: facts }, now)).toHaveLength(20);
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

// ---------------------------------------------------------------------------
// Area Brief v2: living-brief presentation, work-needs-you, project progress,
// evidence rollup.
// ---------------------------------------------------------------------------

describe('areaBriefState', () => {
  const headline = 'Household is quiet right now.';

  test('ready brief renders the generated lede and summary, not the headline', () => {
    const state = areaBriefState(
      {
        status: 'ready',
        lede: 'The lease renewal is the only blocker.',
        summary: 'Two tasks remain.',
        generatedAt: 100,
      },
      headline,
    );
    expect(state.mode).toBe('ready');
    expect(state.lede).toBe('The lease renewal is the only blocker.');
    expect(state.summary).toBe('Two tasks remain.');
    expect(state.stale).toBe(false);
    expect(state.canGenerate).toBe(false);
    expect(state.note).toBeNull();
    expect(state.generatedAt).toBe(100);
  });

  test('generating over a published prior edition carries it as stale, with an honest note', () => {
    // A real prior edition preserves its generatedAt while the next one writes.
    const state = areaBriefState(
      { status: 'generating', lede: 'Old lede.', summary: 'Old summary.', generatedAt: 100 },
      headline,
    );
    expect(state.mode).toBe('generating');
    expect(state.lede).toBe('Old lede.');
    expect(state.summary).toBe('Old summary.');
    expect(state.stale).toBe(true);
    expect(state.note).toBe('Updating the brief…');
    expect(state.canGenerate).toBe(false);
  });

  test('first-ever generating record shows the headline even if it carries placeholder text', () => {
    // The backend's first generating write has generatedAt undefined; any lede it
    // carries is a placeholder, not a published edition, so it must not go stale.
    const withPlaceholder = areaBriefState(
      { status: 'generating', lede: 'Preparing…', summary: '' },
      headline,
    );
    expect(withPlaceholder.mode).toBe('generating');
    expect(withPlaceholder.lede).toBe(headline);
    expect(withPlaceholder.summary).toBeNull();
    expect(withPlaceholder.stale).toBe(false);
    expect(withPlaceholder.note).toBe('Writing the brief…');

    const empty = areaBriefState({ status: 'generating', lede: '', summary: '' }, headline);
    expect(empty.lede).toBe(headline);
    expect(empty.stale).toBe(false);
    expect(empty.note).toBe('Writing the brief…');
  });

  test('a failed refresh of a published edition keeps the last brief visible', () => {
    const withPrior = areaBriefState(
      { status: 'error', lede: 'Last good lede.', summary: 'Detail.', generatedAt: 100 },
      headline,
    );
    expect(withPrior.mode).toBe('error');
    expect(withPrior.lede).toBe('Last good lede.');
    expect(withPrior.stale).toBe(true);
    expect(withPrior.note).toBe('Couldn’t refresh — showing the last brief.');
    expect(withPrior.canGenerate).toBe(false);
  });

  test('a first-ever error (no published edition) shows the headline and offers to generate', () => {
    // No generatedAt: even a placeholder lede is not a real brief to fall back on.
    const withPlaceholder = areaBriefState({ status: 'error', lede: 'Preparing…', summary: '' }, headline);
    expect(withPlaceholder.mode).toBe('error');
    expect(withPlaceholder.lede).toBe(headline);
    expect(withPlaceholder.summary).toBeNull();
    expect(withPlaceholder.stale).toBe(false);
    expect(withPlaceholder.note).toBe('Live work and evidence are below.');
    expect(withPlaceholder.canGenerate).toBe(true);

    const empty = areaBriefState({ status: 'error', lede: '', summary: '' }, headline);
    expect(empty.mode).toBe('error');
    expect(empty.lede).toBe(headline);
    expect(empty.note).toBe('Live work and evidence are below.');
    expect(empty.canGenerate).toBe(true);
  });

  test('an unrenderable generated timestamp cannot masquerade as a published edition', () => {
    const state = areaBriefState(
      {
        status: 'error',
        lede: 'Placeholder text',
        summary: 'Placeholder summary',
        generatedAt: Number.MAX_VALUE,
      },
      headline,
    );
    expect(state.generatedAt).toBeNull();
    expect(state.lede).toBe(headline);
    expect(state.canGenerate).toBe(true);
  });

  test('absent brief (null doc) uses the headline and offers to generate', () => {
    const state = areaBriefState(null, headline);
    expect(state.mode).toBe('absent');
    expect(state.lede).toBe(headline);
    expect(state.summary).toBeNull();
    expect(state.canGenerate).toBe(true);
    expect(state.stale).toBe(false);
  });

  test('a ready doc with no text degrades to absent rather than showing an empty lead', () => {
    const state = areaBriefState({ status: 'ready', lede: '   ', summary: '' }, headline);
    expect(state.mode).toBe('absent');
    expect(state.lede).toBe(headline);
    expect(state.canGenerate).toBe(true);
  });
});

describe('areaFreshness', () => {
  const now = at(2026, 6, 8, 12, 0);

  test('recent times read relative, older times read as a date', () => {
    expect(areaFreshness(now - 20_000, now)).toBe('just now');
    expect(areaFreshness(now - 12 * 60_000, now)).toBe('12m ago');
    expect(areaFreshness(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(areaFreshness(at(2026, 6, 5, 9, 0), now)).toBe('Jul 5');
  });

  test('missing or malformed timestamps produce nothing', () => {
    expect(areaFreshness(null, now)).toBeNull();
    expect(areaFreshness(undefined, now)).toBeNull();
    expect(areaFreshness(0, now)).toBeNull();
    expect(areaFreshness(Number.NaN, now)).toBeNull();
    expect(areaFreshness(Number.MAX_VALUE, now)).toBeNull();
  });
});

describe('workNeedsYouRows', () => {
  test('only needs_input work qualifies and carries the work id', () => {
    const rows = workNeedsYouRows([
      { _id: 'w1', title: 'Book the venue', agentState: 'needs_input' },
      { _id: 'w2', title: 'Draft email', agentState: 'researching' },
      { _id: 'w3', rawText: 'no title here', agentState: 'needs_input' },
    ]);
    expect(rows.map((r) => r.workId)).toEqual(['w1', 'w3']);
    expect(rows.every((r) => r.kind === 'work_input')).toBe(true);
    expect(rows[1].title).toBe('no title here');
    expect(rows[0].detail).toBe('Answer to continue this work');
  });

  test('null input is empty and every actionable row remains reachable', () => {
    expect(workNeedsYouRows(null)).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ({
      _id: `w${i}`,
      title: `W${i}`,
      agentState: 'needs_input',
    }));
    expect(workNeedsYouRows(many)).toHaveLength(10);
  });
});

describe('mergeNeedsYouRows', () => {
  const work = (workId: string, title = workId): NeedsYouRow => ({
    id: `work:${workId}`,
    kind: 'work_input',
    title,
    detail: 'Answer to continue this work',
    workId,
  });
  const plan = (intentId: string, title = intentId): NeedsYouRow => ({
    id: `plan:${intentId}`,
    kind: 'plan_answers',
    title,
    detail: 'Answer questions to finish planning',
    intentId,
  });
  const task = (cardId: string): NeedsYouRow => ({
    id: `task:${cardId}`,
    kind: 'overdue_task',
    title: cardId,
    detail: 'Overdue · Jul 1',
  });
  const fact = (factId: string): NeedsYouRow => ({
    id: `fact:${factId}`,
    kind: 'suggested_context',
    title: factId,
    detail: 'Suggested preference',
  });

  test('the same intent as work_input and plan_answers collapses to the actionable work row', () => {
    const merged = mergeNeedsYouRows([work('i1')], [plan('i1')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe('work_input');
    expect(merged[0].workId).toBe('i1');
  });

  test('work_input wins the shared slot regardless of plan order (work passed first)', () => {
    const merged = mergeNeedsYouRows([work('i1'), work('i2')], [plan('i2'), plan('i3')]);
    expect(merged.map((r) => r.id)).toEqual(['work:i1', 'work:i2', 'plan:i3']);
  });

  test('overdue tasks and suggested context are always preserved (no shared identity)', () => {
    const merged = mergeNeedsYouRows([work('i1')], [plan('i1'), task('c1'), fact('f1')]);
    expect(merged.map((r) => r.kind)).toEqual(['work_input', 'overdue_task', 'suggested_context']);
  });

  test('distinct intents are all kept', () => {
    const merged = mergeNeedsYouRows([work('i1')], [plan('i2')]);
    expect(merged.map((r) => r.id)).toEqual(['work:i1', 'plan:i2']);
  });

  test('rows lacking their identity field are never merged away', () => {
    const orphanWork: NeedsYouRow = { id: 'work:x', kind: 'work_input', title: 'x', detail: null };
    const orphanPlan: NeedsYouRow = { id: 'plan:y', kind: 'plan_answers', title: 'y', detail: null };
    const merged = mergeNeedsYouRows([orphanWork], [orphanPlan]);
    expect(merged).toHaveLength(2);
  });

  test('dedupe never drops unrelated actionable rows; null inputs are empty', () => {
    const merged = mergeNeedsYouRows(
      [work('i1'), work('i2'), work('i3')],
      [plan('i1'), task('c1'), fact('f1')],
    );
    expect(merged).toHaveLength(5);
    expect(merged.map((r) => r.id)).toEqual(['work:i1', 'work:i2', 'work:i3', 'task:c1', 'fact:f1']);
    expect(mergeNeedsYouRows(null, null)).toEqual([]);
  });
});

describe('projectProgress', () => {
  test('produces a clamped percent and a bar only when there is a total', () => {
    expect(projectProgress(3, 4)).toEqual({ completed: 3, total: 4, percent: 75, hasBar: true });
    expect(projectProgress(0, 0)).toEqual({ completed: 0, total: 0, percent: 0, hasBar: false });
    expect(projectProgress(9, 4)).toEqual({ completed: 4, total: 4, percent: 100, hasBar: true });
    expect(projectProgress(-2, 4).completed).toBe(0);
    expect(projectProgress(1, undefined)).toEqual({ completed: 0, total: 0, percent: 0, hasBar: false });
  });
});

describe('projectStateMeta', () => {
  test('maps real statuses; unknown statuses echo without inventing health', () => {
    expect(projectStateMeta('active')).toEqual({ label: 'Active', tone: 'active' });
    expect(projectStateMeta('paused')).toEqual({ label: 'Paused', tone: 'paused' });
    expect(projectStateMeta('done').tone).toBe('neutral');
    expect(projectStateMeta('on_hold')).toEqual({ label: 'on hold', tone: 'neutral' });
    expect(projectStateMeta(null)).toEqual({ label: 'Project', tone: 'neutral' });
  });
});

describe('evidenceRollup', () => {
  const preview = (shown: number, hasMore = false) => ({ shown, hasMore });

  test('only non-zero facets in a fixed order, with singular/plural', () => {
    const segments = evidenceRollup({
      mail: preview(17),
      events: preview(0),
      tasks: preview(1),
      facts: { verified: 2, candidate: 1 },
    });
    expect(segments.map((s) => s.id)).toEqual(['mail', 'tasks', 'verified', 'candidate']);
    expect(segments.map((s) => s.label)).toEqual([
      '17 threads',
      '1 task',
      '2 verified facts',
      '1 context ask',
    ]);
  });

  test('a bounded preview reads "N+" and never claims a false exact total', () => {
    const segments = evidenceRollup({
      mail: preview(30, true),
      events: preview(3, false),
      tasks: preview(1, true),
      facts: { verified: 0, candidate: 0 },
    });
    expect(segments.map((s) => s.label)).toEqual(['30+ threads', '3 events', '1+ tasks']);
  });

  test('a single shown row that is not bounded stays singular', () => {
    const segments = evidenceRollup({
      mail: preview(1, false),
      events: preview(0),
      tasks: preview(0),
      facts: { verified: 0, candidate: 0 },
    });
    expect(segments.map((s) => s.label)).toEqual(['1 thread']);
  });

  test('a quiet area yields no rollup (band hides)', () => {
    expect(
      evidenceRollup({
        mail: preview(0),
        events: preview(0),
        tasks: preview(0),
        facts: { verified: 0, candidate: 0 },
      }),
    ).toEqual([]);
  });
});

describe('shouldShowEvidenceBand', () => {
  test('keeps a places-only Area visible in the supporting evidence band', () => {
    expect(shouldShowEvidenceBand(0, 2)).toBe(true);
    expect(shouldShowEvidenceBand(0, 0)).toBe(false);
    expect(shouldShowEvidenceBand(1, 0)).toBe(true);
  });
});
