'use client';

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { LapsePrompt, ReleaseSheet } from '@/components/albatross/Forgiveness';
import { type GuidedSession, GuidedStepPane } from '@/components/albatross/GuidedStep';
import { HORIZON_SAVE_ERROR, HorizonControl } from '@/components/albatross/HorizonControl';
import { OutcomeContractCard, ProofTimeline } from '@/components/albatross/Proof';
import { OutcomeHeader } from '@/components/albatross/primitives';
import { SplitSheet } from '@/components/albatross/SplitSheet';
import { LIST_SAVE_ERROR, ListBody, visibleListItems } from '@/components/albatross/shapes/ListBody';
import type { ListItem } from '@/components/albatross/shapes/ListRow';
import {
  MILESTONES_SAVE_ERROR,
  type Milestone,
  type MilestoneRow,
} from '@/components/albatross/shapes/MilestoneRail';
import {
  METRIC_SAVE_ERROR,
  type MetricEntry,
  PracticeBody,
} from '@/components/albatross/shapes/PracticeBody';
import { ProjectBody } from '@/components/albatross/shapes/ProjectBody';
import {
  SHAPE_STATUS_LINE,
  ShapeBodySwap,
  ShapeFactsRow,
  shapeFacts,
  shapeFinishes,
  shapeShowsPlan,
} from '@/components/albatross/shapes/ShapeFrame';
import { SHAPE_SAVE_ERROR, ShapePicker } from '@/components/albatross/shapes/ShapePicker';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { OutcomeContract } from '@/lib/albatross/contract';
import type { WorkHorizon } from '@/lib/albatross/horizon';
import { type MetricLike, type MetricSummary, metricSummary } from '@/lib/albatross/practice-review';
import type { EvidenceLike } from '@/lib/albatross/proof';
import { resolveShape } from '@/lib/albatross/shape-policy';
import type { WorkShape } from '@/lib/albatross/work-shape';
import { workStateKey } from '@/lib/albatross/work-state';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import type { BriefDocumentV2 } from '@/lib/shared/brief-document';
import { cn } from '@/lib/utils';

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
}

/**
 * The honest briefing for one step. The stored mode wins; the legacy guesses
 * (physical means offline, a url means review) only fill silence, and nothing
 * claims "only you" for work an agent can carry.
 */
export function guidedNeedsYou(step: ExecutionStepRow): string[] {
  switch (step.stepMode) {
    case 'agent_does':
      return [];
    case 'agent_drafts':
      return ['Approve the draft before it goes anywhere.'];
    case 'you_do_observed':
      return ['Act on the page yourself. Review before anything is submitted.'];
    case 'you_do_offline':
      return ['Complete the real-world part and return here to record it.'];
    default:
      if (step.kind === 'physical') return ['Complete the real-world part and return here to record it.'];
      if (step.url) return ['Review the page before anything is submitted.'];
      return [];
  }
}

interface WorkQuestion {
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

export function workDetailRecoveryPrompt(detail: WorkDetailData, workId: string, nowMs: number) {
  const step = detail.execution.currentStep;
  const endAt = detail.execution.scheduledEndAt;
  const open = !['done', 'released', 'archived'].includes(detail.work.workState || 'active');
  if (!open || !step?.key || !endAt || endAt > nowMs) return null;
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

export function WorkDetailRecovery({
  detail,
  workId,
  nowMs,
}: {
  detail: WorkDetailData;
  workId: string;
  nowMs: number;
}) {
  const prompt = workDetailRecoveryPrompt(detail, workId, nowMs);
  return prompt ? (
    <div className="mt-6">
      <LapsePrompt {...prompt} />
    </div>
  ) : null;
}

/**
 * POST json and tolerate a non-json error body — a gateway's HTML error page
 * must surface the caller's fallback message, not a parse failure.
 */
async function postJson(url: string, body: Record<string, unknown>, fallback: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parsed?.error || fallback);
  return parsed;
}

export function WorkDetail({ workId }: { workId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const setAiBarOpen = useClientStore((state) => state.setAiBarOpen);
  const setChatScope = useClientStore((state) => state.setChatScope);
  const detail = useQuery(
    api.albatrossWorkV2.workDetail,
    isAuthenticated ? { workId: workId as Id<'albatrossIntents'> } : 'skip',
  ) as WorkDetailData | null | undefined;
  const session = useQuery(
    (api as any).albatrossBrowserSessions.activeSessionForWork,
    isAuthenticated ? { workId } : 'skip',
  ) as GuidedSession | null | undefined;
  const [advancing, setAdvancing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [guided, setGuided] = useState(false);
  const [activeGuideId, setActiveGuideId] = useState<string>();
  const [optimisticCompletedSteps, setOptimisticCompletedSteps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [savingStepIds, setSavingStepIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sessionBusy, setSessionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The stored application keeps its artifacts after an undo; the ledger must
  // not keep offering Undo for a change that is already gone.
  const [undoneOperations, setUndoneOperations] = useState<ReadonlySet<string>>(new Set());
  const setHorizonMutation = useMutation(api.albatrossWorkV2.setHorizon);
  const [horizonChoice, setHorizonChoice] = useState<{ value: WorkHorizon | null } | null>(null);
  const [horizonSaving, setHorizonSaving] = useState(false);
  const [horizonError, setHorizonError] = useState<string | null>(null);

  // Shape-owned state. Each choice is shown until the server row agrees.
  const setShapeMutation = useMutation(api.albatrossWorkV2.setShape);
  const addListItemMutation = useMutation(api.albatrossWorkV2.addListItem);
  const toggleListItemMutation = useMutation(api.albatrossWorkV2.toggleListItem);
  const removeListItemMutation = useMutation(api.albatrossWorkV2.removeListItem);
  const logMetricMutation = useMutation(api.albatrossWorkV2.logMetric);
  const setMilestonesMutation = useMutation(api.albatrossWorkV2.setMilestones);
  const toggleMilestoneMutation = useMutation(api.albatrossWorkV2.toggleMilestone);
  const [shapeChoice, setShapeChoice] = useState<{ value: WorkShape } | null>(null);
  const [shapeSaving, setShapeSaving] = useState(false);
  const [shapeError, setShapeError] = useState<string | null>(null);
  const [listChoices, setListChoices] = useState<ReadonlyMap<string, { done: boolean; at: number }>>(
    () => new Map(),
  );
  const [pendingListItems, setPendingListItems] = useState<ListItem[]>([]);
  const [removedListIds, setRemovedListIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listBusyIds, setListBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listError, setListError] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<MetricEntry[]>([]);
  const [freshEntryId, setFreshEntryId] = useState<string | null>(null);
  const [metricSaving, setMetricSaving] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [milestoneChoices, setMilestoneChoices] = useState<
    ReadonlyMap<string, { done: boolean; at: number }>
  >(() => new Map());
  const [milestoneBusyIds, setMilestoneBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [milestonesSaving, setMilestonesSaving] = useState(false);
  const [milestoneError, setMilestoneError] = useState<string | null>(null);

  useEffect(() => {
    if (detail?.work.primaryAreaId) setSelectedAreaId(String(detail.work.primaryAreaId));
  }, [detail?.work.primaryAreaId, setSelectedAreaId]);

  // Drop each optimistic choice once the server row carries it.
  useEffect(() => {
    if (!detail) return;
    const serverItems = detail.work.listItems ?? [];
    setListChoices((current) => {
      const next = new Map(current);
      for (const [id, choice] of current) {
        const item = serverItems.find((row) => row.id === id);
        if (!item || item.done === choice.done) next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
    setRemovedListIds((current) => {
      const kept = [...current].filter((id) => serverItems.some((row) => row.id === id));
      return kept.length === current.size ? current : new Set(kept);
    });
    const serverMilestones = detail.work.milestones ?? [];
    setMilestoneChoices((current) => {
      const next = new Map(current);
      for (const [id, choice] of current) {
        const milestone = serverMilestones.find((row) => row.id === id);
        if (!milestone || milestone.done === choice.done) next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
    const serverEntryIds = new Set((detail.metricEntries ?? []).map((entry) => entry._id));
    setPendingEntries((current) => {
      const kept = current.filter((entry) => !serverEntryIds.has(entry._id));
      return kept.length === current.length ? current : kept;
    });
  }, [detail]);

  const saveShape = async (next: WorkShape) => {
    setShapeChoice({ value: next });
    setShapeSaving(true);
    setShapeError(null);
    try {
      await setShapeMutation({ workId: workId as Id<'albatrossIntents'>, shape: next });
    } catch {
      setShapeChoice(null);
      setShapeError(SHAPE_SAVE_ERROR);
    } finally {
      setShapeSaving(false);
    }
  };

  const addListItems = async (texts: string[]) => {
    const at = Date.now();
    const drafts = texts.map((text, index) => ({
      id: `pending:${at}:${index}`,
      text,
      done: false,
      addedAt: at + index,
    }));
    setPendingListItems((current) => [...current, ...drafts]);
    setListError(null);
    for (const draft of drafts) {
      try {
        await addListItemMutation({ workId: workId as Id<'albatrossIntents'>, text: draft.text });
      } catch {
        setListError(LIST_SAVE_ERROR);
      } finally {
        setPendingListItems((current) => current.filter((row) => row.id !== draft.id));
      }
    }
  };

  const toggleListItem = async (itemId: string) => {
    const item = (detail?.work.listItems ?? []).find((row) => row.id === itemId);
    if (!item) return;
    const shownDone = listChoices.get(itemId)?.done ?? item.done;
    setListChoices((current) => new Map(current).set(itemId, { done: !shownDone, at: Date.now() }));
    setListError(null);
    try {
      await toggleListItemMutation({ workId: workId as Id<'albatrossIntents'>, itemId });
    } catch {
      setListChoices((current) => {
        const next = new Map(current);
        next.delete(itemId);
        return next;
      });
      setListError(LIST_SAVE_ERROR);
    }
  };

  const removeListItem = async (itemId: string) => {
    setRemovedListIds((current) => new Set([...current, itemId]));
    setListBusyIds((current) => new Set([...current, itemId]));
    setListError(null);
    try {
      await removeListItemMutation({ workId: workId as Id<'albatrossIntents'>, itemId });
    } catch {
      setRemovedListIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
      setListError(LIST_SAVE_ERROR);
    } finally {
      setListBusyIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  };

  const logMetric = async (value: number, note?: string) => {
    setMetricSaving(true);
    setMetricError(null);
    try {
      const result = await logMetricMutation({
        workId: workId as Id<'albatrossIntents'>,
        value,
        ...(note ? { note } : {}),
      });
      const entry: MetricEntry = {
        _id: String(result.entry._id),
        at: result.entry.at,
        value: result.entry.value,
        note: result.entry.note ?? null,
      };
      setPendingEntries((current) => [...current, entry]);
      setFreshEntryId(entry._id);
    } catch {
      setMetricError(METRIC_SAVE_ERROR);
    } finally {
      setMetricSaving(false);
    }
  };

  const toggleMilestone = async (milestoneId: string) => {
    const milestone = (detail?.work.milestones ?? []).find((row) => row.id === milestoneId);
    if (!milestone) return;
    const shownDone = milestoneChoices.get(milestoneId)?.done ?? milestone.done;
    setMilestoneChoices((current) => new Map(current).set(milestoneId, { done: !shownDone, at: Date.now() }));
    setMilestoneBusyIds((current) => new Set([...current, milestoneId]));
    setMilestoneError(null);
    try {
      await toggleMilestoneMutation({ workId: workId as Id<'albatrossIntents'>, milestoneId });
    } catch {
      setMilestoneChoices((current) => {
        const next = new Map(current);
        next.delete(milestoneId);
        return next;
      });
      setMilestoneError(MILESTONES_SAVE_ERROR);
    } finally {
      setMilestoneBusyIds((current) => {
        const next = new Set(current);
        next.delete(milestoneId);
        return next;
      });
    }
  };

  const saveMilestones = async (rows: MilestoneRow[]): Promise<boolean> => {
    setMilestonesSaving(true);
    setMilestoneError(null);
    try {
      await setMilestonesMutation({ workId: workId as Id<'albatrossIntents'>, milestones: rows });
      return true;
    } catch {
      setMilestoneError(MILESTONES_SAVE_ERROR);
      return false;
    } finally {
      setMilestonesSaving(false);
    }
  };

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const serverCompleted = new Set(
      detail.execution.guideSteps.filter((step) => step.done).map((step) => step.key),
    );
    const currentStepKeys = new Set(detail.execution.guideSteps.map((step) => step.key));
    setOptimisticCompletedSteps((current) => {
      const pending = [...current].filter(
        (stepKey) => currentStepKeys.has(stepKey) && !serverCompleted.has(stepKey),
      );
      return pending.length === current.size ? current : new Set(pending);
    });
  }, [detail]);

  const saveHorizon = async (next: WorkHorizon | null) => {
    setHorizonChoice({ value: next });
    setHorizonSaving(true);
    setHorizonError(null);
    try {
      await setHorizonMutation({ workId: workId as Id<'albatrossIntents'>, horizon: next });
    } catch {
      setHorizonChoice(null);
      setHorizonError(HORIZON_SAVE_ERROR);
    } finally {
      setHorizonSaving(false);
    }
  };

  const advance = async () => {
    setAdvancing(true);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/advance`,
        { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        'Could not continue this Albatross.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not continue this Albatross.');
    } finally {
      setAdvancing(false);
    }
  };

  const setWorkState = async (state: 'done' | 'active') => {
    setCompleting(true);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/state`,
        { state },
        'Could not update this Albatross.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this Albatross.');
    } finally {
      setCompleting(false);
    }
  };

  const sessionAction = async (body: Record<string, unknown>, fallback: string) => {
    setSessionBusy(true);
    setError(null);
    try {
      return await postJson(`/api/albatross/work/${encodeURIComponent(workId)}/session`, body, fallback);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return null;
    } finally {
      setSessionBusy(false);
    }
  };

  const startSession = (stepKey: string) =>
    void sessionAction({ action: 'start', stepKey }, 'The shared browser could not open.');

  const endSession = () => {
    if (!session) return;
    void sessionAction({ action: 'end', sessionId: session.sessionId }, 'The shared browser did not close.');
  };

  const verifySession = async (stepKey: string) => {
    if (!session) return;
    const result = await sessionAction(
      { action: 'verify', sessionId: session.sessionId, stepKey },
      'The page could not be checked.',
    );
    // A satisfied verdict already completed the step server-side with the
    // session bound as evidence; mirror it optimistically like a manual check.
    if (result?.satisfied) {
      setOptimisticCompletedSteps((current) => new Set([...current, stepKey]));
      const visibleSteps = guideStepsWithOptimisticCompletion(
        detail?.execution.guideSteps || [],
        new Set([...optimisticCompletedSteps, stepKey]),
      );
      const selectedIndex = visibleSteps.findIndex((step) => step.key === stepKey);
      const nextStep = visibleSteps.slice(selectedIndex + 1).find((step) => !step.done);
      if (nextStep) setActiveGuideId(nextStep.key);
    }
  };

  const completeGuidedStep = async (stepKey: string, note?: string): Promise<boolean> => {
    const visibleSteps = guideStepsWithOptimisticCompletion(
      detail?.execution.guideSteps || [],
      optimisticCompletedSteps,
    );
    const selectedIndex = visibleSteps.findIndex((step) => step.key === stepKey);
    const nextStep = visibleSteps.slice(selectedIndex + 1).find((step) => !step.done);
    setOptimisticCompletedSteps((current) => new Set([...current, stepKey]));
    setSavingStepIds((current) => new Set([...current, stepKey]));
    setActiveGuideId(nextStep?.key || stepKey);
    setError(null);
    try {
      await postJson(
        `/api/albatross/work/${encodeURIComponent(workId)}/step`,
        {
          stepKey,
          ...(note ? { note } : {}),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        'Could not complete this step.',
      );
      return true;
    } catch (cause) {
      setOptimisticCompletedSteps((current) => {
        const next = new Set(current);
        next.delete(stepKey);
        return next;
      });
      setActiveGuideId(stepKey);
      setError(cause instanceof Error ? cause.message : 'Could not complete this step.');
      return false;
    } finally {
      setSavingStepIds((current) => {
        const next = new Set(current);
        next.delete(stepKey);
        return next;
      });
    }
  };

  if (detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--color-text-muted)]">
        Loading this Albatross…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-[14px] font-medium">This Albatross is no longer available.</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => setSelectedWorkId(null)}>
            Back to Albatrosses
          </Button>
        </div>
      </div>
    );
  }

  const { work, plan } = detail;
  const visibleGuideSteps = guideStepsWithOptimisticCompletion(
    detail.execution.guideSteps,
    optimisticCompletedSteps,
  );
  const visibleCurrentStep = visibleGuideSteps.find((step) => !step.done) || null;
  const pendingQuestions = detail.questions.filter((question) => question.status === 'pending');
  const document = plan?.artifactSource === 'document-v2' ? plan.document : undefined;
  const legacyPlan = Boolean(plan && !document && plan.artifactHtml);
  const open = work.workState !== 'done' && work.workState !== 'released' && work.workState !== 'archived';
  const horizon = visibleHorizon(work.horizon, horizonChoice);
  const shape = visibleShape(work.shape, shapeChoice);
  const showsPlan = shapeShowsPlan(shape);
  const finishes = shapeFinishes(shape);
  const listItems = visibleListItems(
    [...(work.listItems ?? []), ...pendingListItems].filter((item) => !removedListIds.has(item.id)),
    listChoices,
  );
  const milestones = visibleMilestones(work.milestones, milestoneChoices);
  const metricEntries = mergeMetricEntries(detail.metricEntries ?? [], pendingEntries);
  const facts = shapeFacts(
    shape,
    {
      listItems,
      metric: work.metric ?? null,
      metricSummary: metricSummary(metricEntries, nowMs),
      milestones,
      lastUserTouchAt: work.lastUserTouchAt ?? null,
    },
    nowMs,
  );
  const openAttachedChat = () => {
    setChatScope({
      kind: 'work',
      workId,
      label: plan?.outcome || work.title || work.rawText,
    });
    setAiBarOpen(true);
  };

  if (guided && visibleGuideSteps.length) {
    return (
      <GuidedStepPane
        steps={visibleGuideSteps.map((step) => ({
          id: step.key,
          title: step.title,
          detail: step.detail,
          url: step.url,
          knows: [],
          needsYou: guidedNeedsYou(step),
          done: step.done,
          mode: step.stepMode ?? null,
          doneWhen: step.doneWhen ?? null,
          evidenceKind: step.evidenceKind ?? null,
          verification: step.verification ?? null,
        }))}
        activeId={activeGuideId || visibleCurrentStep?.key}
        onSelect={setActiveGuideId}
        onExit={() => setGuided(false)}
        onComplete={(stepKey, note) => completeGuidedStep(stepKey, note)}
        onDiscuss={openAttachedChat}
        savingIds={savingStepIds}
        error={error}
        session={session ?? null}
        sessionBusy={sessionBusy}
        onStartSession={startSession}
        onVerifySession={(stepKey) => void verifySession(stepKey)}
        onEndSession={endSession}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <Button type="button" size="xs" variant="ghost" onClick={() => setSelectedWorkId(null)}>
          Back
        </Button>
        <span className="text-[11px] text-[var(--color-text-faint)]">/</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Albatross</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-24 pt-6">
        <div className="mx-auto max-w-4xl">
          <OutcomeHeader
            outcome={plan?.outcome || work.title || work.rawText}
            summary={plan?.summary}
            work={{ ...work, openQuestions: pendingQuestions.length }}
            evidence={detail.evidence || []}
            state={workStateKey({ ...work, openQuestions: pendingQuestions.length })}
            eyebrow={
              <ShapePicker
                value={shape}
                onChange={(next) => void saveShape(next)}
                saving={shapeSaving}
                error={shapeError}
              />
            }
            facts={facts ? <ShapeFactsRow facts={facts} /> : undefined}
            actions={
              <div className="flex flex-col items-end gap-2">
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={openAttachedChat}>
                    Discuss
                  </Button>
                  {!showsPlan ? null : detail.execution.currentStep ? (
                    <Button type="button" size="sm" onClick={() => setGuided(true)}>
                      Open guided work
                    </Button>
                  ) : (
                    <Button type="button" size="sm" disabled={advancing} onClick={() => void advance()}>
                      {advancing ? 'Working…' : 'Continue'}
                    </Button>
                  )}
                  {open ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSplitting((value) => !value);
                          setReleasing(false);
                        }}
                      >
                        Split this work
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setReleasing((value) => !value);
                          setSplitting(false);
                        }}
                      >
                        Put it down
                      </Button>
                    </>
                  ) : null}
                </div>
                {open ? (
                  <HorizonControl
                    value={horizon}
                    nowMs={nowMs}
                    onChange={(next) => void saveHorizon(next)}
                    saving={horizonSaving}
                    error={horizonError}
                  />
                ) : null}
              </div>
            }
          />

          {splitting ? (
            <SplitSheet
              workId={workId}
              onDone={(workIds) => {
                setSplitting(false);
                if (workIds[0]) setSelectedWorkId(workIds[0]);
              }}
              onCancel={() => setSplitting(false)}
            />
          ) : null}

          {releasing ? (
            <div className="mt-6">
              <ReleaseSheet
                workId={workId}
                title={plan?.outcome || work.title || work.rawText}
                onReleased={() => setReleasing(false)}
                onCancel={() => setReleasing(false)}
              />
            </div>
          ) : null}

          <WorkDetailRecovery detail={detail} workId={workId} nowMs={nowMs} />

          {pendingQuestions.length ? (
            <section className="mt-6 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] p-4">
              <h2 className="text-[13px] font-medium text-[var(--color-text)]">
                {pendingQuestions[0].prompt}
              </h2>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Answer in the attached conversation so Albatross can research the answer and rewrite the plan.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                aria-label="Answer in chat about this Albatross"
                onClick={openAttachedChat}
              >
                Answer in chat
              </Button>
            </section>
          ) : null}

          <ShapeBodySwap shape={shape}>
            {(shown, kind) => (
              <>
                {SHAPE_STATUS_LINE[shown] ? (
                  <p data-shape-status className="mt-5 text-[13px] text-[var(--color-text-muted)]">
                    {SHAPE_STATUS_LINE[shown]}
                  </p>
                ) : null}
                {kind === 'list' ? (
                  <ListBody
                    items={listItems}
                    onAdd={(texts) => void addListItems(texts)}
                    onToggle={(itemId) => void toggleListItem(itemId)}
                    onRemove={(itemId) => void removeListItem(itemId)}
                    busyIds={listBusyIds}
                    error={listError}
                  />
                ) : kind === 'practice' ? (
                  <PracticeBody
                    metric={work.metric ?? null}
                    entries={metricEntries}
                    nowMs={nowMs}
                    onLog={(value, note) => void logMetric(value, note)}
                    saving={metricSaving}
                    error={metricError}
                    freshId={freshEntryId}
                  />
                ) : kind === 'milestones' ? (
                  <ProjectBody
                    milestones={milestones}
                    evidence={detail.evidence || []}
                    artifacts={detail.application?.artifacts ?? []}
                    lastUserTouchAt={work.lastUserTouchAt ?? null}
                    nowMs={nowMs}
                    onToggle={(milestoneId) => void toggleMilestone(milestoneId)}
                    onSetMilestones={saveMilestones}
                    busyIds={milestoneBusyIds}
                    saving={milestonesSaving}
                    error={milestoneError}
                  />
                ) : null}
                {kind === 'list' || kind === 'practice' ? null : (
                  <>
                    {showsPlan && detail.execution.currentStep ? (
                      <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
                        <p className="text-[11.5px] text-[var(--color-text-faint)]">Current step</p>
                        <h2 className="mt-1 font-serif text-[18px] font-semibold">
                          {detail.execution.currentStep.title}
                        </h2>
                        {detail.execution.currentStep.detail ? (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                            {detail.execution.currentStep.detail}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)]/70 pt-3">
                          <span className="text-[12px] text-[var(--color-text-muted)]">
                            {detail.execution.remainingSteps} of {detail.execution.totalSteps} steps remain
                          </span>
                          <Button type="button" size="sm" onClick={() => setGuided(true)}>
                            Start this step
                          </Button>
                        </div>
                      </section>
                    ) : null}

                    {!showsPlan ? null : document ? (
                      // The page is the plan. The document flows in the page scroll —
                      // no frame, no fixed height, no second scrollbar.
                      <section className="mt-6">
                        <BriefCanvas value={document} embedded />
                        <p className="mt-4 text-[11.5px] text-[var(--color-text-faint)]">
                          This is Albatross&apos;s best guess at the way through. Tell it if the plan is wrong
                          and it will find another one.
                        </p>
                      </section>
                    ) : legacyPlan ? (
                      <LegacyPlanNotice workId={workId} onError={setError} />
                    ) : null}

                    {showsPlan && !document && plan?.digitalActions?.length ? (
                      <section className="border-b border-[var(--color-border)] py-5">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
                          The proposed steps
                        </h2>
                        <div className="mt-2 divide-y divide-[var(--color-border)]/60">
                          {(plan.digitalActions || []).map((action) => {
                            const done = detail.execution.guideSteps.some(
                              (step) => step.key === action.key && step.done,
                            );
                            return (
                              <div
                                key={action.actionKey || action.key || action.title}
                                className="flex items-center gap-3 py-2.5"
                              >
                                <span
                                  role="img"
                                  aria-label={done ? 'Applied' : 'Not applied'}
                                  className={cn(
                                    'size-4 shrink-0 rounded-full border',
                                    done
                                      ? 'border-[var(--color-success)] bg-[var(--color-success)]/15'
                                      : 'border-[var(--color-border-strong)]',
                                  )}
                                />
                                <span className="min-w-0 flex-1 text-[13px]">{action.title}</span>
                              </div>
                            );
                          })}
                          {(plan.physicalActions || []).map((action) => (
                            <div key={action.title} className="py-2.5">
                              <p className="text-[13px]">{action.title}</p>
                              {action.detail ? (
                                <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                                  {action.detail}
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {kind !== 'milestones' && detail.application?.artifacts.length ? (
                      <section className="border-b border-[var(--color-border)] py-5">
                        <h2 className="text-[13px] font-semibold text-[var(--color-text)]">What changed</h2>
                        <p className="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
                          Albatross created these in your accounts. Each one can be undone while the provider
                          allows it.
                        </p>
                        <div className="mt-2 divide-y divide-[var(--color-border)]/60">
                          {detail.application.artifacts.map((artifact) => {
                            const undone = Boolean(
                              artifact.operationId && undoneOperations.has(artifact.operationId),
                            );
                            return (
                              <div
                                key={`${artifact.kind}:${artifact.id}`}
                                className={cn('flex items-center gap-3 py-2', undone && 'opacity-55')}
                              >
                                <span
                                  className={cn(
                                    'min-w-0 flex-1 truncate text-[13px]',
                                    undone && 'line-through',
                                  )}
                                >
                                  {artifact.title || artifact.id}
                                </span>
                                <span className="text-[10.5px] capitalize text-[var(--color-text-faint)]">
                                  {undone ? 'undone' : artifact.kind.replaceAll('_', ' ')}
                                </span>
                                {artifact.operationId && !undone ? (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    disabled={Boolean(undoing)}
                                    onClick={async () => {
                                      setUndoing(artifact.operationId!);
                                      setError(null);
                                      try {
                                        await callTool('undo_operation', {
                                          operationId: artifact.operationId,
                                        });
                                        setUndoneOperations(
                                          (previous) => new Set([...previous, artifact.operationId!]),
                                        );
                                      } catch (cause) {
                                        setError(
                                          cause instanceof Error
                                            ? cause.message
                                            : 'This change can no longer be undone.',
                                        );
                                      } finally {
                                        setUndoing(null);
                                      }
                                    }}
                                  >
                                    {undoing === artifact.operationId ? 'Undoing…' : 'Undo'}
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ) : null}

                    {detail.contract ? (
                      <section className="border-b border-[var(--color-border)] py-5">
                        <OutcomeContractCard contract={detail.contract} evidence={detail.evidence || []} />
                      </section>
                    ) : null}

                    {kind !== 'milestones' && detail.evidence?.length ? (
                      <section className="border-b border-[var(--color-border)] py-5">
                        <ProofTimeline evidence={detail.evidence} contract={detail.contract} />
                      </section>
                    ) : null}

                    {showsPlan && (plan?.assumptions?.length || plan?.sourceRefs?.length) ? (
                      <section className="border-b border-[var(--color-border)] py-5 text-[12px] text-[var(--color-text-muted)]">
                        {plan.assumptions?.length ? (
                          <div>
                            <h2 className="font-medium text-[var(--color-text)]">Assumptions</h2>
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              {plan.assumptions.map((assumption) => (
                                <li key={assumption}>{assumption}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {plan.sourceRefs?.length ? (
                          <div className="mt-4">
                            <h2 className="font-medium text-[var(--color-text)]">Sources</h2>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                              {plan.sourceRefs.map((source) => (
                                <span key={`${source.kind}:${source.id}`}>
                                  {source.label || `${source.kind} ${source.id}`}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </section>
                    ) : null}
                  </>
                )}
              </>
            )}
          </ShapeBodySwap>

          {open && finishes ? (
            <section className="mt-8 rounded-xl border border-[var(--color-border)] p-4">
              <h2 className="font-serif text-[17px] font-semibold">Is this albatross complete?</h2>
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                The check closes it and saves the record: the steps you finished and the time it took.
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-3"
                disabled={completing}
                onClick={() => void setWorkState('done')}
              >
                {completing ? 'Saving…' : 'Mark it complete'}
              </Button>
            </section>
          ) : work.workState === 'done' || work.workState === 'released' ? (
            <section className="mt-8 flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
              <p className="text-[13px]">
                {work.workState === 'done'
                  ? 'Finished. This one is off your list.'
                  : 'You put this down. That is one less thing.'}
              </p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={completing}
                onClick={() => void setWorkState('active')}
              >
                {work.workState === 'done' ? 'Reopen' : 'Pick it back up'}
              </Button>
            </section>
          ) : null}

          {error || work.planError ? (
            <div className="mt-4 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger-soft)] p-3 text-[12px] text-[var(--color-danger)]">
              {error || work.planError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A plan from before the live page. Its HTML dossier no longer renders; one
 * regeneration turns it into the native document.
 */
function LegacyPlanNotice({ workId, onError }: { workId: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <p className="text-[13px]">This plan predates the live page.</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await postJson(
              '/api/albatross/plan',
              { intentId: workId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              'Could not rebuild the plan.',
            );
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : 'Could not rebuild the plan.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Rebuilding…' : 'Rebuild the plan'}
      </Button>
    </section>
  );
}
