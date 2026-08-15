export type StepProgressSource = 'user' | 'task' | 'evidence';

export interface StepProgressEntry {
  identity: string;
  actionKey?: string;
  kind: string;
  title: string;
  cardId?: string;
  completedAt: number;
  source: StepProgressSource;
  /** What came of the step, in the user's words. */
  note?: string;
}

interface PlanActionLike {
  key?: string;
  actionKey?: string;
  kind?: string;
  title?: string;
  description?: string;
  detail?: string;
  url?: string;
  startIso?: string;
  endIso?: string;
  sourceRefs?: Array<{ url?: string }>;
}

interface PlanLike {
  digitalActions?: PlanActionLike[];
  physicalActions?: PlanActionLike[];
  appliedSteps?: Array<{ stepKey: string; cardId?: string }>;
  completedSteps?: Array<{
    stepKey: string;
    completedAt: number;
    source: StepProgressSource;
  }>;
}

export interface ProgressPlanStep {
  key: string;
  action: PlanActionLike;
  kind: 'digital' | 'physical';
  identity: string;
  actionKey?: string;
  cardId?: string;
}

function bounded(value: unknown, max: number) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

/** Normalize exact step identity fields without introducing fuzzy matching. */
export function normalizeStepIdentityPart(value: unknown) {
  return bounded(value, 400).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A plan may change its local step keys on every generation. This identity is
 * deliberately exact and conservative: a stable action key wins, then a
 * normalized kind + title. A card is only the fallback for an untitled step,
 * so applying a plan cannot change the identity. We never fuzzy-match.
 */
export function completedStepIdentity(input: {
  actionKey?: string;
  cardId?: string;
  kind?: string;
  title?: string;
}) {
  const actionKey = normalizeStepIdentityPart(input.actionKey);
  if (actionKey) return `action:${actionKey}`;
  const title = normalizeStepIdentityPart(input.title);
  if (title) return `step:${normalizeStepIdentityPart(input.kind || 'task')}:${title}`;
  const cardId = bounded(input.cardId, 160);
  if (cardId) return `card:${cardId}`;
  return `step:${normalizeStepIdentityPart(input.kind || 'task')}:untitled`;
}

/** Project a generated plan into stable Work-level progress identities. */
export function planStepsForProgress(plan: PlanLike): ProgressPlanStep[] {
  const appliedByKey = new Map((plan.appliedSteps || []).map((step) => [step.stepKey, step] as const));
  const digital = (plan.digitalActions || [])
    .filter((action) => action.kind !== 'calendar_event' && action.title?.trim())
    .map((action, index) => {
      const key = action.key || `step-${index + 1}`;
      const cardId = appliedByKey.get(key)?.cardId;
      return {
        action,
        key,
        kind: 'digital' as const,
        identity: completedStepIdentity({
          actionKey: action.actionKey,
          cardId,
          kind: action.kind || 'task',
          title: action.title,
        }),
        actionKey: bounded(action.actionKey, 160) || undefined,
        cardId: bounded(cardId, 160) || undefined,
      };
    });
  const physical = (plan.physicalActions || [])
    .filter((action) => action.title?.trim())
    .map((action, index) => {
      const key = `physical-${index + 1}`;
      return {
        action,
        key,
        kind: 'physical' as const,
        identity: completedStepIdentity({
          kind: 'physical',
          title: action.title,
        }),
      };
    });
  return [...digital, ...physical];
}

/** Migrate legacy plan-scoped completion rows into stable progress entries. */
export function progressFromPlanCompletions(plan: PlanLike): StepProgressEntry[] {
  const completed = new Map((plan.completedSteps || []).map((row) => [row.stepKey, row] as const));
  return planStepsForProgress(plan).flatMap((step) => {
    const row = completed.get(step.key);
    if (!row) return [];
    return [
      {
        identity: step.identity,
        actionKey: step.actionKey,
        kind: step.kind === 'physical' ? 'physical' : step.action.kind || 'task',
        title: bounded(step.action.title, 240),
        cardId: step.cardId,
        completedAt: row.completedAt,
        source: row.source,
      },
    ];
  });
}

/** Merge idempotently, preserving the first recorded completion per identity. */
export function mergeStepProgress(
  existing: readonly StepProgressEntry[] | undefined,
  additions: readonly StepProgressEntry[],
  limit = 120,
) {
  // First wins: an existing completion keeps its original timestamp/source
  // when a legacy plan or later projection offers the same stable identity.
  const byIdentity = new Map<string, StepProgressEntry>();
  for (const row of [...(existing || []), ...additions]) {
    if (!row.identity || byIdentity.has(row.identity)) continue;
    byIdentity.set(row.identity, row);
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.completedAt - right.completedAt)
    .slice(-Math.max(1, limit));
}
