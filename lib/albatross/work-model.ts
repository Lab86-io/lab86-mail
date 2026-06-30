export type AlbatrossArtifactKind =
  | 'project'
  | 'task'
  | 'calendar_event'
  | 'email_draft'
  | 'email_send'
  | 'calendar_rsvp'
  | 'area_fact';

export type AlbatrossProjectMode = 'auto' | 'project' | 'task_only' | 'ask';

export interface AlbatrossSourceRef {
  kind: string;
  id: string;
  label?: string;
  accountId?: string;
  url?: string;
}

export interface AlbatrossDigitalAction {
  kind: AlbatrossArtifactKind;
  title: string;
  areaId?: string;
  priority?: 1 | 2 | 3;
  durationMinutes?: number;
  startIso?: string;
  endIso?: string;
  account?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  html?: string;
  attendees?: string[];
  calendarId?: string;
  eventId?: string;
  rsvpStatus?: 'yes' | 'no' | 'maybe';
  description?: string;
  sourceRefs?: AlbatrossSourceRef[];
}

export interface AlbatrossProposedArtifact {
  kind: AlbatrossArtifactKind;
  title: string;
  areaId?: string;
  detail?: string;
  status?: string;
  sourceRefs?: AlbatrossSourceRef[];
}

export interface AlbatrossPlanLike {
  id?: string;
  intentId?: string;
  outcome?: string;
  digitalActions?: AlbatrossDigitalAction[];
  proposedArtifacts?: AlbatrossProposedArtifact[];
  sourceRefs?: AlbatrossSourceRef[];
}

export interface AlbatrossApplicationInput {
  intentId: string;
  intentText?: string;
  areaId?: string;
  projectMode?: AlbatrossProjectMode;
  projectTitle?: string;
  account?: string;
  plan: AlbatrossPlanLike;
}

export interface AlbatrossApplicationStep {
  id: string;
  kind: AlbatrossArtifactKind;
  title: string;
  areaId?: string;
  requiresApproval: boolean;
  blockedReason?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  sourceRefs: AlbatrossSourceRef[];
}

export interface AlbatrossApplicationPlan {
  intentId: string;
  planId?: string;
  projectTitle?: string;
  projectRequired: boolean;
  steps: AlbatrossApplicationStep[];
  unresolved: AlbatrossApplicationStep[];
  approvalSteps: AlbatrossApplicationStep[];
  executableSteps: AlbatrossApplicationStep[];
}

const PRIORITY_LABEL: Record<1 | 2 | 3, 'high' | 'medium' | 'low'> = {
  1: 'high',
  2: 'medium',
  3: 'low',
};

function clean(value: unknown): string {
  return String(value || '').trim();
}

function stepId(kind: string, title: string, index: number): string {
  const slug = `${kind}_${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `${slug || kind}_${index}`;
}

function refsFor(input: AlbatrossApplicationInput, action?: { sourceRefs?: AlbatrossSourceRef[] }) {
  return [...(action?.sourceRefs || []), ...(input.plan.sourceRefs || [])].filter(
    (ref, index, refs) =>
      ref.kind && ref.id && refs.findIndex((candidate) => candidate.id === ref.id) === index,
  );
}

function proposalProjectTitle(input: AlbatrossApplicationInput): string | undefined {
  if (input.projectTitle) return clean(input.projectTitle);
  const proposed = input.plan.proposedArtifacts?.find((artifact) => artifact.kind === 'project');
  if (proposed?.title) return clean(proposed.title);
  return undefined;
}

function needsProject(input: AlbatrossApplicationInput) {
  if (input.projectMode === 'task_only') return false;
  if (input.projectMode === 'project') return true;
  return Boolean(proposalProjectTitle(input));
}

function actionDescription(input: AlbatrossDigitalAction) {
  return clean(input.description) || undefined;
}

function calendarNeedsApproval(action: AlbatrossDigitalAction) {
  return action.kind === 'calendar_event' && Boolean(action.attendees?.length);
}

function humanFacing(action: AlbatrossDigitalAction) {
  return action.kind === 'email_send' || action.kind === 'calendar_rsvp' || calendarNeedsApproval(action);
}

function taskArgs(input: AlbatrossApplicationInput, action: AlbatrossDigitalAction) {
  return {
    title: clean(action.title),
    description: actionDescription(action),
    priority: action.priority ? PRIORITY_LABEL[action.priority] : undefined,
    source: {
      kind: 'chat',
      title: input.intentText || input.plan.outcome || 'Albatross intent',
      externalId: input.intentId,
      areaId: action.areaId || input.areaId,
    },
  };
}

function calendarArgs(input: AlbatrossApplicationInput, action: AlbatrossDigitalAction) {
  return {
    account: action.account || input.account,
    title: clean(action.title),
    startIso: action.startIso,
    endIso: action.endIso,
    description: actionDescription(action) || input.plan.outcome,
    attendees: action.attendees,
  };
}

function draftArgs(input: AlbatrossApplicationInput, action: AlbatrossDigitalAction) {
  return {
    account: action.account || input.account,
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    subject: action.subject || action.title,
    body: action.body || '',
    html: action.html,
  };
}

function approvalTool(action: AlbatrossDigitalAction) {
  if (action.kind === 'email_send') return 'send_message';
  if (action.kind === 'calendar_rsvp') return 'calendar_rsvp_event';
  if (action.kind === 'calendar_event') return 'calendar_create_event';
  return 'external_action';
}

function approvalArgs(input: AlbatrossApplicationInput, action: AlbatrossDigitalAction) {
  if (action.kind === 'calendar_event') return calendarArgs(input, action);
  if (action.kind === 'calendar_rsvp') {
    return {
      account: action.account || input.account,
      calendarId: action.calendarId,
      eventId: action.eventId,
      status: action.rsvpStatus,
    };
  }
  return {
    account: action.account || input.account,
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    subject: action.subject || action.title,
    body: action.body || '',
    html: action.html,
  };
}

function blockedReason(input: AlbatrossApplicationInput, action: AlbatrossDigitalAction): string | undefined {
  if (!clean(action.title)) return 'Title is required.';
  if (action.kind === 'calendar_event') {
    const args = calendarArgs(input, action);
    if (!args.account) return 'Calendar account is required.';
    if (!args.startIso || !args.endIso) return 'Calendar start and end times are required.';
  }
  if (action.kind === 'email_draft') {
    const args = draftArgs(input, action);
    if (!args.account) return 'Draft account is required.';
    if (!args.to) return 'Draft recipient is required.';
    if (!args.body) return 'Draft body is required.';
  }
  if (action.kind === 'email_send') {
    const args = approvalArgs(input, action) as Record<string, unknown>;
    if (!args.account || !args.to || !args.body) return 'Send approval needs account, recipient, and body.';
  }
  if (action.kind === 'calendar_rsvp') {
    const args = approvalArgs(input, action) as Record<string, unknown>;
    if (!args.account || !args.calendarId || !args.eventId || !args.status)
      return 'RSVP approval needs account, calendar, event, and status.';
  }
  return undefined;
}

function actionStep(
  input: AlbatrossApplicationInput,
  action: AlbatrossDigitalAction,
  index: number,
): AlbatrossApplicationStep {
  const reason = blockedReason(input, action);
  const requiresApproval = humanFacing(action);
  const base = {
    id: stepId(action.kind, action.title, index),
    kind: action.kind,
    title: clean(action.title) || 'Untitled action',
    areaId: action.areaId || input.areaId,
    requiresApproval,
    blockedReason: reason,
    sourceRefs: refsFor(input, action),
  };
  if (reason) return base;
  if (requiresApproval) {
    return { ...base, toolName: approvalTool(action), toolArgs: approvalArgs(input, action) };
  }
  if (action.kind === 'task')
    return { ...base, toolName: 'tasks_create_card', toolArgs: taskArgs(input, action) };
  if (action.kind === 'calendar_event')
    return { ...base, toolName: 'calendar_create_event', toolArgs: calendarArgs(input, action) };
  if (action.kind === 'email_draft')
    return { ...base, toolName: 'save_draft', toolArgs: draftArgs(input, action) };
  return { ...base, blockedReason: 'This artifact kind is not directly executable yet.' };
}

export function buildAlbatrossApplicationPlan(input: AlbatrossApplicationInput): AlbatrossApplicationPlan {
  const projectTitle = proposalProjectTitle(input);
  const projectRequired = needsProject(input);
  const projectStep: AlbatrossApplicationStep[] =
    projectRequired && projectTitle
      ? [
          {
            id: stepId('project', projectTitle, 0),
            kind: 'project',
            title: projectTitle,
            areaId: input.areaId,
            requiresApproval: false,
            toolName: 'albatross_create_project',
            toolArgs: {
              externalId: `intent:${input.intentId}`,
              title: projectTitle,
              outcome: input.plan.outcome,
              areaId: input.areaId,
              sourceIntentId: input.intentId,
              sourceRefs: refsFor(input),
            },
            sourceRefs: refsFor(input),
          },
        ]
      : [];
  const actions = input.plan.digitalActions || [];
  const steps = [...projectStep, ...actions.map((action, index) => actionStep(input, action, index + 1))];
  const unresolved = steps.filter((step) => step.blockedReason);
  const approvalSteps = steps.filter((step) => !step.blockedReason && step.requiresApproval);
  const executableSteps = steps.filter((step) => !step.blockedReason && !step.requiresApproval);
  return {
    intentId: input.intentId,
    planId: input.plan.id,
    projectTitle,
    projectRequired,
    steps,
    unresolved,
    approvalSteps,
    executableSteps,
  };
}

export function unresolvedArtifactsAfterUndo(
  application: { artifacts?: unknown[] },
  operations: Array<{ status?: string; target?: { id?: string; kind?: string } }>,
) {
  const undoneTargets = new Set(
    operations
      .filter((operation) => operation.status === 'undone')
      .map((operation) => `${operation.target?.kind || ''}:${operation.target?.id || ''}`),
  );
  return (application.artifacts || []).filter((artifact: any) =>
    undoneTargets.has(
      `${artifact.kind || artifact.artifactKind || ''}:${artifact.id || artifact.artifactId || ''}`,
    ),
  );
}
