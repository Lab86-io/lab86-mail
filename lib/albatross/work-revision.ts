export interface RevisionAction {
  actionKey?: string;
  key?: string;
  kind?: string;
  title?: string;
}

export interface RevisionPlan {
  _id?: string;
  outcome?: string | null;
  digitalActions?: RevisionAction[];
  physicalActions?: Array<{ title?: string }>;
}

export interface WorkPlanRevisionSummary {
  changed: boolean;
  currentStep?: string;
  keptSteps: string[];
  removedSteps: string[];
  addedSteps: string[];
}

function normalize(value: unknown) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
}

function actions(plan: RevisionPlan | null | undefined) {
  return [
    ...(plan?.digitalActions || []).map((action) => ({
      actionKey: normalize(action.actionKey),
      fallbackId: `${normalize(action.kind)}:${normalize(action.title)}`,
      key: normalize(action.key),
      kind: action.kind,
      title: String(action.title || '').trim(),
    })),
    ...(plan?.physicalActions || []).map((action) => ({
      actionKey: '',
      fallbackId: `physical:${normalize(action.title)}`,
      key: '',
      kind: 'physical',
      title: String(action.title || '').trim(),
    })),
  ].filter((action) => action.title);
}

function sameAction(left: ReturnType<typeof actions>[number], right: ReturnType<typeof actions>[number]) {
  if (left.actionKey && right.actionKey) return left.actionKey === right.actionKey;
  if (left.fallbackId && right.fallbackId && left.fallbackId === right.fallbackId) return true;
  return !left.fallbackId && !right.fallbackId && Boolean(left.key && left.key === right.key);
}

/** A deterministic, compact explanation of what a plan revision changed. */
export function summarizeWorkPlanRevision(
  before: RevisionPlan | null | undefined,
  after: RevisionPlan | null | undefined,
): WorkPlanRevisionSummary {
  const previous = actions(before);
  const next = actions(after);
  const keptSteps = next
    .filter((action) => previous.some((candidate) => sameAction(candidate, action)))
    .map((action) => action.title);
  const removedSteps = previous
    .filter((action) => !next.some((candidate) => sameAction(action, candidate)))
    .map((action) => action.title);
  const addedSteps = next
    .filter((action) => !previous.some((candidate) => sameAction(candidate, action)))
    .map((action) => action.title);
  const outcomeChanged = normalize(before?.outcome) !== normalize(after?.outcome);
  return {
    changed: outcomeChanged || removedSteps.length > 0 || addedSteps.length > 0,
    currentStep: next.find((action) => action.kind !== 'calendar_event')?.title || next[0]?.title,
    keptSteps,
    removedSteps,
    addedSteps,
  };
}
