import rawSeed from '@/fixtures/albatross-0.9.seed.json';

// Albatross surface data layer.
//
// The Areas / Intents / Unassigned surfaces are operational read models over the
// Albatross 0.9 seed. Keeping the selectors here (pure, no React) lets the UI stay
// declarative and lets tests assert the data contracts the surfaces depend on.

export type FactStatus = 'verified' | 'candidate' | 'rejected';
export type LinkStatus = FactStatus;
export type ArtifactKind = 'mailThread' | 'calendarEvent' | 'mcpItem' | 'intent';

export interface SourceRef {
  kind: string;
  id: string;
  label?: string;
  confirmedAt?: string;
  prompt?: string;
}

export interface Area {
  id: string;
  name: string;
  kind: string;
  status: string;
  description: string;
  priority: number;
}

export interface AreaFact {
  id: string;
  areaId: string;
  kind: string;
  status: FactStatus;
  value: string;
  sourceRefs: SourceRef[];
  confirmationRefs: SourceRef[];
}

export interface MailThread {
  id: string;
  accountId: string;
  subject: string;
  from: string;
  lastDate: string;
  snippet: string;
  smartPrimary: string;
  unread: boolean;
  loudness: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: string[];
  areaId?: string;
}

export interface McpItem {
  id: string;
  provider: string;
  kind: string;
  title: string;
  url: string;
  areaId?: string;
}

export interface AreaArtifactLink {
  id: string;
  areaId: string;
  artifactKind: ArtifactKind;
  artifactId: string;
  role: string;
  status: LinkStatus;
  confidence: number;
  reason: string;
}

export interface ContextReviewItem {
  id: string;
  artifactKind: ArtifactKind;
  artifactId: string;
  reason: string;
  suggestedActions: string[];
  candidateAreaIds?: string[];
  candidateFactIds?: string[];
  sourceRefs: SourceRef[];
}

export interface IntentQuestion {
  id: string;
  text: string;
  kind: 'short_text' | 'choice' | 'confirm';
  choices?: string[];
}

export interface Intent {
  id: string;
  rawInput: string;
  source: 'text' | 'voice';
  capturedAt: string;
  classification: string;
  status: string;
  likelyAreaId: string;
  assumptions: string[];
  questions: IntentQuestion[];
  candidateFactIds?: string[];
}

export interface DigitalAction {
  kind: string;
  title: string;
  areaId?: string;
  priority?: number;
  durationMinutes?: number;
}

export interface IntentPlan {
  id: string;
  intentId: string;
  status: string;
  outcome: string;
  digitalActions: DigitalAction[];
  physicalActions: string[];
  sourceRefs: SourceRef[];
  assumptions: string[];
}

export interface Approval {
  id: string;
  sourceIntentId: string;
  sourcePlanId: string;
  areaId: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  requiresHumanApproval: boolean;
  undoWindowSeconds: number;
}

export interface CompletionEvent {
  id: string;
  completedAt: string;
  kind: string;
  artifactId: string;
  areaId: string;
  summary: string;
}

export interface Project {
  id: string;
  areaId: string;
  status: string;
  title?: string;
  outcome?: string;
}

interface SeedTables {
  areas: Area[];
  areaFacts: AreaFact[];
  mailThreads: MailThread[];
  calendarEvents: CalendarEvent[];
  mcpItems: McpItem[];
  areaArtifactLinks: AreaArtifactLink[];
  contextReviewItems: ContextReviewItem[];
  intents: Intent[];
  intentPlans: IntentPlan[];
  approvalQueue: Approval[];
  completionEvents: CompletionEvent[];
  projects: Project[];
}

const tables = (rawSeed as unknown as { tables: SeedTables }).tables;

export const areas = tables.areas;
export const areaFacts = tables.areaFacts;
export const mailThreads = tables.mailThreads;
export const calendarEvents = tables.calendarEvents;
export const mcpItems = tables.mcpItems;
export const areaArtifactLinks = tables.areaArtifactLinks;
export const contextReviewItems = tables.contextReviewItems;
export const intents = tables.intents;
export const intentPlans = tables.intentPlans;
export const approvalQueue = tables.approvalQueue;
export const completionEvents = tables.completionEvents;
export const projects = tables.projects;

const areaById = new Map(areas.map((area) => [area.id, area] as const));
const factById = new Map(areaFacts.map((fact) => [fact.id, fact] as const));
const threadById = new Map(mailThreads.map((thread) => [thread.id, thread] as const));
const eventById = new Map(calendarEvents.map((event) => [event.id, event] as const));
const mcpById = new Map(mcpItems.map((item) => [item.id, item] as const));

export function areaName(areaId: string | undefined): string {
  if (!areaId) return 'Unassigned';
  return areaById.get(areaId)?.name ?? 'Unknown area';
}

/** A human label + supporting line for any artifact referenced by id. */
export function resolveArtifact(
  kind: ArtifactKind,
  id: string,
): {
  kind: ArtifactKind;
  title: string;
  detail: string;
} {
  if (kind === 'mailThread') {
    const thread = threadById.get(id);
    if (thread) return { kind, title: thread.subject, detail: thread.from };
  }
  if (kind === 'calendarEvent') {
    const event = eventById.get(id);
    if (event) return { kind, title: event.title, detail: 'Calendar event' };
  }
  if (kind === 'mcpItem') {
    const item = mcpById.get(id);
    if (item) return { kind, title: item.title, detail: `${item.provider} · ${item.kind}` };
  }
  return { kind, title: id, detail: kind };
}

export interface AreaSummary {
  area: Area;
  factCounts: Record<FactStatus, number>;
  linkedCount: number;
  reviewCount: number;
  projectCount: number;
}

/** Per-area roll-up used by the Areas master list, sorted by priority then verified depth. */
export function buildAreaSummaries(): AreaSummary[] {
  const summaries = areas.map((area) => {
    const facts = areaFacts.filter((fact) => fact.areaId === area.id);
    const factCounts: Record<FactStatus, number> = {
      verified: facts.filter((fact) => fact.status === 'verified').length,
      candidate: facts.filter((fact) => fact.status === 'candidate').length,
      rejected: facts.filter((fact) => fact.status === 'rejected').length,
    };
    return {
      area,
      factCounts,
      linkedCount: areaArtifactLinks.filter((link) => link.areaId === area.id).length,
      reviewCount: contextReviewItems.filter((item) => item.candidateAreaIds?.includes(area.id)).length,
      projectCount: projects.filter((project) => project.areaId === area.id).length,
    } satisfies AreaSummary;
  });

  return summaries.sort((a, b) => {
    if (a.area.priority !== b.area.priority) return a.area.priority - b.area.priority;
    return b.factCounts.verified - a.factCounts.verified;
  });
}

export interface ResolvedLink {
  link: AreaArtifactLink;
  title: string;
  detail: string;
}

export interface AreaDetail {
  area: Area;
  facts: Record<FactStatus, AreaFact[]>;
  links: ResolvedLink[];
  changes: CompletionEvent[];
  projects: Project[];
}

export function buildAreaDetail(areaId: string): AreaDetail | null {
  const area = areaById.get(areaId);
  if (!area) return null;
  const facts = areaFacts.filter((fact) => fact.areaId === areaId);
  const links = areaArtifactLinks
    .filter((link) => link.areaId === areaId)
    .map((link) => {
      const resolved = resolveArtifact(link.artifactKind, link.artifactId);
      return { link, title: resolved.title, detail: resolved.detail } satisfies ResolvedLink;
    });
  return {
    area,
    facts: {
      verified: facts.filter((fact) => fact.status === 'verified'),
      candidate: facts.filter((fact) => fact.status === 'candidate'),
      rejected: facts.filter((fact) => fact.status === 'rejected'),
    },
    links,
    changes: completionEvents.filter((event) => event.areaId === areaId),
    projects: projects.filter((project) => project.areaId === areaId),
  };
}

export interface IntentWorkbench {
  intent: Intent;
  plan: IntentPlan | null;
  approvals: Approval[];
  areaLabel: string;
  openQuestionCount: number;
}

export function buildIntentWorkbench(intentId: string): IntentWorkbench | null {
  const intent = intents.find((item) => item.id === intentId);
  if (!intent) return null;
  const plan = intentPlans.find((item) => item.intentId === intentId) ?? null;
  return {
    intent,
    plan,
    approvals: approvalQueue.filter((approval) => approval.sourceIntentId === intentId),
    areaLabel: areaName(intent.likelyAreaId),
    openQuestionCount: intent.questions.length,
  };
}

export interface ReviewItem {
  item: ContextReviewItem;
  artifact: { kind: ArtifactKind; title: string; detail: string };
  thread: MailThread | null;
  candidateAreas: string[];
}

/** Triage queue rows: each review item resolved with its artifact + candidate area names. */
export function buildReviewQueue(): ReviewItem[] {
  return contextReviewItems.map((item) => {
    const thread = item.artifactKind === 'mailThread' ? (threadById.get(item.artifactId) ?? null) : null;
    return {
      item,
      artifact: resolveArtifact(item.artifactKind, item.artifactId),
      thread,
      candidateAreas: (item.candidateAreaIds ?? []).map((id) => areaName(id)),
    } satisfies ReviewItem;
  });
}

export interface ReviewDetail {
  item: ContextReviewItem;
  artifact: { kind: ArtifactKind; title: string; detail: string };
  thread: MailThread | null;
  candidateAreas: { id: string; name: string }[];
  candidateFacts: AreaFact[];
}

/**
 * Full triage decision context for one review item: the artifact and its
 * supporting thread, the area(s) the assistant proposes, and any candidate fact
 * the decision would confirm or reject. Drives the Unassigned detail pane.
 */
export function buildReviewDetail(itemId: string): ReviewDetail | null {
  const item = contextReviewItems.find((row) => row.id === itemId);
  if (!item) return null;
  const thread = item.artifactKind === 'mailThread' ? (threadById.get(item.artifactId) ?? null) : null;
  const candidateFacts = (item.candidateFactIds ?? [])
    .map((id) => factById.get(id))
    .filter((fact): fact is AreaFact => Boolean(fact));
  return {
    item,
    artifact: resolveArtifact(item.artifactKind, item.artifactId),
    thread,
    candidateAreas: (item.candidateAreaIds ?? []).map((id) => ({ id, name: areaName(id) })),
    candidateFacts,
  };
}

/** Verified sender/noise rules surfaced alongside the triage queue. */
export function buildNoiseRules(): AreaFact[] {
  return areaFacts.filter((fact) => fact.kind === 'sender_rule');
}

export function buildRecentCorrections(): CompletionEvent[] {
  return completionEvents.filter((event) => event.kind === 'context_review');
}

export interface SurfaceStat {
  label: string;
  value: number;
}

export function areasStats(): SurfaceStat[] {
  return [
    { label: 'Active areas', value: areas.filter((area) => area.status === 'active').length },
    { label: 'Verified facts', value: areaFacts.filter((fact) => fact.status === 'verified').length },
    { label: 'Open candidates', value: areaFacts.filter((fact) => fact.status === 'candidate').length },
    { label: 'Linked artifacts', value: areaArtifactLinks.length },
  ];
}

export function intentsStats(): SurfaceStat[] {
  return [
    { label: 'Captured', value: intents.length },
    {
      label: 'Needs answers',
      value: intents.filter((intent) => intent.status === 'needs_questions').length,
    },
    {
      label: 'Plans ready',
      value: intents.filter((intent) => intent.status === 'draft_plan_ready').length,
    },
    { label: 'Awaiting approval', value: approvalQueue.filter((a) => a.status === 'pending').length },
  ];
}

export function unassignedStats(): SurfaceStat[] {
  return [
    { label: 'Review items', value: contextReviewItems.length },
    { label: 'Noise rules', value: buildNoiseRules().length },
    {
      label: 'Candidate areas',
      value: new Set(contextReviewItems.flatMap((item) => item.candidateAreaIds ?? [])).size,
    },
    { label: 'Resolved recently', value: buildRecentCorrections().length },
  ];
}
