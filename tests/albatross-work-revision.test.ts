import { describe, expect, test } from 'bun:test';
import { summarizeWorkPlanRevision } from '../lib/albatross/work-revision';

describe('Albatross Work plan revisions', () => {
  test('explains removed, retained, and newly next steps', () => {
    const revision = summarizeWorkPlanRevision(
      {
        outcome: 'Passport renewed',
        digitalActions: [
          { actionKey: 'photos', title: 'Buy passport photos' },
          { actionKey: 'form', title: 'Complete DS-82' },
        ],
      },
      {
        outcome: 'Passport renewed',
        digitalActions: [
          { actionKey: 'form', title: 'Complete DS-82' },
          { actionKey: 'mail', title: 'Mail the application' },
        ],
      },
    );

    expect(revision).toEqual({
      changed: true,
      currentStep: 'Complete DS-82',
      keptSteps: ['Complete DS-82'],
      removedSteps: ['Buy passport photos'],
      addedSteps: ['Mail the application'],
    });
  });

  test('uses normalized titles when older plans do not have action keys', () => {
    const revision = summarizeWorkPlanRevision(
      { digitalActions: [{ kind: 'task', title: '  Complete   DS-82 ' }] },
      { digitalActions: [{ kind: 'task', title: 'Complete DS-82' }] },
    );
    expect(revision.changed).toBe(false);
    expect(revision.keptSteps).toEqual(['Complete DS-82']);
  });

  test('keeps a legacy keyed step when a stable action key is added later', () => {
    const revision = summarizeWorkPlanRevision(
      { digitalActions: [{ key: 'step-1', kind: 'task', title: 'Complete DS-82' }] },
      {
        digitalActions: [
          { key: 'step-7', actionKey: 'task:complete-ds-82', kind: 'task', title: 'Complete DS-82' },
        ],
      },
    );
    expect(revision.changed).toBe(false);
    expect(revision.keptSteps).toEqual(['Complete DS-82']);
  });

  test('does not collapse different stable action keys with identical copy', () => {
    const revision = summarizeWorkPlanRevision(
      { digitalActions: [{ actionKey: 'old-form', kind: 'task', title: 'Complete DS-82' }] },
      { digitalActions: [{ actionKey: 'replacement-form', kind: 'task', title: 'Complete DS-82' }] },
    );
    expect(revision.changed).toBe(true);
    expect(revision.keptSteps).toEqual([]);
    expect(revision.removedSteps).toEqual(['Complete DS-82']);
    expect(revision.addedSteps).toEqual(['Complete DS-82']);
  });

  test('keeps the actionable task as current when its calendar hold comes first', () => {
    const result = summarizeWorkPlanRevision(null, {
      digitalActions: [
        { actionKey: 'hold', kind: 'calendar_event', title: 'Passport focus block' },
        { actionKey: 'form', kind: 'task', title: 'Complete DS-82' },
      ],
    });
    expect(result.currentStep).toBe('Complete DS-82');
  });
});

describe('physical steps in revisions', () => {
  test('physical actions revise by normalized title like any other step', () => {
    const revision = summarizeWorkPlanRevision(
      {
        digitalActions: [],
        physicalActions: [{ title: 'Visit the county office' }, { title: 'Mail the packet' }],
      },
      {
        digitalActions: [],
        physicalActions: [{ title: 'Mail the packet' }, { title: 'Get fingerprinted' }],
      },
    );
    expect(revision.changed).toBe(true);
    expect(revision.keptSteps).toEqual(['Mail the packet']);
    expect(revision.removedSteps).toEqual(['Visit the county office']);
    expect(revision.addedSteps).toEqual(['Get fingerprinted']);
  });
});
