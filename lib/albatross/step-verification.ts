/**
 * How a completed step earned its check. The ladder is honest by construction:
 * a self-reported step can never display as verified, and understating is the
 * only permitted direction of error.
 *
 * - reported: someone said so, and nothing else backs it.
 * - artifact: a note, file, number, or task record is attached to the step.
 * - observed: an agent saw the completion state on the page itself.
 * - confirmed: an external receipt arrived — mail or a calendar record.
 */

export type StepVerificationLevel = 'reported' | 'artifact' | 'observed' | 'confirmed';

export interface StepEvidenceLike {
  stepIdentity?: string | null;
  sourceKind: string;
  title?: string | null;
  url?: string | null;
  trust?: string | null;
}

export interface StepVerification {
  level: StepVerificationLevel;
  evidenceTitle: string | null;
  evidenceUrl: string | null;
}

export const STEP_VERIFICATION_LABEL: Record<StepVerificationLevel, string> = {
  reported: 'Marked done',
  artifact: 'Noted',
  observed: 'Verified on the page',
  confirmed: 'Confirmed',
};

const LEVEL_RANK: Record<StepVerificationLevel, number> = {
  reported: 0,
  artifact: 1,
  observed: 2,
  confirmed: 3,
};

function levelForSource(sourceKind: string): StepVerificationLevel {
  if (sourceKind === 'mail_thread' || sourceKind === 'calendar_event') return 'confirmed';
  if (sourceKind === 'browser_session') return 'observed';
  return 'artifact';
}

/** The strongest step-bound evidence wins; no evidence means reported. */
export function stepVerification(
  identity: string,
  done: boolean,
  evidence: readonly StepEvidenceLike[],
): StepVerification | null {
  if (!done) return null;
  let best: StepVerification = { level: 'reported', evidenceTitle: null, evidenceUrl: null };
  for (const row of evidence) {
    if (!row.stepIdentity || row.stepIdentity !== identity) continue;
    if (row.trust === 'rejected') continue;
    const level = levelForSource(row.sourceKind);
    if (LEVEL_RANK[level] > LEVEL_RANK[best.level]) {
      best = { level, evidenceTitle: row.title || null, evidenceUrl: row.url || null };
    }
  }
  return best;
}
