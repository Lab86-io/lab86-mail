import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CLOSE_WHEN_LABEL,
  CLOSE_WHEN_NOTE,
  type CloseWhen,
  contractProgress,
  contractStatusLine,
  contradicted,
  mayCloseAutomatically,
  type OutcomeContract,
  outcomeStanding,
  outstandingProofs,
  proposeContract,
} from '../lib/albatross/contract';
import type { EvidenceLike } from '../lib/albatross/proof';

const ev = (trust: EvidenceLike['trust'], at = 1): EvidenceLike => ({
  title: `evidence ${at}`,
  sourceKind: 'mail_thread',
  occurredAt: at,
  trust,
});

const contract = (over: Partial<OutcomeContract> = {}): OutcomeContract => ({
  outcome: over.outcome ?? 'An active policy exists and proof reached the office.',
  proofs: over.proofs ?? [
    { id: 'a', what: 'The policy is active' },
    { id: 'b', what: 'The office confirmed receipt' },
  ],
  closeWhen: over.closeWhen ?? 'outcome_confirmed',
  contradictions: over.contradictions,
});

describe('mayCloseAutomatically errs toward asking', () => {
  // A false close is far worse than a missed one: it tells somebody a thing is
  // handled when it is not, which is the single failure that would make the
  // whole product untrustworthy.
  test('never closes without a contract', () => {
    expect(mayCloseAutomatically(null, [ev('confirmed')])).toBe(false);
    expect(mayCloseAutomatically(undefined, [ev('confirmed')])).toBe(false);
  });

  test('never closes while a named condition is outstanding', () => {
    expect(mayCloseAutomatically(contract(), [ev('confirmed')])).toBe(false);
  });

  test('never closes when the contract forbids it, however strong the proof', () => {
    const settled = contract({
      closeWhen: 'never_automatically',
      proofs: [{ id: 'a', what: 'done', satisfiedAt: 1 }],
    });
    expect(mayCloseAutomatically(settled, [ev('confirmed')])).toBe(false);
  });

  test('confirmed-only contracts are not satisfied by a guess', () => {
    const settled = contract({ proofs: [{ id: 'a', what: 'done', satisfiedAt: 1 }] });
    expect(mayCloseAutomatically(settled, [ev('inferred')])).toBe(false);
    expect(mayCloseAutomatically(settled, [ev('confirmed')])).toBe(true);
  });

  test('a looser contract accepts a likely outcome, but never nothing', () => {
    const settled = contract({
      closeWhen: 'outcome_likely',
      proofs: [{ id: 'a', what: 'done', satisfiedAt: 1 }],
    });
    expect(mayCloseAutomatically(settled, [])).toBe(false);
    expect(mayCloseAutomatically(settled, [ev('inferred')])).toBe(true);
  });

  test('the loosest contract still needs something to have happened', () => {
    const settled = contract({
      closeWhen: 'action_succeeded',
      proofs: [{ id: 'a', what: 'sent', satisfiedAt: 1 }],
    });
    expect(mayCloseAutomatically(settled, [])).toBe(false);
    expect(mayCloseAutomatically(settled, [ev('rejected')])).toBe(false);
    expect(mayCloseAutomatically(settled, [ev('observed')])).toBe(true);
  });
});

describe('the contract says where things stand, without a score', () => {
  test('it counts conditions, never confidence', () => {
    const line = contractStatusLine(contract(), []);
    expect(line).toContain('Nothing has settled');
    expect(line.toLowerCase()).not.toContain('confidence');
    expect(line).not.toContain('%');
  });

  test('a partially settled contract says what is left', () => {
    const partial = contract({
      proofs: [
        { id: 'a', what: 'one', satisfiedAt: 1 },
        { id: 'b', what: 'two' },
      ],
    });
    expect(contractStatusLine(partial, [])).toBe('One thing left to settle this.');
    expect(contractProgress(partial)).toEqual({ met: 1, total: 2 });
    expect(outstandingProofs(partial).map((p) => p.id)).toEqual(['b']);
  });

  test('settled but unconfirmable says it is waiting on the user', () => {
    const settled = contract({
      closeWhen: 'never_automatically',
      proofs: [{ id: 'a', what: 'one', satisfiedAt: 1 }],
    });
    expect(contractStatusLine(settled, [ev('confirmed')])).toContain('waiting for you to confirm');
  });

  test('an Albatross with no contract says so rather than implying certainty', () => {
    expect(contractStatusLine(null, [])).toContain('has not written down what done means');
  });
});

describe('the contract clamps what proof may claim', () => {
  // Live defect this replaces: the page showed a "Confirmed done" pill beside
  // "2 things left to settle this." The evidence ladder describes one artifact;
  // the contract describes the whole outcome.
  test('one confirmed receipt is not a confirmed outcome', () => {
    const partial = contract({
      proofs: [
        { id: 'a', what: 'one', satisfiedAt: 1 },
        { id: 'b', what: 'two' },
      ],
    });
    const standing = outcomeStanding(partial, [ev('confirmed')]);
    expect(standing.label).toBe('Partly settled');
    expect(standing.label.toLowerCase()).not.toContain('confirmed');
  });

  test('nothing seen says nothing, rather than implying progress', () => {
    expect(outcomeStanding(contract(), []).label).toBe('Nothing has settled this yet');
  });

  test('all conditions met but not closable says it is waiting on the user', () => {
    const settled = contract({
      closeWhen: 'never_automatically',
      proofs: [{ id: 'a', what: 'one', satisfiedAt: 1 }],
    });
    expect(outcomeStanding(settled, [ev('confirmed')]).label).toBe('Settled — waiting on you');
  });

  test('with no contract it falls back to what the evidence supports', () => {
    expect(outcomeStanding(null, [ev('confirmed')]).level).toBe('confirmed');
  });
});

describe('contradictions reopen an outcome', () => {
  test('rejected evidence surfaces as a contradiction', () => {
    const conflict = contradicted(contract(), [ev('confirmed', 1), ev('rejected', 5)]);
    expect(conflict?.occurredAt).toBe(5);
  });

  test('no rejected evidence means no contradiction', () => {
    expect(contradicted(contract(), [ev('confirmed')])).toBeNull();
  });
});

describe('a proposed contract always has an opinion', () => {
  test('every kind proposes something the user can correct', () => {
    for (const kind of ['send', 'buy', 'book', 'general'] as const) {
      const proposed = proposeContract('Do the thing', kind);
      expect(proposed.proofs.length).toBeGreaterThan(0);
      expect(proposed.outcome).toBe('Do the thing');
      expect(CLOSE_WHEN_LABEL[proposed.closeWhen]).toBeTruthy();
    }
  });

  test('money and other people demand confirmation', () => {
    expect(proposeContract('Buy it', 'buy').closeWhen).toBe('outcome_confirmed');
    expect(proposeContract('Book it', 'book').closeWhen).toBe('outcome_confirmed');
  });

  test('a purchase knows what would undo it', () => {
    expect(proposeContract('Buy it', 'buy').contradictions).toContain('The charge was reversed');
  });
});

describe('every closing rule is explained in plain words', () => {
  test('each has a label and a note a person could act on', () => {
    for (const key of Object.keys(CLOSE_WHEN_LABEL) as CloseWhen[]) {
      expect(CLOSE_WHEN_LABEL[key]).toBeTruthy();
      expect(CLOSE_WHEN_NOTE[key].length).toBeGreaterThan(20);
      expect(CLOSE_WHEN_LABEL[key].toLowerCase()).not.toContain('confidence');
    }
  });
});

describe('the surfaces carry it', () => {
  test('the Albatross page shows the contract and the proof timeline', () => {
    const detail = readFileSync('components/albatross/WorkDetail.tsx', 'utf8');
    expect(detail).toContain('OutcomeContractCard');
    expect(detail).toContain('ProofTimeline');
  });

  test('mail offers itself as proof', () => {
    const thread = readFileSync('components/thread/ThreadView.tsx', 'utf8');
    expect(thread).toContain('ProofOffer');
    const offer = readFileSync('components/thread/ProofOffer.tsx', 'utf8');
    // It asks; it never asserts, and it is always dismissible.
    expect(offer).toContain('Does this settle something you are carrying?');
    expect(offer).toContain('Not related');
  });

  test('proof stores a claim, not just a source id', () => {
    const schema = readFileSync('convex/schema.ts', 'utf8');
    expect(schema).toContain('claim: v.optional(v.string())');
    expect(schema).toContain('limits: v.optional(v.string())');
    const server = readFileSync('convex/albatrossWorkV2.ts', 'utf8');
    expect(server).toContain('attachProof');
    expect(server).toContain('saveContract');
  });

  test('guided work names what only the user can do', () => {
    const guided = readFileSync('components/albatross/GuidedStep.tsx', 'utf8');
    expect(guided).toContain('Only you can do');
    expect(guided).toContain('Guide me');
    expect(guided).toContain('Handle it');
  });
});
