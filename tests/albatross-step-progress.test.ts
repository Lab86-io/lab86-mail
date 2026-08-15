import { describe, expect, test } from 'bun:test';
import {
  completedStepIdentity,
  mergeStepProgress,
  planStepsForProgress,
  progressFromPlanCompletions,
} from '../lib/albatross/step-progress';

describe('Work-level guided-step progress', () => {
  test('a stable action key survives regenerated local keys and copy edits', () => {
    const before = planStepsForProgress({
      digitalActions: [
        {
          key: 'step-1',
          actionKey: 'official_form',
          kind: 'task',
          title: 'Open the form',
        },
      ],
    })[0];
    const after = planStepsForProgress({
      digitalActions: [
        {
          key: 'step-9',
          actionKey: 'official_form',
          kind: 'task',
          title: 'Open the official application form',
        },
      ],
    })[0];

    expect(before.key).not.toBe(after.key);
    expect(before.identity).toBe('action:official_form');
    expect(after.identity).toBe(before.identity);
  });

  test('exact kind and title are the conservative fallback', () => {
    expect(completedStepIdentity({ kind: 'physical', title: 'Mail the packet' })).toBe(
      'step:physical:mail the packet',
    );
    expect(completedStepIdentity({ kind: 'physical', title: 'Mail packet' })).not.toBe(
      completedStepIdentity({ kind: 'physical', title: 'Mail the packet' }),
    );
  });

  test('legacy plan completions migrate into the Work ledger once', () => {
    const plan = {
      digitalActions: [
        {
          key: 'submit',
          actionKey: 'submit_application',
          kind: 'task',
          title: 'Submit the application',
        },
      ],
      completedSteps: [{ stepKey: 'submit', completedAt: 42, source: 'user' as const }],
    };
    const migrated = progressFromPlanCompletions(plan);
    const merged = mergeStepProgress(migrated, progressFromPlanCompletions(plan));

    expect(merged).toEqual([
      expect.objectContaining({
        identity: 'action:submit_application',
        title: 'Submit the application',
        completedAt: 42,
      }),
    ]);
  });

  test('a bound card is stable when no action key exists', () => {
    const step = planStepsForProgress({
      digitalActions: [{ key: 'book', kind: 'task', title: 'Book the appointment' }],
      appliedSteps: [{ stepKey: 'book', cardId: 'card-123' }],
    })[0];
    expect(step.identity).toBe('card:card-123');
  });
});
