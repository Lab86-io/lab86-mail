import { describe, expect, test } from 'bun:test';
import { parsePlanGeneration } from '../lib/albatross/intent-plan';
import {
  hasConfirmedEvidence,
  isFinalVerification,
  stepNeedsCheck,
  stepVerification,
} from '../lib/albatross/step-verification';

describe('stepVerification', () => {
  const identity = 'step:physical:submit the packet';

  test('an unfinished step has no verification', () => {
    expect(stepVerification(identity, false, [])).toBeNull();
  });

  test('a done step with no evidence is only reported', () => {
    expect(stepVerification(identity, true, [])).toEqual({
      level: 'reported',
      evidenceTitle: null,
      evidenceUrl: null,
    });
  });

  test('the strongest step-bound evidence wins', () => {
    const verification = stepVerification(identity, true, [
      { stepIdentity: identity, sourceKind: 'manual', title: 'Noted on: Submit the packet' },
      {
        stepIdentity: identity,
        sourceKind: 'mail_thread',
        title: 'Your application was received',
        url: null,
      },
      { stepIdentity: identity, sourceKind: 'browser_session', title: 'Confirmation page reached' },
    ]);
    expect(verification?.level).toBe('confirmed');
    expect(verification?.evidenceTitle).toBe('Your application was received');
  });

  test('each evidence source maps to its own honest level', () => {
    const cases: Array<[string, string]> = [
      ['mail_thread', 'confirmed'],
      ['calendar_event', 'confirmed'],
      ['browser_session', 'observed'],
      ['manual', 'artifact'],
      ['task', 'artifact'],
      ['chat', 'artifact'],
    ];
    for (const [sourceKind, level] of cases) {
      const verification = stepVerification(identity, true, [
        { stepIdentity: identity, sourceKind, title: sourceKind },
      ]);
      expect(verification?.level).toBe(level as any);
    }
  });

  test('evidence bound to another step never counts', () => {
    const verification = stepVerification(identity, true, [
      { stepIdentity: 'step:task:another', sourceKind: 'mail_thread', title: 'Unrelated' },
    ]);
    expect(verification?.level).toBe('reported');
  });

  test('rejected evidence never raises the level', () => {
    const verification = stepVerification(identity, true, [
      { stepIdentity: identity, sourceKind: 'mail_thread', title: 'Contradicted', trust: 'rejected' },
    ]);
    expect(verification?.level).toBe('reported');
  });
});

describe('plan generation step contract', () => {
  test('parses stepMode, doneWhen, and evidence on both action kinds', () => {
    const generation = parsePlanGeneration(
      JSON.stringify({
        title: 'Renew the pistol permit',
        kind: 'obligation',
        outcome: 'The permit application is submitted',
        digitalActions: [
          {
            kind: 'task',
            title: 'Download the application form',
            stepMode: 'agent_does',
            doneWhen: 'The PDF is saved.',
            evidence: { kind: 'artifact', hint: 'The saved PDF' },
          },
        ],
        physicalActions: [
          {
            title: 'Submit the packet at the office',
            stepMode: 'you_do_offline',
            doneWhen: 'The clerk takes the packet.',
            evidence: { kind: 'mail_confirmation', hint: 'Receipt from the county office' },
          },
        ],
      }),
    );
    expect(generation.digitalActions[0].stepMode).toBe('agent_does');
    expect(generation.digitalActions[0].evidence?.kind).toBe('artifact');
    expect(generation.physicalActions[0].stepMode).toBe('you_do_offline');
    expect(generation.physicalActions[0].doneWhen).toBe('The clerk takes the packet.');
    expect(generation.physicalActions[0].evidence?.hint).toBe('Receipt from the county office');
  });

  test('null and invalid step-contract values collapse to undefined', () => {
    const generation = parsePlanGeneration(
      JSON.stringify({
        title: 'X',
        kind: 'task',
        outcome: 'Y',
        digitalActions: [{ kind: 'task', title: 'A', stepMode: 'robot_does', evidence: null }],
        physicalActions: [{ title: 'B', stepMode: null, doneWhen: null, evidence: { kind: 'nope' } }],
      }),
    );
    expect(generation.digitalActions[0].stepMode).toBeUndefined();
    expect(generation.digitalActions[0].evidence).toBeUndefined();
    expect(generation.physicalActions[0].stepMode).toBeUndefined();
    expect(generation.physicalActions[0].doneWhen).toBeUndefined();
    expect(generation.physicalActions[0].evidence).toBeUndefined();
  });
});

describe('terminal verification', () => {
  const identity = 'step:physical:book the venue';

  test('confirmed is final; every other level is not', () => {
    expect(isFinalVerification({ level: 'confirmed' })).toBe(true);
    expect(isFinalVerification({ level: 'observed' })).toBe(false);
    expect(isFinalVerification({ level: 'artifact' })).toBe(false);
    expect(isFinalVerification({ level: 'reported' })).toBe(false);
    expect(isFinalVerification(null)).toBe(false);
    expect(isFinalVerification(undefined)).toBe(false);
  });

  test('a calendar record or mail receipt bound to the step confirms it, even before it is marked done', () => {
    expect(hasConfirmedEvidence(identity, [{ stepIdentity: identity, sourceKind: 'calendar_event' }])).toBe(
      true,
    );
    expect(hasConfirmedEvidence(identity, [{ stepIdentity: identity, sourceKind: 'mail_thread' }])).toBe(
      true,
    );
    expect(hasConfirmedEvidence(identity, [{ stepIdentity: identity, sourceKind: 'browser_session' }])).toBe(
      false,
    );
    expect(hasConfirmedEvidence(identity, [{ stepIdentity: 'other', sourceKind: 'mail_thread' }])).toBe(
      false,
    );
    expect(
      hasConfirmedEvidence(identity, [
        { stepIdentity: identity, sourceKind: 'mail_thread', trust: 'rejected' },
      ]),
    ).toBe(false);
  });

  test('a watcher spends a check only on an open step without a confirmed verification', () => {
    expect(stepNeedsCheck({ done: false })).toBe(true);
    expect(stepNeedsCheck({ done: false, verification: null })).toBe(true);
    expect(stepNeedsCheck({ done: false, verification: { level: 'observed' } })).toBe(true);
    expect(stepNeedsCheck({ done: false, verification: { level: 'confirmed' } })).toBe(false);
    expect(stepNeedsCheck({ done: true })).toBe(false);
  });
});
