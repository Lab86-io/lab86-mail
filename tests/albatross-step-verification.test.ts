import { describe, expect, test } from 'bun:test';
import { parsePlanGeneration } from '../lib/albatross/intent-plan';
import { stepVerification } from '../lib/albatross/step-verification';

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
