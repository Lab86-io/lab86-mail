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
