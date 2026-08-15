import { describe, expect, test } from 'bun:test';
import {
  type ExecutionWorkRow,
  planNeedsConductor,
  selectExecutionSnapshot,
} from '../lib/albatross/execution';
import {
  INTERACTIVE_CARD_READ_BUDGET,
  selectCardCompleteProjection,
} from '../lib/albatross/projection-budget';

const NOW = Date.parse('2026-08-14T14:00:00Z');

const work = (over: Partial<ExecutionWorkRow>): ExecutionWorkRow => ({
  _id: over._id || 'work',
  title: over.title ?? 'Renew passport',
  rawText: over.rawText ?? 'Renew passport',
  status: over.status ?? 'applied',
  workState: 'workState' in over ? over.workState : 'active',
  agentState: over.agentState ?? 'idle',
  planError: over.planError ?? null,
  openQuestions: over.openQuestions ?? 0,
  priority: over.priority ?? 2,
  updatedAt: over.updatedAt ?? NOW,
  nextStep: 'nextStep' in over ? over.nextStep : 'Open the official renewal form',
  nextStepKey: over.nextStepKey ?? 'step-1',
  nextStepDetail: over.nextStepDetail ?? null,
  nextStepUrl: over.nextStepUrl ?? null,
  remainingSteps: over.remainingSteps ?? 2,
  totalSteps: over.totalSteps ?? 3,
  scheduledStartAt: over.scheduledStartAt ?? null,
  scheduledEndAt: over.scheduledEndAt ?? null,
});

describe('the scheduling conductor', () => {
  test('claims a concrete unscheduled plan', () => {
    expect(planNeedsConductor({ digitalActions: [{ kind: 'task', title: 'Open the renewal form' }] })).toBe(
      true,
    );
  });

  test('leaves scheduled and passed blocks alone', () => {
    expect(
      planNeedsConductor({
        digitalActions: [
          {
            kind: 'calendar_event',
            title: 'Renew passport',
            startIso: '2026-08-14T13:00:00Z',
            endIso: '2026-08-14T13:30:00Z',
          },
        ],
      }),
    ).toBe(false);
  });

  test('can pick up a captured Work item whose first plan never landed', () => {
    expect(planNeedsConductor(null)).toBe(true);
  });
});

describe('the authoritative current move', () => {
  test('chooses an active scheduled block before future and unscheduled work', () => {
    const snapshot = selectExecutionSnapshot(
      [
        work({ _id: 'unscheduled', priority: 1 }),
        work({ _id: 'future', scheduledStartAt: NOW + 60_000, scheduledEndAt: NOW + 120_000 }),
        work({ _id: 'now', scheduledStartAt: NOW - 60_000, scheduledEndAt: NOW + 60_000 }),
      ],
      NOW,
    );
    expect(snapshot.currentMove?.workId).toBe('now');
    expect(snapshot.currentMove?.phase).toBe('active');
  });

  test('chooses the earliest upcoming block, then a concrete high-priority step', () => {
    const upcoming = selectExecutionSnapshot(
      [
        work({ _id: 'later', scheduledStartAt: NOW + 120_000, scheduledEndAt: NOW + 180_000 }),
        work({ _id: 'sooner', scheduledStartAt: NOW + 60_000, scheduledEndAt: NOW + 90_000 }),
      ],
      NOW,
    );
    expect(upcoming.currentMove?.workId).toBe('sooner');

    const unscheduled = selectExecutionSnapshot(
      [work({ _id: 'recent-low', priority: 3, updatedAt: NOW + 10 }), work({ _id: 'high', priority: 1 })],
      NOW,
    );
    expect(unscheduled.currentMove?.workId).toBe('high');
    expect(unscheduled.currentMove?.phase).toBe('unscheduled');
  });

  test('a distant booking does not hide an actionable move today', () => {
    const snapshot = selectExecutionSnapshot(
      [
        work({
          _id: 'next-month',
          scheduledStartAt: NOW + 30 * 24 * 60 * 60_000,
          scheduledEndAt: NOW + 30 * 24 * 60 * 60_000 + 30 * 60_000,
        }),
        work({ _id: 'available-now' }),
      ],
      NOW,
    );
    expect(snapshot.currentMove?.workId).toBe('available-now');
  });

  test('a partial schedule remains eligible as unscheduled work', () => {
    const startOnly = selectExecutionSnapshot(
      [work({ _id: 'start-only', scheduledStartAt: NOW + 60_000, scheduledEndAt: null })],
      NOW,
    );
    expect(startOnly.currentMove).toMatchObject({ workId: 'start-only', phase: 'unscheduled' });

    const endOnly = selectExecutionSnapshot(
      [work({ _id: 'end-only', scheduledStartAt: null, scheduledEndAt: NOW - 60_000 })],
      NOW,
    );
    expect(endOnly.currentMove).toMatchObject({ workId: 'end-only', phase: 'unscheduled' });
    expect(endOnly.missedMoves).toEqual([]);
  });

  test('keeps questions separate and never offers work without a concrete step', () => {
    const snapshot = selectExecutionSnapshot(
      [work({ _id: 'asks', openQuestions: 1 }), work({ _id: 'vague', nextStep: null })],
      NOW,
    );
    expect(snapshot.currentMove).toBeNull();
    expect(snapshot.needsYou.map((row) => row._id)).toEqual(['asks']);
  });

  test('a passed block becomes recovery work instead of silently becoming current again', () => {
    const snapshot = selectExecutionSnapshot(
      [
        work({ _id: 'passed', scheduledStartAt: NOW - 120_000, scheduledEndAt: NOW - 60_000 }),
        work({ _id: 'open' }),
      ],
      NOW,
    );
    expect(snapshot.currentMove?.workId).toBe('open');
    expect(snapshot.missedMoves.map((row) => row.workId)).toEqual(['passed']);
  });

  test('waiting, paused, and closed work never competes for the move', () => {
    const snapshot = selectExecutionSnapshot(
      [
        work({ _id: 'waiting', workState: 'waiting' }),
        work({ _id: 'paused', workState: 'paused' }),
        work({ _id: 'done', workState: 'done' }),
      ],
      NOW,
    );
    expect(snapshot.currentMove).toBeNull();
    expect(snapshot.missedMoves).toEqual([]);
  });
});

describe('the execution projection read budget', () => {
  test('keeps every returned step complete at the maximum plans and applied steps', () => {
    const plans = Array.from({ length: 500 }, (_, planIndex) => ({
      planIndex,
      cardIds: Array.from({ length: 60 }, (_, stepIndex) => `card-${planIndex}-${stepIndex}`),
    }));

    const projection = selectCardCompleteProjection(plans, (plan) => plan.cardIds);
    const selectedCardIds = new Set(projection.cardIds);

    expect(projection.cardIds.length).toBeLessThanOrEqual(INTERACTIVE_CARD_READ_BUDGET);
    expect(projection.items.length).toBeGreaterThan(0);
    expect(projection.items.length).toBeLessThan(plans.length);
    for (const plan of projection.items) {
      expect(plan.cardIds.every((cardId) => selectedCardIds.has(cardId))).toBe(true);
    }
  });
});
