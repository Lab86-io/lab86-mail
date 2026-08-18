import { describe, expect, test } from 'bun:test';
import {
  intentAppliesToScope,
  matchReflectionCandidates,
  mergeDuplicateTaskHandoffs,
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

  test('rejects negated and future work without hiding a completed item in another clause', () => {
    for (const reflection of [
      'I still need to ship the notification flow.',
      "I haven't shipped the notification flow.",
      "I didn't ship the notification flow.",
      'The notification flow is not finished yet.',
      "I won't ship the notification flow today.",
    ]) {
      expect(matchReflectionCandidates(reflection, candidates)).toEqual([]);
    }
    expect(
      matchReflectionCandidates(
        "I shipped the notification flow, but I haven't finished the investor deck.",
        candidates,
      ).map((item) => item.id),
    ).toEqual(['notification']);
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

describe('duplicate task handoff merging', () => {
  const withItem = (record: any) => ({
    ...record,
    items: [
      {
        sourceKey: record.sourceKey,
        ref: record.primaryRef,
        situation: record.situation,
        assessment: record.assessment,
        recommendation: record.recommendation,
      },
    ],
  });

  test('near-identical task handoffs collapse into one carrying every identity', () => {
    const merged = mergeDuplicateTaskHandoffs([
      withItem(
        handoff('massage-1', "Book Tree's massage at Amazing Mind Body Soul Center", { protected: true }),
      ),
      withItem(handoff('massage-2', "Book Tree's massage — Amazing Mind Body Soul Center (Canandaigua)")),
      withItem(handoff('mom', "Find Mom's request and send the needed response", { protected: true })),
    ]);

    expect(merged.map((record) => record.id)).toEqual(['massage-1', 'mom']);
    const keeper = merged[0];
    expect(keeper.protected).toBe(true);
    expect(keeper.relatedRefs.map((ref: any) => ref.id)).toContain('massage-2');
    expect(keeper.items.map((item: any) => item.sourceKey)).toEqual(['task:massage-1', 'task:massage-2']);
  });

  test('distinct outcomes and non-task kinds never merge', () => {
    const eventRecord = {
      ...withItem(handoff('event-1', "Book Tree's massage at Amazing Mind Body Soul Center")),
      kind: 'event',
    };
    const merged = mergeDuplicateTaskHandoffs([
      withItem(handoff('massage-1', "Book Tree's massage at Amazing Mind Body Soul Center")),
      eventRecord,
      withItem(handoff('license', 'Complete NY DMV pre-screening and reserve an Enhanced License visit')),
    ]);
    expect(merged.map((record) => record.id)).toEqual(['massage-1', 'event-1', 'license']);
  });

  test('merging respects the schema caps on items and refs', () => {
    const keeper = withItem(handoff('cap-0', 'Water the community garden plot on Saturday'));
    keeper.items = Array.from({ length: 8 }, (_, index) => ({
      sourceKey: `task:seed-${index}`,
      ref: { kind: 'task', id: `seed-${index}`, label: 'Water the community garden plot on Saturday' },
      situation: 's',
      assessment: 'a',
      recommendation: 'r',
    }));
    keeper.relatedRefs = Array.from({ length: 8 }, (_, index) => ({
      kind: 'task',
      id: `ref-${index}`,
      label: 'Water the community garden plot on Saturday',
    }));
    const duplicate = withItem(handoff('cap-1', 'Water the community garden plot Saturday'));
    const merged = mergeDuplicateTaskHandoffs([keeper, duplicate]);
    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(8);
    expect(merged[0].relatedRefs).toHaveLength(8);
  });
});
