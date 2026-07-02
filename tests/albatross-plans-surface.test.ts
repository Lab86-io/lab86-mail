import { describe, expect, test } from 'bun:test';
import {
  answersReadyForRegen,
  applyDisabledReason,
  chosenQuestionOption,
  getGeo,
  intentDisplayTitle,
  intentMatchesFilter,
  intentStatusMeta,
  looksLikeAddress,
  mapQueryForIntent,
  nextUnansweredQuestion,
  openQuestions,
  type PlanLike,
  planRevealSequence,
  type QuestionOption,
  relativeTime,
} from '../components/albatross/PlansSurface';

const readyPlan: PlanLike = {
  status: 'ready',
  outcome: 'Trip to Lisbon is booked and briefed.',
  summary: 'Flights, hotel, and a prep block.',
  digitalActions: [
    { kind: 'email_draft', title: 'Email Ana', to: 'ana@example.com' },
    { kind: 'task', title: 'Book flights' },
    { kind: 'calendar_event', title: 'Prep block', startIso: '2026-07-06T09:00:00Z' },
    { kind: 'task', title: 'Renew passport' },
  ],
  physicalActions: [{ title: 'Drop passport photos at the post office' }],
  assumptions: ['Traveling the week of July 13'],
  sourceRefs: [{ kind: 'thread', id: 't1', label: 'Ana re: Lisbon' }],
  artifactHtml: '<html><body>brief</body></html>',
};

describe('intentStatusMeta', () => {
  test('maps every status with label, tone, and icon name', () => {
    expect(intentStatusMeta('captured')).toEqual({
      label: 'Captured',
      tone: 'neutral',
      icon: 'circle-dot',
      pulse: false,
    });
    expect(intentStatusMeta('needs_answers').tone).toBe('warning');
    expect(intentStatusMeta('ready').tone).toBe('accent');
    // No star icons anywhere (sparkles/wand-sparkles banned).
    expect(intentStatusMeta('ready').icon).toBe('list-checks');
    expect(intentStatusMeta('applied').tone).toBe('success');
    expect(intentStatusMeta('done').icon).toBe('check');
    expect(intentStatusMeta('archived').icon).toBe('archive');
  });

  test('planning is the only pulsing (in-flight) state', () => {
    // Consciously updated: star icons (sparkles/wand-sparkles) are banned.
    expect(intentStatusMeta('planning')).toEqual({
      label: 'Planning',
      tone: 'accent',
      icon: 'hourglass',
      pulse: true,
    });
    const rest = ['captured', 'needs_answers', 'ready', 'applied', 'done', 'archived'];
    for (const status of rest) expect(intentStatusMeta(status).pulse).toBe(false);
  });

  test('unknown statuses fall back to captured', () => {
    expect(intentStatusMeta('whatever').label).toBe('Captured');
  });
});

describe('planRevealSequence', () => {
  test('reveals outcome first, then actions by kind, then physical, assumptions, sources, artifact', () => {
    const sequence = planRevealSequence(readyPlan);
    expect(sequence.map((item) => item.kind)).toEqual([
      'outcome',
      'action',
      'action',
      'action',
      'action',
      'physical',
      'assumptions',
      'sources',
      'artifact',
    ]);
    // Actions order: tasks first (stable), then calendar events, then drafts.
    expect(sequence.filter((item) => item.kind === 'action').map((item) => item.action?.title)).toEqual([
      'Book flights',
      'Renew passport',
      'Prep block',
      'Email Ana',
    ]);
  });

  test('is deterministic across calls', () => {
    const a = planRevealSequence(readyPlan).map((item) => item.key);
    const b = planRevealSequence(readyPlan).map((item) => item.key);
    expect(a).toEqual(b);
  });

  test('skips empty sections and unknown action kinds sort last', () => {
    const sequence = planRevealSequence({
      status: 'ready',
      digitalActions: [
        { kind: 'area_fact', title: 'Fact' },
        { kind: 'task', title: 'Task' },
      ],
    });
    expect(sequence.map((item) => item.kind)).toEqual(['action', 'action']);
    expect(sequence[0].action?.title).toBe('Task');
    expect(sequence[1].action?.title).toBe('Fact');
  });

  test('empty for null/undefined plans', () => {
    expect(planRevealSequence(null)).toEqual([]);
    expect(planRevealSequence(undefined)).toEqual([]);
  });
});

describe('applyDisabledReason', () => {
  const readyIntent = { status: 'ready' as const };

  test('null when the plan is applicable', () => {
    expect(applyDisabledReason(readyIntent, readyPlan)).toBeNull();
  });

  test('blocked while planning', () => {
    expect(applyDisabledReason({ status: 'planning' }, null)).toContain('planning');
  });

  test('blocked with no plan', () => {
    expect(applyDisabledReason({ status: 'captured' }, null)).toContain('No plan');
  });

  test('blocked while questions are open', () => {
    const intent = {
      status: 'needs_answers' as const,
      questions: [{ id: 'q1', prompt: 'When?' }],
    };
    expect(applyDisabledReason(intent, { ...readyPlan, status: 'needs_answers' })).toContain('questions');
    // Plan flagged needs_answers blocks even if the intent rows disagree.
    expect(applyDisabledReason(readyIntent, { ...readyPlan, status: 'needs_answers' })).toContain(
      'questions',
    );
  });

  test('answered questions do not block', () => {
    const intent = {
      status: 'ready' as const,
      questions: [{ id: 'q1', prompt: 'When?', answer: 'July', answeredAt: 1 }],
    };
    expect(applyDisabledReason(intent, readyPlan)).toBeNull();
  });

  test('blocked when already applied or superseded', () => {
    expect(applyDisabledReason(readyIntent, { ...readyPlan, status: 'applied' })).toContain('Already');
    expect(applyDisabledReason({ status: 'applied' }, readyPlan)).toContain('Already');
    expect(applyDisabledReason(readyIntent, { ...readyPlan, status: 'superseded' })).toContain('replaced');
  });

  test('draft plans are not applicable', () => {
    expect(applyDisabledReason(readyIntent, { ...readyPlan, status: 'draft' })).toContain('not ready');
  });
});

describe('openQuestions', () => {
  test('returns only unanswered questions', () => {
    const intent = {
      status: 'needs_answers' as const,
      questions: [
        { id: 'a', prompt: 'A?', answer: 'yes', answeredAt: 1 },
        { id: 'b', prompt: 'B?' },
      ],
    };
    expect(openQuestions(intent).map((question) => question.id)).toEqual(['b']);
    expect(openQuestions(null)).toEqual([]);
  });
});

describe('intentMatchesFilter', () => {
  test('needs_you covers needs_answers and plan errors', () => {
    expect(intentMatchesFilter({ status: 'needs_answers' }, 'needs_you')).toBe(true);
    expect(intentMatchesFilter({ status: 'captured', planError: 'boom' }, 'needs_you')).toBe(true);
    expect(intentMatchesFilter({ status: 'captured' }, 'needs_you')).toBe(false);
  });

  test('done covers done and applied', () => {
    expect(intentMatchesFilter({ status: 'done' }, 'done')).toBe(true);
    expect(intentMatchesFilter({ status: 'applied' }, 'done')).toBe(true);
    expect(intentMatchesFilter({ status: 'ready' }, 'done')).toBe(false);
  });

  test('ready and all', () => {
    expect(intentMatchesFilter({ status: 'ready' }, 'ready')).toBe(true);
    expect(intentMatchesFilter({ status: 'archived' }, 'all')).toBe(true);
  });
});

describe('intentDisplayTitle', () => {
  test('prefers the title, falls back to the first raw line', () => {
    expect(intentDisplayTitle({ status: 'captured', title: 'Lisbon trip', rawText: 'x' })).toBe(
      'Lisbon trip',
    );
    expect(intentDisplayTitle({ status: 'captured', rawText: '\n\n  book lisbon \nmore' })).toBe(
      'book lisbon',
    );
    expect(intentDisplayTitle({ status: 'captured', rawText: '' })).toBe('Untitled intent');
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0, 0);

  test('buckets minutes, hours, and days', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  test('older than a week falls back to a date', () => {
    expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/Jun/);
  });
});

// ---------------------------------------------------------------------------
// Option questions, auto-regen, and the inline map
// ---------------------------------------------------------------------------

const coffeeOption: QuestionOption = {
  id: 'o1',
  title: 'Blue Bottle Coffee',
  detail: 'Quiet third-wave cafe',
  address: '76 N 4th St, Brooklyn, NY',
  hoursText: 'Open until 6pm',
  website: 'https://bluebottle.com',
};

const bareOption: QuestionOption = { id: 'o2', title: 'Devoción' };

describe('nextUnansweredQuestion', () => {
  test('returns the first question without an answer', () => {
    const intent = {
      status: 'needs_answers' as const,
      questions: [
        { id: 'a', prompt: 'A?', answer: 'yes', answeredAt: 1 },
        { id: 'b', prompt: 'B?' },
        { id: 'c', prompt: 'C?' },
      ],
    };
    expect(nextUnansweredQuestion(intent)?.id).toBe('b');
  });

  test('null when everything is answered or there are no questions', () => {
    expect(
      nextUnansweredQuestion({
        status: 'ready',
        questions: [{ id: 'a', prompt: 'A?', answer: 'yes' }],
      }),
    ).toBeNull();
    expect(nextUnansweredQuestion({ status: 'captured' })).toBeNull();
    expect(nextUnansweredQuestion(null)).toBeNull();
  });
});

describe('answersReadyForRegen', () => {
  test('true when every question carries an answer (drives auto-regen)', () => {
    const intent = {
      status: 'needs_answers' as const,
      questions: [
        { id: 'a', prompt: 'A?', answer: 'yes' },
        { id: 'b', prompt: 'B?', answer: 'Blue Bottle Coffee', answeredOptionId: 'o1' },
      ],
    };
    expect(answersReadyForRegen(intent)).toBe(true);
  });

  test('false while any question is open', () => {
    const intent = {
      status: 'needs_answers' as const,
      questions: [
        { id: 'a', prompt: 'A?', answer: 'yes' },
        { id: 'b', prompt: 'B?' },
      ],
    };
    expect(answersReadyForRegen(intent)).toBe(false);
  });

  test('empty-string answers do not count as answered', () => {
    expect(
      answersReadyForRegen({ status: 'needs_answers', questions: [{ id: 'a', prompt: 'A?', answer: '' }] }),
    ).toBe(false);
  });

  test('false with no questions at all (nothing to regen from)', () => {
    expect(answersReadyForRegen({ status: 'captured' })).toBe(false);
    expect(answersReadyForRegen({ status: 'captured', questions: [] })).toBe(false);
    expect(answersReadyForRegen(null)).toBe(false);
  });
});

describe('chosenQuestionOption', () => {
  test('returns the most recently answered option that still exists', () => {
    const intent = {
      status: 'ready' as const,
      questions: [
        {
          id: 'q1',
          prompt: 'Where?',
          options: [coffeeOption],
          answer: 'Blue Bottle Coffee',
          answeredOptionId: 'o1',
        },
        { id: 'q2', prompt: 'Backup?', options: [bareOption], answer: 'Devoción', answeredOptionId: 'o2' },
      ],
    };
    expect(chosenQuestionOption(intent)?.id).toBe('o2');
  });

  test('ignores free-text answers and dangling option ids', () => {
    expect(
      chosenQuestionOption({
        status: 'ready',
        questions: [{ id: 'q1', prompt: 'Where?', options: [coffeeOption], answer: 'somewhere else' }],
      }),
    ).toBeNull();
    expect(
      chosenQuestionOption({
        status: 'ready',
        questions: [
          { id: 'q1', prompt: 'Where?', options: [coffeeOption], answer: 'gone', answeredOptionId: 'nope' },
        ],
      }),
    ).toBeNull();
    expect(chosenQuestionOption(null)).toBeNull();
  });
});

describe('looksLikeAddress', () => {
  test('matches street-address shapes', () => {
    expect(looksLikeAddress('76 N 4th St, Brooklyn, NY')).toBe(true);
    expect(looksLikeAddress('Drop off at 120 Court Street')).toBe(true);
    expect(looksLikeAddress('2500 Grand Boulevard, Kansas City')).toBe(true);
  });

  test('rejects plain prose and empties', () => {
    expect(looksLikeAddress('Drop passport photos at the post office')).toBe(false);
    expect(looksLikeAddress('Buy 2 tickets for the show')).toBe(false);
    expect(looksLikeAddress('')).toBe(false);
    expect(looksLikeAddress(undefined)).toBe(false);
  });
});

describe('mapQueryForIntent', () => {
  const intentWithChoice = {
    status: 'ready' as const,
    questions: [
      {
        id: 'q1',
        prompt: 'Where?',
        options: [coffeeOption],
        answer: 'Blue Bottle Coffee',
        answeredOptionId: 'o1',
      },
    ],
  };

  test('a hovered/selected preview option wins over everything', () => {
    expect(mapQueryForIntent(intentWithChoice, readyPlan, bareOption)).toBe('Devoción');
  });

  test('falls back to the chosen option: title + address', () => {
    expect(mapQueryForIntent(intentWithChoice, null)).toBe('Blue Bottle Coffee, 76 N 4th St, Brooklyn, NY');
  });

  test('chosen option without an address maps by title alone', () => {
    const intent = {
      status: 'ready' as const,
      questions: [
        { id: 'q1', prompt: 'Where?', options: [bareOption], answer: 'Devoción', answeredOptionId: 'o2' },
      ],
    };
    expect(mapQueryForIntent(intent, null)).toBe('Devoción');
  });

  test('address-looking physical action detail maps as title + detail', () => {
    const plan: PlanLike = {
      status: 'ready',
      physicalActions: [
        { title: 'Drop passport photos at the post office' },
        { title: 'Pick up the visa', detail: '120 Court St, Brooklyn, NY' },
      ],
    };
    expect(mapQueryForIntent({ status: 'ready' }, plan)).toBe('Pick up the visa, 120 Court St, Brooklyn, NY');
  });

  test('maps-url physical action maps by its title', () => {
    const plan: PlanLike = {
      status: 'ready',
      physicalActions: [{ title: 'Visit the DMV', url: 'https://www.google.com/maps/place/DMV' }],
    };
    expect(mapQueryForIntent({ status: 'ready' }, plan)).toBe('Visit the DMV');
  });

  test('null when nothing is mappable', () => {
    expect(mapQueryForIntent({ status: 'ready' }, readyPlan)).toBeNull();
    expect(mapQueryForIntent(null, null)).toBeNull();
  });
});

describe('getGeo', () => {
  test('silently resolves undefined without geolocation support', async () => {
    // bun's navigator has no geolocation; getGeo must not throw or hang.
    expect(await getGeo(10)).toBeUndefined();
  });
});

describe('mapQueryForIntent plan.mapQuery preference', () => {
  const { mapQueryForIntent } = require('../components/albatross/PlansSurface');
  const basePlan = { status: 'ready' as const, mapQuery: 'Penn Yan DMV, Penn Yan NY' };

  test('plan-declared mapQuery lights the map without options or addresses', () => {
    expect(mapQueryForIntent({ status: 'ready' }, basePlan)).toBe('Penn Yan DMV, Penn Yan NY');
  });

  test('a chosen option still beats the plan mapQuery; preview beats both', () => {
    const intent = {
      status: 'ready' as const,
      questions: [
        {
          id: 'q1',
          prompt: 'Which?',
          answer: 'Parkway',
          answeredOptionId: 'o1',
          options: [{ id: 'o1', title: 'Parkway Music', address: '99 Route 9' }],
        },
      ],
    };
    expect(mapQueryForIntent(intent, basePlan)).toBe('Parkway Music, 99 Route 9');
    expect(mapQueryForIntent(intent, basePlan, { id: 'p', title: 'Other Spot' })).toBe('Other Spot');
  });

  test('blank mapQuery falls through to heuristics', () => {
    expect(mapQueryForIntent({ status: 'ready' }, { status: 'ready', mapQuery: '  ' })).toBeNull();
  });
});

describe('vortexSourcesForIntent', () => {
  const { vortexSourcesForIntent } = require('../components/albatross/PlansSurface');

  test('shows the real search terms, area names, and web detail', () => {
    const sources = vortexSourcesForIntent(
      { status: 'planning', rawText: 'I have to go to the guitar store this weekend for strings' },
      ['CardHunt', 'Money', 'Music', 'Habits'],
    );
    const byId = Object.fromEntries(sources.map((s: any) => [s.id, s]));
    expect(byId.mail.detail).toBe('search: I have to go to');
    expect(byId.areas.detail).toBe('CardHunt, Money, Music');
    expect(byId.web.detail).toBe('places near you');
    expect(sources).toHaveLength(5);
  });

  test('empty intent and no areas degrade to plain labels', () => {
    const sources = vortexSourcesForIntent(null, []);
    expect(sources.every((s: any) => s.label)).toBe(true);
    expect(sources.find((s: any) => s.id === 'areas').detail).toBeUndefined();
  });
});
