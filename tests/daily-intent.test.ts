import { describe, expect, test } from 'bun:test';
import {
  intentAppliesToScope,
  matchReflectionCandidates,
  selectHandoffsForIntent,
} from '../lib/albatross/daily-intent';

function handoff(id: string, situation: string, options: { protected?: boolean } = {}) {
  return {
    version: 1,
    id,
    source: 'tasks',
    sourceKey: `task:${id}`,
    kind: 'task',
    lane: 'focus',
    status: 'open',
    priority: 'normal',
    protected: options.protected ?? false,
    situation,
    background: [],
    assessment: situation,
    recommendation: `Complete ${situation}`,
    evidence: [],
    primaryRef: { kind: 'task', id, label: situation },
    relatedRefs: [],
    items: [],
    actions: [],
    generatedAt: 1,
  } as any;
}

describe('next-day intent policy', () => {
  test('keeps protected handoffs and fits optional work to an explicit one-task budget', () => {
    const result = selectHandoffsForIntent(
      [
        handoff('calendar', 'Clean up the calendar'),
        handoff('card-hunt', 'Ship the Card Hunt search card'),
        handoff('billing', 'Reply to the billing escalation', { protected: true }),
        handoff('card-hunt-2', 'Polish the Card Hunt landing page'),
      ],
      "Tomorrow I'm not gonna do much. I will work on one task for Card Hunt for an hour, then enjoy the lake.",
    );

    expect(result.handoffs.map((item) => item.id)).toEqual(['billing', 'card-hunt']);
    expect(result.policy).toMatchObject({
      mode: 'light',
      requestedItems: 1,
      requestedMinutes: 60,
      suppressUnrelated: true,
      suppressedCount: 2,
    });
  });

  test('a light day with no matching work suppresses optional noise but never protected work', () => {
    const result = selectHandoffsForIntent(
      [handoff('passport', 'Renew the passport'), handoff('reply', 'Reply to Sam', { protected: true })],
      'Enjoy the lake and relax for the rest of the day.',
    );
    expect(result.handoffs.map((item) => item.id)).toEqual(['reply']);
  });

  test('no explicit intent leaves the canonical index intact', () => {
    const rows = [handoff('one', 'First'), handoff('two', 'Second')];
    expect(selectHandoffsForIntent(rows, undefined).handoffs.map((item) => item.id)).toEqual(['one', 'two']);
  });

  test('scopes named intent to the matching Area only', () => {
    const intent = 'Spend one hour on Card Hunt, then go to the lake.';
    expect(intentAppliesToScope(intent, ['Card Hunt', 'Ship search cards'])).toBe(true);
    expect(intentAppliesToScope(intent, ['House', 'Repair the porch'])).toBe(false);
  });
});

describe('reflection reconciliation', () => {
  const candidates = [
    { kind: 'work', id: 'notification', title: 'Ship notification flow' },
    { kind: 'project', id: 'passport', title: 'Passport renewal' },
    { kind: 'task', id: 'deck', title: 'Finish investor deck' },
  ];

  test('matches exact or strongly overlapping completed outcomes', () => {
    expect(
      matchReflectionCandidates(
        'I shipped the notification flow and finished the investor deck.',
        candidates,
      ).map((item) => item.id),
    ).toEqual(['notification', 'deck']);
  });

  test('does not convert vague reflection or nothing into completion state', () => {
    expect(matchReflectionCandidates('I worked on some things.', candidates)).toEqual([]);
    expect(matchReflectionCandidates('Nothing today', candidates)).toEqual([]);
  });

  test('leaves near-identical candidates unresolved instead of guessing', () => {
    expect(
      matchReflectionCandidates('Shipped the production notification flow.', [
        { kind: 'work', id: 'a', title: 'Production notification flow' },
        { kind: 'task', id: 'b', title: 'Production notification flow' },
      ]),
    ).toEqual([]);
  });
});
