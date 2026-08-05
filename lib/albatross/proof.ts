// Proof is the part of Albatross that a conversation product cannot copy: it
// does not merely remember an intention, it watches for evidence that the
// outcome actually happened.
//
// The stored `trust` ladder already carries that idea. This maps it to what the
// user is told. `confidence` stays on the server and is never rendered — a
// score about somebody's own life is machinery, not information.

export type EvidenceTrust = 'observed' | 'inferred' | 'confirmed' | 'rejected';

export interface EvidenceLike {
  _id?: string;
  title: string;
  summary?: string | null;
  /** What this artifact is claimed to prove. */
  claim?: string | null;
  /** What it cannot settle — stated so a claim never overreaches. */
  limits?: string | null;
  url?: string | null;
  sourceKind: string;
  occurredAt: number;
  trust: EvidenceTrust;
}

export type ProofLevel = 'none' | 'seen' | 'likely' | 'confirmed';

export const PROOF_LEVEL_LABEL: Record<ProofLevel, string> = {
  none: 'No proof yet',
  seen: 'Something happened',
  likely: 'Looks done',
  confirmed: 'Confirmed done',
};

/** What kind of thing the proof came from, in words a person would use. */
export const EVIDENCE_SOURCE_LABEL: Record<string, string> = {
  mail_thread: 'An email',
  calendar_event: 'A calendar event',
  task: 'A task',
  chat: 'A conversation',
  question_answer: 'Your answer',
  area_fact: 'Something Albatross knows',
  github_issue: 'A GitHub issue',
  github_pull_request: 'A pull request',
  github_project: 'A GitHub project',
  github_project_item: 'A GitHub project item',
  github_commit: 'A commit',
  mcp_item: 'A connected service',
  manual: 'You',
};

export function evidenceSourceLabel(sourceKind: string): string {
  return EVIDENCE_SOURCE_LABEL[sourceKind] || 'A connected service';
}

/**
 * The strongest thing the evidence supports. Rejected evidence proves nothing,
 * so it never raises the level — it only stops a claim from standing.
 */
export function proofLevel(evidence: EvidenceLike[]): ProofLevel {
  let level: ProofLevel = 'none';
  for (const row of evidence) {
    if (row.trust === 'confirmed') return 'confirmed';
    if (row.trust === 'inferred' && level !== 'likely') level = 'likely';
    else if (row.trust === 'observed' && level === 'none') level = 'seen';
  }
  return level;
}

/** The most recent piece of proof, ignoring anything already rejected. */
export function latestProof(evidence: EvidenceLike[]): EvidenceLike | null {
  const usable = evidence.filter((row) => row.trust !== 'rejected');
  if (!usable.length) return null;
  return usable.reduce((newest, row) => (row.occurredAt > newest.occurredAt ? row : newest));
}

/**
 * The Last proof fact in the Albatross header. Says nothing rather than
 * inventing certainty, and never quotes a number.
 */
export function proofSummary(evidence: EvidenceLike[]): string {
  const level = proofLevel(evidence);
  if (level === 'none') return PROOF_LEVEL_LABEL.none;
  // The claim and the source have to come from the same row, or the line says
  // "Confirmed done · a calendar event" while the calendar event proved nothing
  // and a different email did the confirming.
  const source = strongestProof(evidence, level) ?? latestProof(evidence);
  if (!source) return PROOF_LEVEL_LABEL.none;
  return `${PROOF_LEVEL_LABEL[level]} · ${evidenceSourceLabel(source.sourceKind).toLowerCase()}`;
}

/** The newest row that actually carries the level the summary is claiming. */
function strongestProof(evidence: EvidenceLike[], level: ProofLevel): EvidenceLike | null {
  const trust = level === 'confirmed' ? 'confirmed' : level === 'likely' ? 'inferred' : 'observed';
  const matching = evidence.filter((row) => row.trust === trust);
  if (!matching.length) return null;
  return matching.reduce((newest, row) => (row.occurredAt > newest.occurredAt ? row : newest));
}
