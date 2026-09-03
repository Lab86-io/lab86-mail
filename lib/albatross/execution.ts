// The continuous execution projection.
//
// Planning may create many durable artifacts, but Today is allowed to name
// exactly one move. This module is deliberately pure: Convex owns the source
// rows, while every client receives the same already-decided projection.

import { type HorizonWorkLike, isDormant } from './horizon';

export type ExecutionPhase = 'active' | 'upcoming' | 'unscheduled';

export interface ExecutionWorkRow extends HorizonWorkLike {
  _id: string;
  title?: string | null;
  rawText: string;
  status: string;
  workState?: string | null;
  agentState?: string | null;
  planError?: string | null;
  openQuestions: number;
  priority?: number | null;
  updatedAt: number;
  areaName?: string | null;
  nextStep?: string | null;
  nextStepKey?: string | null;
  nextStepDetail?: string | null;
  nextStepUrl?: string | null;
  remainingSteps?: number;
  totalSteps?: number;
  scheduledStartAt?: number | null;
  scheduledEndAt?: number | null;
}

export interface ExecutionMove {
  workId: string;
  workTitle: string;
  stepKey: string | null;
  stepTitle: string;
  detail: string | null;
  url: string | null;
  phase: ExecutionPhase;
  scheduledStartAt: number | null;
  scheduledEndAt: number | null;
  remainingSteps: number;
  totalSteps: number;
  areaName: string | null;
}

export interface MissedMove extends Omit<ExecutionMove, 'phase'> {
  phase: 'missed';
}

export interface ConductorPlan {
  digitalActions?: Array<{ kind?: string; title?: string; startIso?: string; endIso?: string }>;
  physicalActions?: Array<{ title?: string }>;
}

const UPCOMING_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The conductor schedules plans that have a concrete move but never received a
 * block. A plan whose block passed waits for explicit recovery instead of
 * silently rewriting the person's calendar.
 */
export function planNeedsConductor(plan: ConductorPlan | null | undefined): boolean {
  if (!plan) return true;
  const digital = plan.digitalActions || [];
  const scheduled = digital.filter(
    (action) => action.kind === 'calendar_event' && action.startIso && action.endIso,
  );
  if (scheduled.length) return false;
  return (
    digital.some((action) => action.kind !== 'calendar_event' && Boolean(action.title?.trim())) ||
    (plan.physicalActions || []).some((action) => Boolean(action.title?.trim()))
  );
}

function closed(row: ExecutionWorkRow) {
  const state = row.workState || row.status;
  return state === 'done' || state === 'released' || state === 'archived';
}

function needsUser(row: ExecutionWorkRow) {
  if (closed(row)) return false;
  return (
    row.openQuestions > 0 ||
    row.agentState === 'needs_input' ||
    row.agentState === 'error' ||
    Boolean(row.planError) ||
    row.status === 'needs_answers'
  );
}

function movable(row: ExecutionWorkRow) {
  return (
    !closed(row) &&
    !needsUser(row) &&
    row.workState !== 'waiting' &&
    row.workState !== 'blocked' &&
    row.workState !== 'paused' &&
    Boolean(row.nextStep?.trim())
  );
}

function title(row: ExecutionWorkRow) {
  return row.title?.trim() || row.rawText.trim() || 'Something you asked for';
}

function move(row: ExecutionWorkRow, phase: ExecutionPhase): ExecutionMove {
  return {
    workId: row._id,
    workTitle: title(row),
    stepKey: row.nextStepKey || null,
    stepTitle: row.nextStep?.trim() || title(row),
    detail: row.nextStepDetail || null,
    url: row.nextStepUrl || null,
    phase,
    scheduledStartAt: row.scheduledStartAt || null,
    scheduledEndAt: row.scheduledEndAt || null,
    remainingSteps: Math.max(1, row.remainingSteps || 1),
    totalSteps: Math.max(row.remainingSteps || 1, row.totalSteps || 1),
    areaName: row.areaName || null,
  };
}

/**
 * Decide the one move and the separate recovery/attention lanes.
 *
 * A passed calendar block is never quietly promoted back into the current
 * move. It stays in `missedMoves` until a person chooses move, shrink, rebuild,
 * or done, because each choice changes authoritative Work differently.
 */
export function selectExecutionSnapshot(allRows: ExecutionWorkRow[], nowMs: number) {
  // Dormant Work is kept, not carried. It names no move and asks for nothing.
  const rows = allRows.filter((row) => !isDormant(row, nowMs));
  const needsYou = rows
    .filter(needsUser)
    .sort((a, b) => b.openQuestions - a.openQuestions || b.updatedAt - a.updatedAt);
  const candidates = rows.filter(movable);
  const missed = candidates
    .filter((row) => Boolean(row.scheduledStartAt && row.scheduledEndAt && row.scheduledEndAt <= nowMs))
    .sort((a, b) => Number(b.scheduledEndAt || 0) - Number(a.scheduledEndAt || 0));
  const missedIds = new Set(missed.map((row) => row._id));
  const active = candidates
    .filter(
      (row) =>
        !missedIds.has(row._id) &&
        Boolean(
          row.scheduledStartAt &&
            row.scheduledEndAt &&
            row.scheduledStartAt <= nowMs &&
            row.scheduledEndAt > nowMs,
        ),
    )
    .sort((a, b) => Number(a.scheduledEndAt) - Number(b.scheduledEndAt));
  const upcoming = candidates
    .filter(
      (row) =>
        !missedIds.has(row._id) &&
        Boolean(
          row.scheduledStartAt &&
            row.scheduledEndAt &&
            row.scheduledStartAt > nowMs &&
            row.scheduledStartAt <= nowMs + UPCOMING_WINDOW_MS,
        ),
    )
    .sort((a, b) => Number(a.scheduledStartAt) - Number(b.scheduledStartAt));
  const unscheduled = candidates
    .filter((row) => !row.scheduledStartAt || !row.scheduledEndAt)
    .sort(
      (a, b) =>
        Number(a.priority || 2) - Number(b.priority || 2) ||
        b.updatedAt - a.updatedAt ||
        a._id.localeCompare(b._id),
    );

  const currentMove = active[0]
    ? move(active[0], 'active')
    : upcoming[0]
      ? move(upcoming[0], 'upcoming')
      : unscheduled[0]
        ? move(unscheduled[0], 'unscheduled')
        : null;

  return {
    currentMove,
    missedMoves: missed.slice(0, 5).map((row) => ({ ...move(row, 'unscheduled'), phase: 'missed' as const })),
    needsYou,
  };
}
