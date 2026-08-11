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
