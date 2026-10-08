import { describe, expect, mock, test } from 'bun:test';
import { evidenceSatisfies } from '../lib/albatross/evidence-gate';

describe('evidenceSatisfies', () => {
  test('confirms when the model confirms', async () => {
    const generateObject = mock(async () => ({
      object: { satisfies: true, reason: 'The order confirmation names the sheets.' },
    }));
    const verdict = await evidenceSatisfies(
      {
        userId: 'user-1',
        workTitle: 'Order new sheets for Tree',
        outcome: 'The new sheets are ordered',
        requirement: 'The order confirmation arrived',
        evidenceText: 'MagicLinen: your order 4417 is confirmed',
      },
      { generateObject: generateObject as any },
    );
    expect(verdict.satisfies).toBe(true);
    expect(verdict.unavailable).toBeUndefined();
    const options = (generateObject.mock.calls[0] as any[])[0];
    expect(options.feature).toBe('albatross_evidence_gate');
  });

  test('refutes word-overlap coincidences', async () => {
    const generateObject = mock(async () => ({
      object: { satisfies: false, reason: 'Marketing mail shares words only.' },
    }));
    const verdict = await evidenceSatisfies(
      {
        userId: 'user-1',
        workTitle: 'Watch The Green Book',
        requirement: 'Progress toward: Watch The Green Book',
        evidenceText: 'Book your green getaway and watch the savings grow',
      },
      { generateObject: generateObject as any },
    );
    expect(verdict.satisfies).toBe(false);
    expect(verdict.unavailable).toBeUndefined();
  });

  test('a gate failure is unavailable, not a verdict', async () => {
    const verdict = await evidenceSatisfies(
      {
        userId: 'user-1',
        workTitle: 'Renew passport',
        requirement: 'The confirmation arrived',
        evidenceText: 'Application received',
      },
      { generateObject: mock(async () => Promise.reject(new Error('offline'))) as any },
    );
    expect(verdict.satisfies).toBe(false);
    expect(verdict.unavailable).toBe(true);
  });

  test('empty inputs never satisfy and never call the model', async () => {
    const generateObject = mock(async () => ({ object: { satisfies: true, reason: 'x' } }));
    const verdict = await evidenceSatisfies(
      { userId: 'user-1', workTitle: 'X', requirement: '  ', evidenceText: 'Y' },
      { generateObject: generateObject as any },
    );
    expect(verdict.satisfies).toBe(false);
    expect(generateObject).not.toHaveBeenCalled();
  });
});

// A step run's own record (docs/albatross-document-handoff.md, D1): the
// "Observed" lines are facts, so a research step can pass on them.
describe('evidenceSatisfies for a step run', () => {
  const input = {
    userId: 'user-1',
    workTitle: 'Send the Harbor Design hours invoice',
    requirement: 'The client billing address is known',
    evidenceText: 'Observed search_threads: billing@example.com',
  };

  function gate() {
    return mock(async (_options: any) => ({ object: { satisfies: true, reason: 'The search shows it.' } }));
  }

  test('source run uses its own rules, which read the Observed lines', async () => {
    const runGate = gate();
    const mailGate = gate();
    await evidenceSatisfies({ ...input, source: 'run' }, { generateObject: runGate as any });
    await evidenceSatisfies(input, { generateObject: mailGate as any });
    const runSystem = (runGate.mock.calls[0] as any[])[0].system as string;
    const mailSystem = (mailGate.mock.calls[0] as any[])[0].system as string;
    expect(runSystem).toContain('Observed');
    expect(runSystem).toContain('User said');
    expect(runSystem).not.toBe(mailSystem);
    expect(mailSystem).not.toContain('Observed');
  });

  test('source run reads 8,000 evidence characters; the default stays at 4,000', async () => {
    const long = 'e'.repeat(9_000);
    const runGate = gate();
    const mailGate = gate();
    await evidenceSatisfies(
      { ...input, source: 'run', evidenceText: long },
      { generateObject: runGate as any },
    );
    await evidenceSatisfies({ ...input, evidenceText: long }, { generateObject: mailGate as any });
    const runEvidence = JSON.parse((runGate.mock.calls[0] as any[])[0].prompt).evidence as string;
    const mailEvidence = JSON.parse((mailGate.mock.calls[0] as any[])[0].prompt).evidence as string;
    expect(runEvidence).toHaveLength(8_000);
    expect(mailEvidence).toHaveLength(4_000);
  });
});
