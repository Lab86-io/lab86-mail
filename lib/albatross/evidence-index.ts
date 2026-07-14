export type EvidenceTrust = 'observed' | 'inferred' | 'confirmed' | 'rejected';

export type EvidenceSourceKind =
  | 'mail_thread'
  | 'calendar_event'
  | 'task'
  | 'chat'
  | 'question_answer'
  | 'area_fact'
  | 'github_issue'
  | 'github_pull_request'
  | 'github_project'
  | 'github_project_item'
  | 'github_commit'
  | 'mcp_item'
  | 'manual';

// A source weight answers “how strongly does this prove the user did or meant
// something?”, not “how much data did this connector emit?”. Explicit answers
// and confirmed facts outrank artifact volume; a commit is meaningful activity
// but cannot by itself prove the containing Work is complete.
export const EVIDENCE_SOURCE_WEIGHTS: Record<EvidenceSourceKind, number> = {
  question_answer: 1,
  area_fact: 0.96,
  manual: 0.94,
  chat: 0.86,
  task: 0.84,
  github_pull_request: 0.76,
  github_project_item: 0.72,
  github_issue: 0.68,
  github_commit: 0.62,
  github_project: 0.6,
  calendar_event: 0.54,
  mail_thread: 0.46,
  mcp_item: 0.42,
};

const TRUST_MULTIPLIER: Record<EvidenceTrust, number> = {
  confirmed: 1,
  observed: 0.86,
  inferred: 0.58,
  rejected: 0,
};

export function clampUnit(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export function evidenceWeight(sourceKind: EvidenceSourceKind, trust: EvidenceTrust, confidence = 1) {
  return Number(
    (EVIDENCE_SOURCE_WEIGHTS[sourceKind] * TRUST_MULTIPLIER[trust] * clampUnit(confidence, 0.5)).toFixed(4),
  );
}

export function recencyFactor(input: {
  occurredAt: number;
  now?: number;
  halfLifeDays?: number;
  durable?: boolean;
}) {
  if (input.durable) return 1;
  const now = input.now ?? Date.now();
  const ageDays = Math.max(0, now - input.occurredAt) / 86_400_000;
  const halfLifeDays = Math.max(1, input.halfLifeDays ?? 45);
  // Activity becomes quieter, never erased. Historical provenance remains
  // available even when it should no longer dominate what matters now.
  return Number((0.3 + 0.7 * 2 ** (-ageDays / halfLifeDays)).toFixed(4));
}

export function rankedEvidenceWeight(input: {
  sourceKind: EvidenceSourceKind;
  trust: EvidenceTrust;
  confidence?: number;
  occurredAt: number;
  now?: number;
}) {
  const durable = input.trust === 'confirmed' || input.sourceKind === 'area_fact';
  return Number(
    (
      evidenceWeight(input.sourceKind, input.trust, input.confidence) *
      recencyFactor({ occurredAt: input.occurredAt, now: input.now, durable })
    ).toFixed(4),
  );
}

/** Combine independent signals without letting repeated noisy artifacts grow unbounded. */
export function combinedEvidenceStrength(weights: number[]) {
  const strength = 1 - weights.reduce((remaining, weight) => remaining * (1 - clampUnit(weight)), 1);
  return Number(Math.min(0.995, Math.max(0, strength)).toFixed(4));
}

export function githubEvidenceKind(kind: string): EvidenceSourceKind {
  if (kind === 'commit') return 'github_commit';
  if (kind === 'project') return 'github_project';
  if (kind === 'project_item') return 'github_project_item';
  if (kind === 'pull_request') return 'github_pull_request';
  if (kind === 'issue') return 'github_issue';
  return 'mcp_item';
}
