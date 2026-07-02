import { describe, expect, test } from 'bun:test';
import {
  applyDisabledReason,
  intentDisplayTitle,
  intentMatchesFilter,
  intentStatusMeta,
  openQuestions,
  type PlanLike,
  planRevealSequence,
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
    expect(intentStatusMeta('applied').tone).toBe('success');
    expect(intentStatusMeta('done').icon).toBe('check');
    expect(intentStatusMeta('archived').icon).toBe('archive');
  });

  test('planning is the only pulsing (in-flight) state', () => {
    expect(intentStatusMeta('planning')).toEqual({
      label: 'Planning',
      tone: 'accent',
      icon: 'sparkles',
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
