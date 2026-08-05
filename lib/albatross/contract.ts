// The outcome contract.
//
// This is the part of Albatross that a conversation product cannot copy by
// bolting on connectors. Before the system may say something is done it has to
// have written down, in advance, what done means and what would settle it.
// Otherwise "closed" is a status somebody typed.
//
// Confidence stays a server-side number. What reaches the screen is a level and
// a sentence.

import { type EvidenceLike, latestProof, PROOF_LEVEL_LABEL, type ProofLevel, proofLevel } from './proof';

export type CloseWhen = 'action_succeeded' | 'outcome_likely' | 'outcome_confirmed' | 'never_automatically';

export interface ContractProof {
  id: string;
  what: string;
  satisfiedBy?: string | null;
  satisfiedAt?: number | null;
}

export interface OutcomeContract {
  outcome: string;
  proofs: ContractProof[];
  closeWhen: CloseWhen;
  contradictions?: string[];
  updatedAt?: number;
}

export const CLOSE_WHEN_LABEL: Record<CloseWhen, string> = {
  action_succeeded: 'When the action goes through',
  outcome_likely: 'When it looks done',
  outcome_confirmed: 'Only when something confirms it',
  never_automatically: 'Never without asking me',
};

export const CLOSE_WHEN_NOTE: Record<CloseWhen, string> = {
  action_succeeded: 'Fine for a low-risk, reversible thing like sending an email.',
  outcome_likely: 'Good when the signal is strong but nobody replies to confirm.',
  outcome_confirmed: 'For anything with money, a deadline, or another person in it.',
  never_automatically: 'For anything you would be upset to see closed on your behalf.',
};

/** Which proofs the contract still needs. */
export function outstandingProofs(contract: OutcomeContract): ContractProof[] {
  return contract.proofs.filter((proof) => !proof.satisfiedAt);
}

export function satisfiedProofs(contract: OutcomeContract): ContractProof[] {
  return contract.proofs.filter((proof) => Boolean(proof.satisfiedAt));
}

export function contractProgress(contract: OutcomeContract): { met: number; total: number } {
  return { met: satisfiedProofs(contract).length, total: contract.proofs.length };
}

/**
 * May Albatross close this by itself?
 *
 * The rule errs toward asking. A false close is far more damaging than a
 * missed one: it tells somebody a thing is handled when it is not, which is
 * the one failure that would make the whole product untrustworthy.
 */
export function mayCloseAutomatically(
  contract: OutcomeContract | null | undefined,
  evidence: EvidenceLike[],
): boolean {
  if (!contract) return false;
  if (contract.closeWhen === 'never_automatically') return false;
  // Every named proof must be accounted for, whatever the trust level says.
  if (outstandingProofs(contract).length > 0) return false;
  const level = proofLevel(evidence);
  if (contract.closeWhen === 'outcome_confirmed') return level === 'confirmed';
  if (contract.closeWhen === 'outcome_likely') return level === 'confirmed' || level === 'likely';
  return level !== 'none';
}

/** What Albatross says about where the outcome stands, without a score. */
export function contractStatusLine(
  contract: OutcomeContract | null | undefined,
  evidence: EvidenceLike[],
): string {
  if (!contract) return 'Albatross has not written down what done means yet.';
  const { met, total } = contractProgress(contract);
  if (total === 0) return 'Nothing named yet that would settle this.';
  if (met === 0) return `Nothing has settled any of the ${total} things this needs.`;
  if (met < total) {
    const left = total - met;
    return left === 1 ? 'One thing left to settle this.' : `${left} things left to settle this.`;
  }
  if (mayCloseAutomatically(contract, evidence)) return 'Everything this needs has been settled.';
  return 'Everything is settled. Albatross is waiting for you to confirm.';
}

/**
 * What the outcome as a whole stands at.
 *
 * A single confirmed receipt does not mean the outcome is confirmed. The
 * evidence ladder describes one artifact; the contract describes the whole
 * thing. Reporting "Confirmed done" beside "2 things left to settle this" is
 * precisely the false certainty a proof system exists to prevent, so the
 * contract clamps the claim.
 */
export function outcomeStanding(
  contract: OutcomeContract | null | undefined,
  evidence: EvidenceLike[],
): { level: ProofLevel; label: string } {
  const level = proofLevel(evidence);
  if (!contract || contract.proofs.length === 0) {
    return { level, label: PROOF_LEVEL_LABEL[level] };
  }
  const outstanding = outstandingProofs(contract).length;
  if (outstanding > 0) {
    // Something has been seen, but the outcome is demonstrably not settled.
    return {
      level: level === 'none' ? 'none' : 'seen',
      label: level === 'none' ? 'Nothing has settled this yet' : 'Partly settled',
    };
  }
  if (contract.closeWhen === 'never_automatically' || !mayCloseAutomatically(contract, evidence)) {
    return { level, label: 'Settled — waiting on you' };
  }
  return { level, label: PROOF_LEVEL_LABEL[level] };
}

/**
 * Contradictions reopen an outcome. A bounced email or a reversed payment is
 * not a small correction — it means the thing did not happen after all.
 */
export function contradicted(contract: OutcomeContract | null | undefined, evidence: EvidenceLike[]) {
  if (!contract) return null;
  const rejected = evidence.filter((row) => row.trust === 'rejected');
  if (!rejected.length) return null;
  return latestProof(rejected.map((row) => ({ ...row, trust: 'observed' as const })));
}

/**
 * A first contract, proposed from the outcome. Albatross should always have an
 * opinion about what would settle a thing; the user corrects it rather than
 * authoring it from nothing.
 */
export function proposeContract(outcome: string, kind: 'send' | 'buy' | 'book' | 'general'): OutcomeContract {
  const base: Record<string, string[]> = {
    send: ['The message left your account', 'The person acknowledged it'],
    buy: ['The purchase was charged', 'The confirmation arrived'],
    book: ['The booking was confirmed', 'It is on your calendar'],
    general: ['Something confirms it happened'],
  };
  const closeWhen: CloseWhen =
    kind === 'send' ? 'outcome_likely' : kind === 'general' ? 'outcome_confirmed' : 'outcome_confirmed';
  return {
    outcome,
    proofs: base[kind].map((what, index) => ({ id: `${kind}-${index}`, what })),
    closeWhen,
    contradictions:
      kind === 'send'
        ? ['The message bounced', 'They said they never got it']
        : kind === 'buy'
          ? ['The charge was reversed', 'The order was cancelled']
          : undefined,
  };
}
