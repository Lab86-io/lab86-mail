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

  test('binding a card does not change a titled step identity', () => {
    const before = planStepsForProgress({
      digitalActions: [{ key: 'book', kind: 'task', title: 'Book the appointment' }],
    })[0];
    const after = planStepsForProgress({
      digitalActions: [{ key: 'book', kind: 'task', title: 'Book the appointment' }],
      appliedSteps: [{ stepKey: 'book', cardId: 'card-123' }],
    })[0];
    expect(before.identity).toBe('step:task:book the appointment');
    expect(after.identity).toBe(before.identity);
    expect(
      mergeStepProgress(
        [
          {
            identity: before.identity,
            kind: 'task',
            title: 'Book the appointment',
            completedAt: 1,
            source: 'user',
          },
        ],
        progressFromPlanCompletions({
          digitalActions: [{ key: 'book', kind: 'task', title: 'Book the appointment' }],
          appliedSteps: [{ stepKey: 'book', cardId: 'card-123' }],
        }),
      ),
    ).toHaveLength(1);
  });

  test('merge preserves the first completion and retains the newest 120 identities', () => {
    const entries = Array.from({ length: 125 }, (_, index) => ({
      identity: `step:task:${index}`,
      kind: 'task',
      title: `Step ${index}`,
      completedAt: index,
      source: 'user' as const,
    }));
    const merged = mergeStepProgress(entries, [
      { ...entries[124], completedAt: 999, source: 'evidence' },
    ]);

    expect(merged).toHaveLength(120);
    expect(merged[0].identity).toBe('step:task:5');
    expect(merged.at(-1)).toMatchObject({
      identity: 'step:task:124',
      completedAt: 124,
      source: 'user',
    });
  });
});
