// The pure view helpers of one Work (an Albatross): the detail projection the
// Convex query returns, the optimistic overlays the page keeps while a save is
// in flight, and the recovery prompt. No React here. The thread page
// (components/albatross/WorkThread.tsx) and its tests read these.

import type { ListItem } from '../../components/albatross/shapes/ListRow';
import type { Milestone } from '../../components/albatross/shapes/MilestoneRail';
import type { MetricEntry } from '../../components/albatross/shapes/PracticeBody';
import type { BriefDocumentV2 } from '../shared/brief-document';
import type { OutcomeContract } from './contract';
import type { WorkHorizon } from './horizon';
import type { MetricLike, MetricSummary } from './practice-review';
import type { EvidenceLike } from './proof';
import { resolveShape } from './shape-policy';
import type { StepRunView } from './step-run-client';
import type { WorkShape } from './work-shape';

export interface ExecutionStepRow {
  key: string;
  identity?: string;
  kind: string;
  title: string;
  detail: string | null;
  url: string | null;
  done: boolean;
  cardId: string | null;
  stepMode?: 'agent_does' | 'agent_drafts' | 'you_do_observed' | 'you_do_offline' | null;
  doneWhen?: string | null;
  evidenceKind?: string | null;
  evidenceHint?: string | null;
  verification?: {
    level: 'reported' | 'artifact' | 'observed' | 'confirmed';
    evidenceTitle: string | null;
    evidenceUrl: string | null;
  } | null;
  /** The newest step run of this step (docs/albatross-step-runner.md). */
  run?: StepRunView | null;
  /** True when the user may press "Handle it". */
  runnable?: boolean;
}

export interface WorkQuestion {
  _id: string;
  status: string;
  prompt: string;
  reason?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface WorkDetailData {
  work: {
    _id: string;
    title?: string;
    rawText: string;
    status: string;
    workState?: string;
    agentState?: string;
    planError?: string;
    primaryAreaId?: string;
    primaryProjectId?: string;
    updatedAt: number;
    horizon?: WorkHorizon | null;
    shape?: WorkShape | null;
    listItems?: ListItem[] | null;
    metric?: MetricLike | null;
    milestones?: Milestone[] | null;
    lastUserTouchAt?: number | null;
  };
  /** Shape-owned data. Entries are newest first. */
  metricEntries?: MetricEntry[];
  metricSummary?: MetricSummary | null;
  plan: null | {
    _id: string;
    outcome?: string;
    summary?: string;
    status: string;
    artifactHtml?: string;
    document?: BriefDocumentV2;
    artifactSource?: string;
    assumptions?: string[];
    sourceRefs?: Array<{ kind: string; id: string; label?: string; url?: string }>;
    digitalActions?: Array<{ actionKey?: string; key?: string; kind: string; title: string }>;
    physicalActions?: Array<{ title: string; detail?: string; url?: string }>;
    appliedSteps?: Array<{ stepKey: string; kind: string }>;
  };
  project: null | { _id: string; title: string; outcome?: string; status: string };
  questions: WorkQuestion[];
  areaLinks: Array<{ areaId: string; role: string; status: string; reason?: string }>;
  execution: {
    currentStep: null | ExecutionStepRow;
    guideSteps: ExecutionStepRow[];
    remainingSteps: number;
    totalSteps: number;
    scheduledStartAt: number | null;
    scheduledEndAt: number | null;
    /** The open run of the Work (queued or running), or null. */
    activeRun?: StepRunView | null;
    /** `enabled: false` hides every run control. */
    runner?: { enabled: boolean };
  };
  contract: OutcomeContract | null;
  evidence: EvidenceLike[];
  application: null | {
    _id: string;
    status: string;
    operationIds: string[];
    artifacts: Array<{ kind: string; id: string; title?: string; operationId?: string }>;
  };
}

/** The Work is open: not done, released, or archived. */
export function workIsOpen(work: Pick<WorkDetailData['work'], 'workState'>): boolean {
  return !['done', 'released', 'archived'].includes(work.workState || 'active');
}

/** The title the page and the chat use for a Work. */
export function workTitle(detail: Pick<WorkDetailData, 'plan' | 'work'>): string {
  return detail.plan?.outcome || detail.work.title || detail.work.rawText;
}

/**
 * What the user must do on a step. Only payment, signature, password, and
 * one-time codes are the user's alone (docs/albatross-thread.md): personal
 * details are not. The stored mode wins; the legacy guesses only fill silence.
 */
export function stepNeedsYou(step: ExecutionStepRow): string[] {
  switch (step.stepMode) {
    case 'agent_does':
      return [];
    case 'agent_drafts':
      return ['Approve the draft before it goes anywhere.'];
    case 'you_do_observed':
      return ['Payment, a signature, or a sign-in on the page is yours.'];
    case 'you_do_offline':
      return ['Complete the real-world part and return here to record it.'];
    default:
      if (step.kind === 'physical') return ['Complete the real-world part and return here to record it.'];
      if (step.url) return ['Payment, a signature, or a sign-in on the page is yours.'];
      return [];
  }
}

/** A step that happens away from any site: a call, a visit, a signature. */
export function stepIsOffline(step: Pick<ExecutionStepRow, 'stepMode' | 'url' | 'kind'>): boolean {
  if (step.stepMode) return step.stepMode === 'you_do_offline';
  return step.kind === 'physical' || !step.url;
}

export function workDetailRecoveryPrompt(detail: WorkDetailData, workId: string, nowMs: number) {
  const step = detail.execution.currentStep;
  const endAt = detail.execution.scheduledEndAt;
  if (!workIsOpen(detail.work) || !step?.key || !endAt || endAt > nowMs) return null;
  return {
    workId,
    stepKey: step.key,
    stepTitle: step.title,
    plannedAt: detail.execution.scheduledStartAt || undefined,
  };
}

/** Two horizons say the same thing. The wake stamp does not count: the server owns it. */
export function sameHorizon(left: WorkHorizon | null | undefined, right: WorkHorizon | null | undefined) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    (left.notBefore ?? null) === (right.notBefore ?? null) &&
    (left.by ?? null) === (right.by ?? null) &&
    (left.label ?? null) === (right.label ?? null)
  );
}

/**
 * The horizon the page shows: the user's last choice until the server row
 * agrees with it, then the server row.
 */
export function visibleHorizon(
  server: WorkHorizon | null | undefined,
  optimistic: { value: WorkHorizon | null } | null,
): WorkHorizon | null {
  if (optimistic && !sameHorizon(server, optimistic.value)) return optimistic.value;
  return server ?? null;
}

/** The shape the page shows: the user's last pick until the server row agrees. */
export function visibleShape(
  server: string | null | undefined,
  optimistic: { value: WorkShape } | null,
): WorkShape {
  const stored = resolveShape(server);
  if (optimistic && optimistic.value !== stored) return optimistic.value;
  return stored;
}

/** The server milestones with the user's last toggles laid over them. */
export function visibleMilestones(
  server: Milestone[] | null | undefined,
  optimistic: ReadonlyMap<string, { done: boolean; at: number }>,
): Milestone[] {
  return (server ?? []).map((milestone) => {
    const choice = optimistic.get(milestone.id);
    if (!choice || choice.done === milestone.done) return milestone;
    return { ...milestone, done: choice.done, doneAt: choice.done ? choice.at : undefined };
  });
}

/** Server entries plus the logs written on this page that the server has not sent back yet. */
export function mergeMetricEntries(server: MetricEntry[], pending: MetricEntry[]): MetricEntry[] {
  const seen = new Set(server.map((entry) => entry._id));
  return [...server, ...pending.filter((entry) => !seen.has(entry._id))];
}

export function guideStepsWithOptimisticCompletion(
  steps: WorkDetailData['execution']['guideSteps'],
  completed: ReadonlySet<string>,
) {
  return steps.map((step) => (completed.has(step.key) ? { ...step, done: true } : step));
}

/**
 * POST json and tolerate a non-json error body: a gateway's HTML error page
 * must surface the caller's fallback message, not a parse failure.
 */
export async function postJson(url: string, body: Record<string, unknown>, fallback: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(parsed?.error || fallback) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}
