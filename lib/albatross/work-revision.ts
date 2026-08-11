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
      id: action.actionKey || action.key || `${normalize(action.kind)}:${normalize(action.title)}`,
      kind: action.kind,
      title: String(action.title || '').trim(),
    })),
    ...(plan?.physicalActions || []).map((action) => ({
      id: `physical:${normalize(action.title)}`,
      kind: 'physical',
      title: String(action.title || '').trim(),
    })),
  ].filter((action) => action.title);
}

/** A deterministic, compact explanation of what a plan revision changed. */
export function summarizeWorkPlanRevision(
  before: RevisionPlan | null | undefined,
  after: RevisionPlan | null | undefined,
): WorkPlanRevisionSummary {
  const previous = actions(before);
  const next = actions(after);
  const previousIds = new Set(previous.map((action) => action.id));
  const nextIds = new Set(next.map((action) => action.id));
  const keptSteps = next.filter((action) => previousIds.has(action.id)).map((action) => action.title);
  const removedSteps = previous.filter((action) => !nextIds.has(action.id)).map((action) => action.title);
  const addedSteps = next.filter((action) => !previousIds.has(action.id)).map((action) => action.title);
  const outcomeChanged = normalize(before?.outcome) !== normalize(after?.outcome);
  return {
    changed: outcomeChanged || removedSteps.length > 0 || addedSteps.length > 0,
    currentStep: next.find((action) => action.kind !== 'calendar_event')?.title || next[0]?.title,
    keptSteps,
    removedSteps,
    addedSteps,
  };
}
