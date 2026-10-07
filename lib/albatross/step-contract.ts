// The honest step contract for one plan step: who can carry it (stepMode),
// what observable state means done (doneWhen), and what proof looks like
// (evidence). The planner writes it; the step runner and every client read it.
//
// Physical actions have a strict Convex validator. Digital actions are stored
// as `v.any()`, so this module is the one gate for their contract fields: the
// plan save normalizes them on write and the projection normalizes them on
// read. A value outside the taxonomy becomes "unknown" (undefined), never a
// guess. Convex imports this file, so it uses relative imports only.

export const STEP_MODES = ['agent_does', 'agent_drafts', 'you_do_observed', 'you_do_offline'] as const;
export type StepMode = (typeof STEP_MODES)[number];

export const STEP_EVIDENCE_KINDS = ['mail_confirmation', 'artifact', 'observation', 'attestation'] as const;
export type StepEvidenceKind = (typeof STEP_EVIDENCE_KINDS)[number];

const DONE_WHEN_MAX = 300;
const EVIDENCE_HINT_MAX = 300;

export function normalizeStepMode(value: unknown): StepMode | undefined {
  return typeof value === 'string' && (STEP_MODES as readonly string[]).includes(value)
    ? (value as StepMode)
    : undefined;
}

export function normalizeStepEvidence(value: unknown): { kind: StepEvidenceKind; hint?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { kind?: unknown; hint?: unknown };
  if (typeof raw.kind !== 'string' || !(STEP_EVIDENCE_KINDS as readonly string[]).includes(raw.kind))
    return undefined;
  const hint = typeof raw.hint === 'string' ? raw.hint.trim().slice(0, EVIDENCE_HINT_MAX) : '';
  return { kind: raw.kind as StepEvidenceKind, ...(hint ? { hint } : {}) };
}

function normalizeDoneWhen(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, DONE_WHEN_MAX);
  return trimmed || undefined;
}

/**
 * One digital action with its contract fields checked. Every other field is
 * kept as it is. A field that fails the check is removed, so a stored row
 * never carries a mode or an evidence kind that no client can read.
 */
export function normalizeDigitalStepContract<T>(action: T): T {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const {
    stepMode: rawMode,
    doneWhen: rawDoneWhen,
    evidence: rawEvidence,
    ...rest
  } = action as Record<string, unknown>;
  const stepMode = normalizeStepMode(rawMode);
  const doneWhen = normalizeDoneWhen(rawDoneWhen);
  const evidence = normalizeStepEvidence(rawEvidence);
  return {
    ...rest,
    ...(stepMode ? { stepMode } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(evidence ? { evidence } : {}),
  } as T;
}

/** Steps the step runner may start on by itself: work an agent can carry. */
export function stepModeRunsAlone(mode: StepMode | null | undefined): boolean {
  return mode === 'agent_does' || mode === 'agent_drafts';
}

/** Steps the user may hand to the runner. Offline steps (calls, visits, signatures) stay with the user. */
export function stepModeAcceptsRun(mode: StepMode | null | undefined, kind?: string | null): boolean {
  if (mode === 'you_do_offline') return false;
  if (!mode) return kind !== 'physical';
  return true;
}
