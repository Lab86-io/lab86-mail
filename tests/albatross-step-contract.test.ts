import { describe, expect, test } from 'bun:test';
import {
  normalizeDigitalStepContract,
  normalizeStepEvidence,
  normalizeStepMode,
  stepModeAcceptsRun,
  stepModeRunsAlone,
} from '../lib/albatross/step-contract';

describe('step contract', () => {
  test('keeps the four modes and drops anything else', () => {
    expect(normalizeStepMode('agent_does')).toBe('agent_does');
    expect(normalizeStepMode('you_do_offline')).toBe('you_do_offline');
    expect(normalizeStepMode('agent_drafts_you_approve')).toBeUndefined();
    expect(normalizeStepMode(3)).toBeUndefined();
    expect(normalizeStepMode(null)).toBeUndefined();
  });

  test('keeps a known evidence kind with a bounded hint', () => {
    expect(normalizeStepEvidence({ kind: 'artifact', hint: `  ${'h'.repeat(400)}` })).toEqual({
      kind: 'artifact',
      hint: 'h'.repeat(300),
    });
    expect(normalizeStepEvidence({ kind: 'artifact', hint: '   ' })).toEqual({ kind: 'artifact' });
    expect(normalizeStepEvidence({ kind: 'screenshot' })).toBeUndefined();
    expect(normalizeStepEvidence('artifact')).toBeUndefined();
  });

  test('normalizes a digital action and keeps every other field', () => {
    expect(
      normalizeDigitalStepContract<Record<string, unknown>>({
        actionKey: 'a1',
        kind: 'document',
        title: 'Draft the proposal',
        stepMode: 'robot',
        doneWhen: '  The proposal exists.  ',
        evidence: { kind: 'nope' },
      }),
    ).toEqual({
      actionKey: 'a1',
      kind: 'document',
      title: 'Draft the proposal',
      doneWhen: 'The proposal exists.',
    });
    expect(
      normalizeDigitalStepContract({
        title: 'Research',
        stepMode: 'agent_does',
        evidence: { kind: 'artifact' },
      }),
    ).toEqual({ title: 'Research', stepMode: 'agent_does', evidence: { kind: 'artifact' } });
    expect(normalizeDigitalStepContract(null)).toBeNull();
    expect(normalizeDigitalStepContract(['x'])).toEqual(['x']);
  });

  test('says which steps the runner may take', () => {
    expect(stepModeRunsAlone('agent_does')).toBe(true);
    expect(stepModeRunsAlone('agent_drafts')).toBe(true);
    expect(stepModeRunsAlone('you_do_observed')).toBe(false);
    expect(stepModeRunsAlone(null)).toBe(false);
    expect(stepModeAcceptsRun('you_do_observed')).toBe(true);
    expect(stepModeAcceptsRun('you_do_offline')).toBe(false);
    expect(stepModeAcceptsRun(null, 'task')).toBe(true);
    expect(stepModeAcceptsRun(undefined, 'physical')).toBe(false);
  });
});
