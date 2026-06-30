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
  url?: string;
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
  confirmationRefs?: SourceRef[];
}

export interface Task {
  id: string;
  title: string;
  status: string;
  areaId?: string;
  projectId?: string;
  priority?: number;
  sourceRefs?: SourceRef[];
}

export interface Account {
  id: string;
  provider: string;
  email: string;
  displayName?: string;
  primary?: boolean;
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
  accounts: Account[];
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
  tasks: Task[];
}

const tables = (rawSeed as unknown as { tables: SeedTables }).tables;

export const accounts = tables.accounts;
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
export const tasks = tables.tasks;

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
    if (item) return { kind, title: item.title, detail: `${item.provider} / ${item.kind}` };
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
  plan: GeneratedIntentPlan | null;
  approvals: Approval[];
  areaLabel: string;
  openQuestionCount: number;
  parsed: ParsedIntent;
  contextPack: IntentContextPack;
}

export function buildIntentWorkbench(intentId: string): IntentWorkbench | null {
  const intent = intents.find((item) => item.id === intentId);
  if (!intent) return null;
  const parsed = parseIntent(intent);
  return {
    intent,
    plan: parsed.plan,
    approvals: approvalQueue.filter((approval) => approval.sourceIntentId === intentId),
    areaLabel: areaName(intent.likelyAreaId),
    openQuestionCount: intent.questions.length,
    parsed,
    contextPack: parsed.contextPack,
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

/* ================================================================== */
/* Issue #72 - Area Setup                                              */
/* ------------------------------------------------------------------ */
/* Setup teaches Albatross what the user is responsible for. It is     */
/* organised by area (not by demographics) and asks for verifiable     */
/* context: people, domains, repos, websites, tools, calendars,        */
/* accounts. Everything here is a pure read model over the seed so the */
/* UI stays declarative and resumable; nothing auto-verifies a person. */

export type SetupFactKind = 'person' | 'domain' | 'repo' | 'website' | 'tool' | 'calendar' | 'account';

export interface SetupFactKindMeta {
  kind: SetupFactKind;
  label: string;
  /** Concrete, plain-language prompt - never a demographic question. */
  prompt: string;
  placeholder: string;
  /** People and area membership are never auto-verified (trust boundary). */
  autoVerifies: boolean;
}

// The seven context types an area can hold. Ordered most- to least-common so
// setup leads with the questions that ground classification fastest.
export const SETUP_FACT_KINDS: SetupFactKindMeta[] = [
  {
    kind: 'person',
    label: 'People',
    prompt: 'Who do you work with here?',
    placeholder: 'Name or email - e.g. Andrew',
    autoVerifies: false,
  },
  {
    kind: 'domain',
    label: 'Domains',
    prompt: 'Which email domains belong to this?',
    placeholder: 'e.g. cardhunt.example',
    autoVerifies: true,
  },
  {
    kind: 'repo',
    label: 'Repos',
    prompt: 'Any code repositories?',
    placeholder: 'e.g. github.com/cardhunt/app',
    autoVerifies: true,
  },
  {
    kind: 'website',
    label: 'Websites',
    prompt: 'Any sites or dashboards?',
    placeholder: 'e.g. cardhunt.example/admin',
    autoVerifies: true,
  },
  {
    kind: 'tool',
    label: 'Tools',
    prompt: 'Which tools or integrations?',
    placeholder: 'e.g. Linear, Jira, Notion',
    autoVerifies: true,
  },
  {
    kind: 'calendar',
    label: 'Calendars',
    prompt: 'Which calendar covers this?',
    placeholder: 'e.g. Work calendar',
    autoVerifies: true,
  },
  {
    kind: 'account',
    label: 'Accounts',
    prompt: 'Which mailbox or account?',
    placeholder: 'e.g. jakob@cardhunt.example',
    autoVerifies: true,
  },
];

// Map a setup context type onto the underlying fact kinds the seed already
// uses, so existing facts count as "covered" without restating them.
const SETUP_KIND_TO_FACT_KINDS: Record<SetupFactKind, string[]> = {
  person: ['person', 'person_relationship', 'relationship_finance'],
  domain: ['domain'],
  repo: ['repo'],
  website: ['website'],
  tool: ['tool', 'integration'],
  calendar: ['calendar'],
  account: ['account'],
};

export interface SetupSlot {
  kind: SetupFactKind;
  meta: SetupFactKindMeta;
  facts: AreaFact[];
  filled: boolean;
  /** Verified facts only - a candidate person still leaves the slot "to confirm". */
  verifiedCount: number;
  candidateCount: number;
}

export interface SetupStep {
  area: Area;
  /** The one responsibility question that opens the step. */
  responsibilityPrompt: string;
  isWork: boolean;
  slots: SetupSlot[];
  filledSlots: number;
  totalSlots: number;
  /** True once at least one verifiable context type is captured. */
  started: boolean;
  complete: boolean;
}

export interface DraftedFact {
  areaId: string;
  kind: SetupFactKind;
  value: string;
  /** Candidate until the user confirms; people never start verified. */
  status: FactStatus;
  reason: string;
}

export interface SetupProgressOverlay {
  drafts?: DraftedFact[];
  /**
   * Confirmed seeded fact ids plus draftedFactKey(draft) values for candidate
   * drafts the user explicitly confirmed in this setup session.
   */
  confirmedFactIds?: Iterable<string>;
}

function responsibilityPromptFor(area: Area): string {
  if (area.kind === 'work') return `What are you responsible for in ${area.name}?`;
  if (area.kind === 'life_admin') return `What do you need to stay on top of in ${area.name}?`;
  if (area.kind === 'learning') return `What are you trying to learn or follow in ${area.name}?`;
  return `What matters to you in ${area.name}?`;
}

export function draftedFactKey(draft: DraftedFact): string {
  return `draft:${draft.areaId}:${draft.kind}:${draft.value.trim().toLowerCase()}`;
}

function setupConfirmationSet(overlay?: SetupProgressOverlay): Set<string> {
  return new Set(overlay?.confirmedFactIds ?? []);
}

function setupFactVerified(fact: AreaFact, confirmed: Set<string>): boolean {
  return fact.status === 'verified' || confirmed.has(fact.id);
}

function setupDraftVerified(draft: DraftedFact, confirmed: Set<string>): boolean {
  return draft.status === 'verified' || confirmed.has(draftedFactKey(draft));
}

/** Per-area setup step: which context types are covered and which are open. */
export function buildSetupStep(areaId: string, overlay?: SetupProgressOverlay): SetupStep | null {
  const area = areaById.get(areaId);
  if (!area) return null;
  const confirmed = setupConfirmationSet(overlay);
  const drafts = overlay?.drafts?.filter((draft) => draft.areaId === areaId) ?? [];
  const facts = areaFacts.filter((fact) => fact.areaId === areaId && fact.status !== 'rejected');
  const slots: SetupSlot[] = SETUP_FACT_KINDS.map((meta) => {
    const kinds = SETUP_KIND_TO_FACT_KINDS[meta.kind];
    const slotFacts = facts.filter((fact) => kinds.includes(fact.kind));
    const slotDrafts = drafts.filter((draft) => draft.kind === meta.kind);
    const verifiedCount =
      slotFacts.filter((fact) => setupFactVerified(fact, confirmed)).length +
      slotDrafts.filter((draft) => setupDraftVerified(draft, confirmed)).length;
    const candidateCount =
      slotFacts.filter((fact) => fact.status === 'candidate' && !confirmed.has(fact.id)).length +
      slotDrafts.filter((draft) => draft.status === 'candidate' && !confirmed.has(draftedFactKey(draft)))
        .length;
    return {
      kind: meta.kind,
      meta,
      facts: slotFacts,
      filled: verifiedCount > 0,
      verifiedCount,
      candidateCount,
    } satisfies SetupSlot;
  });
  const filledSlots = slots.filter((slot) => slot.filled).length;
  return {
    area,
    responsibilityPrompt: responsibilityPromptFor(area),
    isWork: area.kind === 'work',
    slots,
    filledSlots,
    totalSlots: slots.length,
    started: filledSlots > 0,
    // "Complete enough" is intentionally low - setup should never feel like a
    // form to finish. Two solid context types is plenty to start classifying.
    complete: filledSlots >= 2,
  } satisfies SetupStep;
}

/** Full setup plan across active areas, ordered by priority (job/work first). */
export function buildSetupPlan(overlay?: SetupProgressOverlay): SetupStep[] {
  return areas
    .filter((area) => area.status === 'active')
    .map((area) => buildSetupStep(area.id, overlay))
    .filter((step): step is SetupStep => step !== null)
    .sort((a, b) => {
      if (a.isWork !== b.isWork) return a.isWork ? -1 : 1;
      if (a.area.priority !== b.area.priority) return a.area.priority - b.area.priority;
      return a.area.name.localeCompare(b.area.name);
    });
}

export interface SetupProgress {
  totalAreas: number;
  startedAreas: number;
  completeAreas: number;
  filledSlots: number;
  totalSlots: number;
  /** 0-1 completeness used for the resumable progress meter. */
  ratio: number;
}

export function summarizeSetupProgress(planOrOverlay?: SetupStep[] | SetupProgressOverlay): SetupProgress {
  const plan = Array.isArray(planOrOverlay) ? planOrOverlay : buildSetupPlan(planOrOverlay);
  const filledSlots = plan.reduce((sum, step) => sum + step.filledSlots, 0);
  const totalSlots = plan.reduce((sum, step) => sum + step.totalSlots, 0);
  return {
    totalAreas: plan.length,
    startedAreas: plan.filter((step) => step.started).length,
    completeAreas: plan.filter((step) => step.complete).length,
    filledSlots,
    totalSlots,
    ratio: totalSlots === 0 ? 0 : filledSlots / totalSlots,
  };
}

/**
 * Turn a raw setup answer into a fact draft, respecting trust boundaries:
 * people (and area membership) are always candidates and must be confirmed;
 * concrete identifiers (domains/repos/etc.) the user typed are treated as
 * user-asserted and may be verified directly. Returns null for empty input.
 */
export function draftSetupFact(areaId: string, kind: SetupFactKind, rawValue: string): DraftedFact | null {
  const value = rawValue.trim();
  if (!value) return null;
  const meta = SETUP_FACT_KINDS.find((entry) => entry.kind === kind);
  if (!meta) return null;
  const status: FactStatus = meta.autoVerifies ? 'verified' : 'candidate';
  return {
    areaId,
    kind,
    value,
    status,
    reason: meta.autoVerifies
      ? 'You added this directly in setup.'
      : 'Held as a candidate until you confirm the relationship.',
  };
}

/* ================================================================== */
/* Issue #74 - Area-aware artifact classifier                          */
/* ------------------------------------------------------------------ */
/* A deterministic, pure matcher. It scores an artifact against        */
/* verified facts, candidate facts, smart labels, thread/event/MCP     */
/* metadata, and task/intent provenance, then returns ONE primary area */
/* plus rare, reasoned secondaries. Low confidence routes to           */
/* Unassigned. It never invents a person or an area membership - it    */
/* only proposes area links, and only marks them verified when a hard, */
/* already-verified signal backs them.                                 */

export type AssignmentStatus = 'verified' | 'candidate';

export interface ClassifierArtifact {
  kind: ArtifactKind;
  id: string;
  /** Subject/title + snippet/body, used for token matching. */
  text: string;
  senderEmail?: string;
  attendees?: string[];
  url?: string;
  /** Explicit area set by a trusted system link (event/MCP/task). */
  provenanceAreaId?: string;
  provenanceKind?: 'calendarEvent' | 'mcpItem' | 'task' | 'intent';
  /** Existing smart-mail category. Read only - never used to create an area. */
  smartPrimary?: string;
}

export interface AreaAssignment {
  areaId: string;
  areaName: string;
  status: AssignmentStatus;
  confidence: number;
  reason: string;
  signals: string[];
}

export interface ArtifactClassification {
  artifactId: string;
  /** null => Unassigned. */
  primary: AreaAssignment | null;
  secondary: AreaAssignment[];
  unassignedReason?: string;
}

const ASSIGN_THRESHOLD = 0.55;
const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'with',
  'this',
  'that',
  'are',
  'from',
  'about',
  'into',
  'new',
  'has',
  'have',
  'will',
  'can',
  'all',
  'any',
  'out',
  'not',
  'but',
  'management',
  'review',
  'today',
  'week',
  'day',
]);

function emailDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return (
    email
      .slice(at + 1)
      .toLowerCase()
      .trim() || null
  );
}

function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  const stripped = url.replace(/^[a-z]+:\/\//i, '').toLowerCase();
  const host = stripped.split('/')[0];
  return host || null;
}

function normalizeIdentityUrl(value: string): string {
  return value
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function urlIdentityMatches(fullUrl: string, factValue: string): boolean {
  const normalized = normalizeIdentityUrl(factValue);
  return (
    normalized.length > 0 &&
    (fullUrl === normalized ||
      fullUrl.startsWith(`${normalized}/`) ||
      fullUrl.startsWith(`${normalized}?`) ||
      fullUrl.startsWith(`${normalized}#`))
  );
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token)),
  );
}

interface AreaSignal {
  weight: number;
  status: AssignmentStatus;
  signal: string;
}

// Score one area against an artifact. Hard identity matches (verified
// domain/repo, trusted provenance) outrank soft token/candidate matches, and
// only hard, already-verified matches are allowed to produce a verified
// assignment. `smartPrimary === 'noise'` can only demote, never promote - the
// "loud is not important" rule made explicit.
function scoreAreaSignals(area: Area, artifact: ClassifierArtifact): AreaSignal[] {
  const signals: AreaSignal[] = [];
  const facts = areaFacts.filter((fact) => fact.areaId === area.id && fact.status !== 'rejected');
  // Email/host domains used for domain-fact matching.
  const hosts = new Set<string>();
  const senderDomain = emailDomain(artifact.senderEmail);
  if (senderDomain) hosts.add(senderDomain);
  for (const attendee of artifact.attendees ?? []) {
    const dom = emailDomain(attendee);
    if (dom) hosts.add(dom);
  }
  const host = urlHost(artifact.url);
  if (host) hosts.add(host);
  // Full scheme-stripped URL for path-aware repo/website matching, so a shared
  // host (e.g. github.com) never collapses two different repos into one area.
  const fullUrl = artifact.url ? artifact.url.replace(/^[a-z]+:\/\//i, '').toLowerCase() : '';

  // Trusted provenance: a system link already points this artifact at an area.
  // This is the strongest signal - it edges out a bare domain match.
  if (artifact.provenanceAreaId === area.id) {
    signals.push({ weight: 0.95, status: 'verified', signal: 'Linked by a trusted source' });
  }

  for (const fact of facts) {
    const factValue = fact.value.toLowerCase();
    let identityMatch = false;
    if (fact.kind === 'domain') {
      identityMatch = [...hosts].some((h) => h === factValue || h.endsWith(`.${factValue}`));
    } else if (fact.kind === 'repo') {
      identityMatch = urlIdentityMatches(fullUrl, factValue);
    } else if (fact.kind === 'website') {
      identityMatch =
        urlIdentityMatches(fullUrl, factValue) ||
        [...hosts].some((h) => h === factValue || factValue.startsWith(h));
    }
    if (identityMatch) {
      signals.push(
        fact.status === 'verified'
          ? { weight: 0.92, status: 'verified', signal: `Verified ${fact.kind} ${fact.value}` }
          : { weight: 0.7, status: 'candidate', signal: `Candidate ${fact.kind} ${fact.value}` },
      );
      continue;
    }
    // Token overlap against the fact value (covers interests, deadlines, etc.).
    const factTokens = tokenize(fact.value);
    const textTokens = tokenize(artifact.text);
    const overlap = [...factTokens].filter((token) => textTokens.has(token));
    if (overlap.length > 0) {
      signals.push(
        fact.status === 'verified'
          ? { weight: 0.6, status: 'candidate', signal: `Matches "${overlap[0]}"` }
          : { weight: 0.45, status: 'candidate', signal: `Loosely matches "${overlap[0]}"` },
      );
    }
  }

  // Area name token match (e.g. "CardHunt" in a subject line).
  const nameTokens = tokenize(area.name);
  const textTokens = tokenize(artifact.text);
  if ([...nameTokens].some((token) => textTokens.has(token))) {
    signals.push({ weight: 0.6, status: 'candidate', signal: `Mentions ${area.name}` });
  }

  return signals;
}

function bestAssignment(area: Area, artifact: ClassifierArtifact): AreaAssignment | null {
  const signals = scoreAreaSignals(area, artifact);
  if (!signals.length) return null;
  const ranked = [...signals].sort((a, b) => b.weight - a.weight);
  const top = ranked[0];
  let confidence = top.weight;
  // A second independent signal adds a little confidence (capped).
  if (ranked.length > 1) confidence = Math.min(0.98, confidence + 0.04);
  // Noise demotes below the auto-assignment bar unless another workflow later
  // gives the user a chance to verify it in review.
  if (artifact.smartPrimary === 'noise') confidence *= 0.55;
  const status: AssignmentStatus = top.status === 'verified' ? 'verified' : 'candidate';
  return {
    areaId: area.id,
    areaName: area.name,
    status,
    confidence: Math.round(confidence * 100) / 100,
    reason: top.signal,
    signals: ranked.map((signal) => signal.signal),
  };
}

/** Classify one artifact into a primary area plus rare reasoned secondaries. */
export function classifyArtifact(artifact: ClassifierArtifact): ArtifactClassification {
  const candidates = areas
    .map((area) => bestAssignment(area, artifact))
    .filter((assignment): assignment is AreaAssignment => assignment !== null)
    .sort((a, b) => b.confidence - a.confidence);

  const top = candidates[0];
  if (!top || top.confidence < ASSIGN_THRESHOLD) {
    return {
      artifactId: artifact.id,
      primary: null,
      secondary: [],
      unassignedReason: top
        ? `Best guess (${top.areaName}) is below the confidence bar - routed to Unassigned for review.`
        : 'No verified or candidate context matched - routed to Unassigned.',
    };
  }

  // Secondary assignments are deliberately rare: another area must clear the
  // bar on its own AND be close to the primary. Each carries its own reason.
  const secondary = candidates
    .slice(1)
    .filter(
      (assignment) =>
        assignment.confidence >= ASSIGN_THRESHOLD && assignment.confidence >= top.confidence * 0.7,
    )
    .slice(0, 1);

  return { artifactId: artifact.id, primary: top, secondary };
}

/** Resolve a seed artifact (thread/event/MCP) into classifier input. */
export function toClassifierArtifact(kind: ArtifactKind, id: string): ClassifierArtifact | null {
  if (kind === 'mailThread') {
    const thread = threadById.get(id);
    if (!thread) return null;
    return {
      kind,
      id,
      text: `${thread.subject} ${thread.snippet}`,
      senderEmail: thread.from,
      smartPrimary: thread.smartPrimary,
    };
  }
  if (kind === 'calendarEvent') {
    const event = eventById.get(id);
    if (!event) return null;
    return {
      kind,
      id,
      text: event.title,
      attendees: event.attendees,
      provenanceAreaId: event.areaId,
      provenanceKind: 'calendarEvent',
    };
  }
  if (kind === 'mcpItem') {
    const item = mcpById.get(id);
    if (!item) return null;
    return {
      kind,
      id,
      text: item.title,
      url: item.url,
      provenanceAreaId: item.areaId,
      provenanceKind: 'mcpItem',
    };
  }
  return null;
}

/** Convenience: classify a seed mail thread by id. */
export function classifyThread(threadId: string): ArtifactClassification | null {
  const artifact = toClassifierArtifact('mailThread', threadId);
  return artifact ? classifyArtifact(artifact) : null;
}

/* ================================================================== */
/* Issue #75 - Area lenses                                             */
/* ------------------------------------------------------------------ */
/* An area gathers its mail/tasks/events/people/facts/projects and     */
/* pending candidates. Lenses slice that set the way you'd actually    */
/* work it: what needs reply, what's an open loop, files, people,      */
/* noise. Verified vs candidate is always explicit.                    */

export type AreaLensKey =
  | 'needs_reply'
  | 'open_loops'
  | 'tasks'
  | 'events'
  | 'files_links'
  | 'people'
  | 'noise';

export const AREA_LENSES: { key: AreaLensKey; label: string }[] = [
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'open_loops', label: 'Open loops' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'events', label: 'Events' },
  { key: 'files_links', label: 'Files / links' },
  { key: 'people', label: 'People' },
  { key: 'noise', label: 'Noise' },
];

export type AreaLensItemKind = ArtifactKind | 'task' | 'fact' | 'person' | 'project';

export interface AreaLensItem {
  id: string;
  kind: AreaLensItemKind;
  title: string;
  detail: string;
  status?: AssignmentStatus | 'rejected';
  meta?: string;
  reason?: string;
  /** Whether the user can correct this item's area assignment. */
  canReassign: boolean;
}

function linksForArea(areaId: string, kind: ArtifactKind): AreaArtifactLink[] {
  return areaArtifactLinks.filter((link) => link.areaId === areaId && link.artifactKind === kind);
}

function lensStatus(status: LinkStatus): AssignmentStatus | 'rejected' {
  return status;
}

/** Items for one lens of one area. Pure - drives the area inspector lens view. */
export function buildAreaLens(areaId: string, lens: AreaLensKey): AreaLensItem[] {
  const area = areaById.get(areaId);
  if (!area) return [];

  if (lens === 'needs_reply') {
    return linksForArea(areaId, 'mailThread')
      .map((link) => ({ link, thread: threadById.get(link.artifactId) }))
      .filter(
        (row): row is { link: AreaArtifactLink; thread: MailThread } =>
          Boolean(row.thread) &&
          row.link.status !== 'rejected' &&
          (row.thread!.smartPrimary === 'needs_reply' || row.thread!.unread),
      )
      .map(({ link, thread }) => ({
        id: link.id,
        kind: 'mailThread' as const,
        title: thread.subject,
        detail: thread.from,
        status: lensStatus(link.status),
        meta: thread.unread ? 'Unread' : 'Open',
        canReassign: true,
      }));
  }

  if (lens === 'open_loops') {
    const candidateLinks = areaArtifactLinks
      .filter((link) => link.areaId === areaId && link.status === 'candidate')
      .map((link) => {
        const resolved = resolveArtifact(link.artifactKind, link.artifactId);
        return {
          id: link.id,
          kind: link.artifactKind,
          title: resolved.title,
          detail: resolved.detail,
          status: 'candidate' as const,
          meta: 'Assignment unconfirmed',
          reason: link.reason,
          canReassign: true,
        } satisfies AreaLensItem;
      });
    const candidateFacts = areaFacts
      .filter((fact) => fact.areaId === areaId && fact.status === 'candidate')
      .map((fact) => ({
        id: fact.id,
        kind: 'fact' as const,
        title: fact.value,
        detail: titleCaseLocal(fact.kind),
        status: 'candidate' as const,
        meta: 'Fact to confirm',
        canReassign: false,
      }));
    const openProjects = projects
      .filter((project) => project.areaId === areaId && project.status !== 'done')
      .map((project) => ({
        id: project.id,
        kind: 'project' as const,
        title: project.title ?? titleCaseLocal(project.status),
        detail: project.outcome ?? 'Project',
        meta: titleCaseLocal(project.status),
        canReassign: false,
      }));
    return [...candidateLinks, ...candidateFacts, ...openProjects];
  }

  if (lens === 'tasks') {
    return tasks
      .filter((task) => task.areaId === areaId)
      .map((task) => ({
        id: task.id,
        kind: 'task' as const,
        title: task.title,
        detail: task.projectId ? areaName(areaId) : 'Standalone task',
        meta: task.priority
          ? `P${task.priority} / ${titleCaseLocal(task.status)}`
          : titleCaseLocal(task.status),
        canReassign: true,
      }));
  }

  if (lens === 'events') {
    const linkedIds = new Set(
      linksForArea(areaId, 'calendarEvent')
        .filter((link) => link.status !== 'rejected')
        .map((link) => link.artifactId),
    );
    return calendarEvents
      .filter((event) => event.areaId === areaId || linkedIds.has(event.id))
      .map((event) => ({
        id: event.id,
        kind: 'calendarEvent' as const,
        title: event.title,
        detail: event.attendees.length
          ? `${event.attendees.length} attendee${event.attendees.length === 1 ? '' : 's'}`
          : 'No attendees',
        meta: fmtLensDate(event.startsAt),
        canReassign: true,
      }));
  }

  if (lens === 'files_links') {
    const mcp = mcpItems
      .filter((item) => item.areaId === areaId)
      .map((item) => ({
        id: item.id,
        kind: 'mcpItem' as const,
        title: item.title,
        detail: `${item.provider} / ${item.kind}`,
        meta: item.url,
        canReassign: true,
      }));
    const identifierFacts = areaFacts
      .filter(
        (fact) =>
          fact.areaId === areaId &&
          fact.status !== 'rejected' &&
          ['domain', 'repo', 'website', 'tool'].includes(fact.kind),
      )
      .map((fact) => ({
        id: fact.id,
        kind: 'fact' as const,
        title: fact.value,
        detail: titleCaseLocal(fact.kind),
        status: lensStatus(fact.status as LinkStatus),
        canReassign: false,
      }));
    return [...mcp, ...identifierFacts];
  }

  if (lens === 'people') {
    const peopleFacts = areaFacts
      .filter(
        (fact) =>
          fact.areaId === areaId &&
          fact.status !== 'rejected' &&
          ['person', 'person_relationship', 'relationship_finance'].includes(fact.kind),
      )
      .map((fact) => ({
        id: fact.id,
        kind: 'person' as const,
        title: fact.value,
        detail: titleCaseLocal(fact.kind),
        status: lensStatus(fact.status as LinkStatus),
        meta: fact.status === 'candidate' ? 'Not confirmed' : 'Confirmed',
        canReassign: false,
      }));
    // Distinct correspondents drawn from this area's linked threads + events.
    const emails = new Set<string>();
    for (const link of linksForArea(areaId, 'mailThread')) {
      const thread = threadById.get(link.artifactId);
      if (thread && link.status !== 'rejected') emails.add(thread.from);
    }
    for (const event of calendarEvents.filter((e) => e.areaId === areaId)) {
      for (const attendee of event.attendees) emails.add(attendee);
    }
    const correspondents = [...emails].map((email) => ({
      id: `person-${email}`,
      kind: 'person' as const,
      title: email,
      detail: 'Correspondent',
      meta: 'Observed',
      canReassign: false,
    }));
    return [...peopleFacts, ...correspondents];
  }

  // noise
  const rejectedLinks = areaArtifactLinks
    .filter((link) => link.areaId === areaId && link.status === 'rejected')
    .map((link) => {
      const resolved = resolveArtifact(link.artifactKind, link.artifactId);
      return {
        id: link.id,
        kind: link.artifactKind,
        title: resolved.title,
        detail: resolved.detail,
        status: 'rejected' as const,
        reason: link.reason,
        canReassign: true,
      } satisfies AreaLensItem;
    });
  const senderRules = areaFacts
    .filter((fact) => fact.areaId === areaId && fact.kind === 'sender_rule')
    .map((fact) => ({
      id: fact.id,
      kind: 'fact' as const,
      title: fact.value,
      detail: 'Sender rule',
      status: lensStatus(fact.status as LinkStatus),
      canReassign: false,
    }));
  return [...rejectedLinks, ...senderRules];
}

export function buildAreaLensCounts(areaId: string): Record<AreaLensKey, number> {
  const counts = {} as Record<AreaLensKey, number>;
  for (const lens of AREA_LENSES) counts[lens.key] = buildAreaLens(areaId, lens.key).length;
  return counts;
}

function titleCaseLocal(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugifyLocal(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fmtLensDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ================================================================== */
/* Issue #73 - Review decision effects                                 */
/* ------------------------------------------------------------------ */
/* Each triage action is projected into a concrete read-model change:  */
/* a verified/rejected fact, an area link, a noise/sender rule, or a   */
/* new candidate area. The effect is shown BEFORE commit so context is */
/* never learned silently, and described as "what this does" + "going  */
/* forward" so the future-classification change is legible.            */

export type ReviewActionKind =
  | 'assign_area'
  | 'create_area'
  | 'mark_noise'
  | 'ignore_sender'
  | 'ask_later'
  | 'verify_fact'
  | 'reject_fact';

export type ReviewRecordKind =
  | 'areaArtifactLink'
  | 'verifiedFact'
  | 'rejectedFact'
  | 'senderRule'
  | 'candidateArea'
  | 'deferred';

export interface ReviewDecisionEffect {
  action: ReviewActionKind;
  label: string;
  /** What the decision does right now, in plain language. */
  effect: string;
  /** How future classification changes (empty for ask_later). */
  goingForward: string;
  recordKind: ReviewRecordKind;
  /** The area this decision routes to, when applicable. */
  targetAreaId?: string;
  targetAreaName?: string;
  /** Whether this writes durable context (false for ask_later). */
  persistsContext: boolean;
  danger?: boolean;
}

const REVIEW_ACTION_META: Record<ReviewActionKind, { label: string; danger?: boolean }> = {
  assign_area: { label: 'Assign to area' },
  create_area: { label: 'Create new area' },
  mark_noise: { label: 'Mark as noise' },
  ignore_sender: { label: 'Ignore sender' },
  ask_later: { label: 'Ask later' },
  verify_fact: { label: 'Verify fact' },
  reject_fact: { label: 'Reject fact', danger: true },
};

function senderOf(item: ContextReviewItem): string | null {
  if (item.artifactKind !== 'mailThread') return null;
  const thread = threadById.get(item.artifactId);
  return thread ? thread.from : null;
}

/**
 * Project a triage action onto its read-model effect. Pure: returns the
 * change that *would* happen so the UI can show it before the user commits.
 */
export function applyReviewDecision(
  item: ContextReviewItem,
  action: ReviewActionKind,
  targetAreaId?: string,
): ReviewDecisionEffect {
  const meta = REVIEW_ACTION_META[action];
  const artifact = resolveArtifact(item.artifactKind, item.artifactId);
  const sender = senderOf(item);
  const domain = emailDomain(sender ?? undefined);
  const fallbackAreaId = targetAreaId ?? item.candidateAreaIds?.[0];
  const areaLabel = fallbackAreaId ? areaName(fallbackAreaId) : 'the area';

  switch (action) {
    case 'assign_area':
      return {
        action,
        label: meta.label,
        effect: `Links "${artifact.title}" to ${areaLabel} as a verified assignment.`,
        goingForward: `Similar ${sender ? `mail from ${sender}` : 'items'} will be proposed for ${areaLabel}.`,
        recordKind: 'areaArtifactLink',
        targetAreaId: fallbackAreaId,
        targetAreaName: fallbackAreaId ? areaName(fallbackAreaId) : undefined,
        persistsContext: true,
      };
    case 'create_area':
      return {
        action,
        label: meta.label,
        effect: `Creates ${areaLabel === 'the area' ? 'a new area' : areaLabel} and assigns "${artifact.title}" to it.`,
        goingForward: `New mail like this starts a thread of context in ${areaLabel === 'the area' ? 'the new area' : areaLabel}.`,
        recordKind: 'candidateArea',
        targetAreaId: fallbackAreaId,
        targetAreaName: fallbackAreaId ? areaName(fallbackAreaId) : undefined,
        persistsContext: true,
      };
    case 'mark_noise':
      return {
        action,
        label: meta.label,
        effect: `Marks "${artifact.title}" as noise and removes it from area routing.`,
        goingForward: domain
          ? `Mail from ${domain} stays out of areas unless you say otherwise.`
          : 'Items like this stay out of areas going forward.',
        recordKind: 'senderRule',
        persistsContext: true,
      };
    case 'ignore_sender':
      return {
        action,
        label: meta.label,
        effect: domain
          ? `Adds a rule to ignore ${domain} for context.`
          : 'Adds a rule to ignore this sender for context.',
        goingForward: domain
          ? `Future mail from ${domain} is skipped during classification.`
          : 'Future mail from this sender is skipped during classification.',
        recordKind: 'senderRule',
        persistsContext: true,
      };
    case 'verify_fact':
      return {
        action,
        label: meta.label,
        effect: `Confirms the candidate fact${item.candidateFactIds?.length ? '' : ''} as verified context for ${areaLabel}.`,
        goingForward: `${areaLabel} treats this as known context - but only because you confirmed it.`,
        recordKind: 'verifiedFact',
        targetAreaId: fallbackAreaId,
        targetAreaName: fallbackAreaId ? areaName(fallbackAreaId) : undefined,
        persistsContext: true,
      };
    case 'reject_fact':
      return {
        action,
        label: meta.label,
        effect: 'Rejects the candidate fact so it is never used as context.',
        goingForward: 'This claim will not influence classification.',
        recordKind: 'rejectedFact',
        persistsContext: true,
        danger: true,
      };
    default:
      return {
        action: 'ask_later',
        label: meta.label,
        effect: 'Keeps this in the queue without changing any context.',
        goingForward: '',
        recordKind: 'deferred',
        persistsContext: false,
      };
  }
}

/** All projected effects for a review item's suggested actions. */
export function reviewDecisionOptions(item: ContextReviewItem): ReviewDecisionEffect[] {
  const actions = item.suggestedActions.filter(
    (action): action is ReviewActionKind => action in REVIEW_ACTION_META,
  );
  return actions.map((action) => applyReviewDecision(item, action));
}

/* ================================================================== */
/* Issue #76 - Intent capture                                          */
/* ------------------------------------------------------------------ */
/* A raw thought, dumped fast (text or voice), saved immediately as an */
/* intent record. One intent per capture by default; if the dump looks */
/* like several things, the UI asks before splitting.                  */

export const INTENT_CAPTURE_LABELS = [
  'New Intent',
  'New Idea',
  'New Procrastination',
  'Make This Real',
  'Unload Thought',
] as const;

/** Deterministic label rotation (no randomness, so it stays test-stable). */
export function pickIntentCaptureLabel(index: number): string {
  const labels = INTENT_CAPTURE_LABELS;
  return labels[((index % labels.length) + labels.length) % labels.length];
}

/**
 * Split a raw dump into candidate intents. Conservative: only splits on
 * strong separators (new lines, numbered/bulleted lists, " and then ",
 * semicolons). Returns the original text as a single item when nothing
 * clearly separates it.
 */
export function splitIntentText(text: string): string[] {
  const normalized = text.replace(/\r/g, '');
  const pieces = normalized
    .split(/\n+|\s*;\s*|\s+and then\s+|^\s*\d+[.)]\s+|\s*[\u2022\-*]\s+/gim)
    .map((piece) => piece.trim().replace(/^and then\s+/i, ''))
    .filter((piece) => piece.length >= 3);
  if (pieces.length <= 1) return [text.trim()].filter(Boolean);
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const unique = pieces.filter((piece) => {
    const key = piece.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique;
}

export function looksLikeMultipleIntents(text: string): boolean {
  return splitIntentText(text).length > 1;
}

export interface CapturedIntent extends Intent {
  /** Marks an intent created locally in this session (no false persistence). */
  captured: true;
}

/** Build an intent record from a raw capture. Status stays "captured" - it is
 *  held as raw context, not yet classified or planned. */
export function createCapturedIntent(
  text: string,
  source: 'text' | 'voice',
  id: string,
  capturedAt: string,
): CapturedIntent {
  return {
    id,
    rawInput: text.trim(),
    source,
    capturedAt,
    classification: 'capture',
    status: 'captured',
    likelyAreaId: '',
    assumptions: [],
    questions: [],
    captured: true,
  };
}

/* ================================================================== */
/* Issues #77-#80 - Intent parsing, context packs, and draft plans      */
/* ------------------------------------------------------------------ */
/* Raw intent text is converted into a provisional object only after    */
/* checking area-aware context. The generator never executes work and   */
/* never promotes candidate facts; it returns a grounded draft object   */
/* the UI can inspect, correct, and eventually apply in a later issue.  */

export type ParsedIntentKind =
  | 'task'
  | 'project'
  | 'idea'
  | 'obligation'
  | 'errand'
  | 'habit'
  | 'relationship'
  | 'area_setup'
  | 'replan';

export type ProjectNeed = 'task_only' | 'project' | 'unknown' | 'context_update';
export type ContextItemKind = ArtifactKind | 'areaFact' | 'task' | 'project';

export interface IntentContextItem {
  id: string;
  kind: ContextItemKind;
  title: string;
  detail: string;
  areaId?: string;
  status: FactStatus | AssignmentStatus;
  confidence: number;
  reason: string;
  sourceRefs: SourceRef[];
}

export interface IntentContextPack {
  query: string;
  likelyAreaId: string;
  verified: IntentContextItem[];
  candidate: IntentContextItem[];
  contradictions: IntentContextItem[];
  sourceRefs: SourceRef[];
  questions: IntentQuestion[];
  noResults: boolean;
}

export interface ProposedArtifact {
  kind: 'task' | 'calendar_event' | 'project' | 'email_draft' | 'area_fact';
  title: string;
  areaId?: string;
  status: 'proposed' | 'blocked';
  detail?: string;
  sourceRefs: SourceRef[];
}

export interface GeneratedIntentPlan extends IntentPlan {
  questions: IntentQuestion[];
  proposedArtifacts: ProposedArtifact[];
  projectNeed: ProjectNeed;
  readyToApply: boolean;
  officialSourceRefs: SourceRef[];
}

export interface ParsedIntent {
  intent: Intent;
  classification: ParsedIntentKind;
  likelyAreaId: string;
  projectNeed: ProjectNeed;
  contextPack: IntentContextPack;
  plan: GeneratedIntentPlan;
  candidateFactIds: string[];
}

const OFFICIAL_SOURCE_REFS = {
  taxes: [
    {
      kind: 'official',
      id: 'irs_when_to_file',
      label: 'IRS: When to file',
      url: 'https://www.irs.gov/filing/individuals/when-to-file',
    },
    {
      kind: 'official',
      id: 'irs_how_to_file',
      label: 'IRS: File your tax return',
      url: 'https://www.irs.gov/filing/individuals/how-to-file',
    },
  ],
  passport: [
    {
      kind: 'official',
      id: 'state_passport_renew_by_mail',
      label: 'State Dept: Renew by mail',
      url: 'https://travel.state.gov/en/passports/renew-replace/mail.html',
    },
    {
      kind: 'official',
      id: 'state_passport_forms',
      label: 'State Dept: Passport forms',
      url: 'https://travel.state.gov/content/travel/en/passports/how-apply/forms.html',
    },
    {
      kind: 'official',
      id: 'state_passport_renew_online',
      label: 'State Dept: Renew online',
      url: 'https://travel.state.gov/content/travel/en/passports/have-passport/renew-online.html',
    },
  ],
} satisfies Record<string, SourceRef[]>;

function intentText(input: Intent | string): string {
  return typeof input === 'string' ? input : input.rawInput;
}

function sourceRef(kind: string, id: string, label: string, url?: string): SourceRef {
  return url ? { kind, id, label, url } : { kind, id, label };
}

function containsAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function createQuestion(
  id: string,
  text: string,
  kind: IntentQuestion['kind'],
  choices?: string[],
): IntentQuestion {
  return choices ? { id, text, kind, choices } : { id, text, kind };
}

function sourceRefsForContextItem(kind: ContextItemKind, id: string, title: string): SourceRef[] {
  if (kind === 'areaFact') {
    const fact = factById.get(id);
    return fact?.sourceRefs.length ? fact.sourceRefs : [sourceRef('areaFact', id, title)];
  }
  return [sourceRef(kind, id, title)];
}

function contextItem(
  kind: ContextItemKind,
  id: string,
  title: string,
  detail: string,
  options: {
    areaId?: string;
    status?: FactStatus | AssignmentStatus;
    confidence?: number;
    reason: string;
    sourceRefs?: SourceRef[];
  },
): IntentContextItem {
  return {
    id,
    kind,
    title,
    detail,
    areaId: options.areaId,
    status: options.status ?? 'candidate',
    confidence: Math.round((options.confidence ?? 0.5) * 100) / 100,
    reason: options.reason,
    sourceRefs: options.sourceRefs ?? sourceRefsForContextItem(kind, id, title),
  };
}

function scoreTextMatch(queryTokens: Set<string>, text: string): number {
  const textTokens = tokenize(text);
  if (!queryTokens.size || !textTokens.size) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(2, queryTokens.size);
}

function bestAreaFromText(text: string): string {
  const lower = text.toLowerCase();
  if (containsAny(lower, ['tax', 'irs', '1099', 'w-2', 'w2', 'brokerage', 'deduction'])) return 'area_money';
  if (containsAny(lower, ['passport', 'visa', 'flight', 'trip', 'travel document'])) return 'area_trip';
  if (containsAny(lower, ['cardhunt', 'andrew', 'buyer onboarding'])) return 'area_cardhunt';
  if (containsAny(lower, ['banjo', 'music', 'guitar', 'practice tracks'])) return 'area_music';
  if (containsAny(lower, ['woke up', 'cooked', 'replan', 'schedule', 'calendar'])) return 'area_schedule';
  for (const area of areas) {
    if (tokenize(area.name).size && [...tokenize(area.name)].some((token) => tokenize(text).has(token))) {
      return area.id;
    }
  }
  return '';
}

function intentKindFor(text: string, likelyAreaId: string): ParsedIntentKind {
  const lower = text.toLowerCase();
  if (containsAny(lower, ['started a new job', 'manager is', 'new job at', 'work is buyer onboarding'])) {
    return 'area_setup';
  }
  if (containsAny(lower, ['woke up', 'day is already cooked', 'replan', 'salvage'])) return 'replan';
  if (containsAny(lower, ['tax', 'passport', 'deadline', 'need to file', 'renew', 'appointment'])) {
    return 'obligation';
  }
  if (containsAny(lower, ['learn', 'practice', 'habit']) || likelyAreaId === 'area_music') return 'habit';
  if (containsAny(lower, ['idea', 'maybe', 'someday'])) return 'idea';
  if (containsAny(lower, ['project', 'launch', 'build'])) return 'project';
  if (containsAny(lower, ['call', 'email', 'ask', 'reply'])) return 'task';
  return 'task';
}

function projectNeedFor(kind: ParsedIntentKind, text: string): ProjectNeed {
  const lower = text.toLowerCase();
  if (kind === 'area_setup') return 'context_update';
  if (kind === 'habit') return 'task_only';
  if (kind === 'replan') return 'task_only';
  if (kind === 'obligation' && containsAny(lower, ['passport'])) return 'unknown';
  if (kind === 'obligation' && containsAny(lower, ['tax'])) return 'project';
  if (kind === 'project' || containsAny(lower, ['make it real', 'launch', 'build'])) return 'project';
  return 'unknown';
}

function officialRefsForIntent(text: string): SourceRef[] {
  const refs: SourceRef[] = [];
  if (containsAny(text, ['tax', 'irs', '1099', 'w-2', 'w2'])) refs.push(...OFFICIAL_SOURCE_REFS.taxes);
  if (containsAny(text, ['passport'])) refs.push(...OFFICIAL_SOURCE_REFS.passport);
  return refs;
}

function questionsForIntent(
  kind: ParsedIntentKind,
  text: string,
  contextPack: IntentContextPack,
): IntentQuestion[] {
  const lower = text.toLowerCase();
  const questions: IntentQuestion[] = [];
  if (kind === 'area_setup') {
    if (containsAny(lower, ['andrew', 'manager'])) {
      questions.push(
        createQuestion('q_confirm_andrew', 'Should I store Andrew as your CardHunt manager?', 'confirm'),
      );
    }
    questions.push(
      createQuestion(
        'q_cardhunt_responsibility',
        'What CardHunt responsibility should this context support?',
        'choice',
        ['buyer onboarding', 'launch risk', 'sales demo prep', 'not sure'],
      ),
    );
  } else if (containsAny(lower, ['tax', 'irs', '1099', 'w-2', 'w2'])) {
    questions.push(
      createQuestion('q_tax_year', 'Which tax year are you trying to file?', 'short_text'),
      createQuestion('q_tax_progress', 'What is already done?', 'choice', [
        'nothing',
        'documents gathered',
        'return drafted',
        'extension filed',
        'not sure',
      ]),
      createQuestion('q_tax_remaining', 'What do you already know is missing?', 'short_text'),
    );
  } else if (containsAny(lower, ['passport'])) {
    questions.push(
      createQuestion('q_passport_goal', 'What do you need to do with your passport?', 'choice', [
        'renew',
        'apply first time',
        'find it',
        'check expiration',
        'replace lost passport',
        'not sure',
      ]),
      createQuestion('q_passport_trip', 'Is this tied to a specific trip or deadline?', 'short_text'),
      createQuestion('q_passport_have_it', 'Do you currently have the passport in hand?', 'confirm'),
    );
  } else if (kind === 'habit') {
    questions.push(
      createQuestion('q_habit_frequency', 'How often should this happen?', 'choice', [
        'daily',
        'weekdays',
        'two or three times a week',
        'weekly',
      ]),
    );
  } else if (kind === 'replan') {
    questions.push(
      createQuestion('q_energy', 'How much energy do you have left today?', 'choice', [
        'low',
        'medium',
        'surprisingly fine',
      ]),
    );
  } else if (contextPack.noResults) {
    questions.push(createQuestion('q_intent_outcome', 'What outcome should this create?', 'short_text'));
  }

  for (const contradiction of contextPack.contradictions) {
    questions.push(
      createQuestion(
        `q_contradiction_${contradiction.id}`,
        `Earlier context says "${contradiction.title}" was rejected. Should I ignore that here?`,
        'confirm',
      ),
    );
  }

  const seen = new Set<string>();
  return questions.filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  });
}

function intentStatusFor(kind: ParsedIntentKind, questions: IntentQuestion[]): string {
  if (kind === 'area_setup') return 'needs_confirmation';
  return questions.length ? 'needs_questions' : 'draft_plan_ready';
}

function intentAssumptions(kind: ParsedIntentKind, text: string, contextPack: IntentContextPack): string[] {
  const lower = text.toLowerCase();
  const assumptions: string[] = [];
  if (kind === 'area_setup') assumptions.push('This updates area context before creating task cards.');
  if (containsAny(lower, ['tax'])) {
    assumptions.push(
      'April 15 may be the relevant deadline, but the filing year and route need confirmation.',
    );
  }
  if (kind === 'habit') assumptions.push('Keep this lightweight unless the user asks for a full project.');
  if (kind === 'replan') assumptions.push('Move or defer commitments only after explicit approval.');
  if (contextPack.candidate.length) {
    assumptions.push('Candidate context is available but not treated as verified.');
  }
  return assumptions;
}

function collectCandidateFactIds(contextPack: IntentContextPack): string[] {
  return contextPack.candidate
    .filter((item) => item.kind === 'areaFact')
    .map((item) => item.id)
    .filter((id, index, all) => all.indexOf(id) === index);
}

/** Compact, area-aware context search for one intent. */
export function buildIntentContextPack(input: Intent | string): IntentContextPack {
  const query = intentText(input).trim();
  const likelyAreaId = (typeof input === 'string' ? '' : input.likelyAreaId) || bestAreaFromText(query);
  const queryTokens = tokenize(query);
  const verified: IntentContextItem[] = [];
  const candidate: IntentContextItem[] = [];
  const contradictions: IntentContextItem[] = [];

  const addItem = (item: IntentContextItem) => {
    const bucket =
      item.status === 'rejected' ? contradictions : item.status === 'verified' ? verified : candidate;
    if (!bucket.some((existing) => existing.kind === item.kind && existing.id === item.id)) bucket.push(item);
  };

  for (const fact of areaFacts) {
    const area = areaById.get(fact.areaId);
    const score =
      scoreTextMatch(queryTokens, `${area?.name ?? ''} ${fact.kind} ${fact.value}`) +
      (likelyAreaId && fact.areaId === likelyAreaId ? 0.35 : 0);
    if (score <= 0 && !containsAny(query, ['passport', 'tax', 'cardhunt', 'banjo'])) continue;
    if (score >= 0.28 || fact.areaId === likelyAreaId) {
      addItem(
        contextItem(
          'areaFact',
          fact.id,
          fact.value,
          `${areaName(fact.areaId)} / ${titleCaseLocal(fact.kind)}`,
          {
            areaId: fact.areaId,
            status: fact.status,
            confidence:
              fact.status === 'verified' ? Math.min(0.95, 0.62 + score) : Math.min(0.82, 0.48 + score),
            reason:
              fact.status === 'verified'
                ? 'Verified area fact matched the intent or likely area.'
                : fact.status === 'rejected'
                  ? 'Previously rejected context matched this intent.'
                  : 'Candidate area fact matched; use only as a question or assumption.',
            sourceRefs: fact.sourceRefs,
          },
        ),
      );
    }
  }

  for (const thread of mailThreads) {
    const classification = classifyThread(thread.id);
    const primary = classification?.primary;
    const score =
      scoreTextMatch(queryTokens, `${thread.subject} ${thread.snippet} ${thread.from}`) +
      (likelyAreaId && primary?.areaId === likelyAreaId ? 0.25 : 0);
    if (score >= 0.28 || (likelyAreaId === 'area_trip' && containsAny(thread.subject, ['passport']))) {
      addItem(
        contextItem(
          'mailThread',
          thread.id,
          thread.subject,
          `${thread.from} / ${fmtLensDate(thread.lastDate)}`,
          {
            areaId: primary?.areaId,
            status: primary?.status ?? 'candidate',
            confidence: Math.min(0.9, Math.max(primary?.confidence ?? 0.45, 0.42 + score)),
            reason: primary?.reason ?? 'Text matched the captured intent.',
          },
        ),
      );
    }
  }

  for (const event of calendarEvents) {
    const score =
      scoreTextMatch(queryTokens, `${event.title} ${event.attendees.join(' ')}`) +
      (likelyAreaId && event.areaId === likelyAreaId ? 0.25 : 0);
    if (score >= 0.28) {
      addItem(
        contextItem('calendarEvent', event.id, event.title, `${fmtLensDate(event.startsAt)} calendar event`, {
          areaId: event.areaId,
          status: event.areaId ? 'verified' : 'candidate',
          confidence: event.areaId ? Math.min(0.9, 0.55 + score) : Math.min(0.7, 0.38 + score),
          reason: event.areaId
            ? 'Calendar event is already linked to the likely area.'
            : 'Event text matched.',
        }),
      );
    }
  }

  for (const item of mcpItems) {
    const score =
      scoreTextMatch(queryTokens, `${item.title} ${item.provider} ${item.kind} ${item.url}`) +
      (likelyAreaId && item.areaId === likelyAreaId ? 0.25 : 0);
    if (score >= 0.28) {
      addItem(
        contextItem('mcpItem', item.id, item.title, `${item.provider} / ${item.kind}`, {
          areaId: item.areaId,
          status: item.areaId ? 'verified' : 'candidate',
          confidence: item.areaId ? Math.min(0.9, 0.55 + score) : Math.min(0.7, 0.38 + score),
          reason: item.areaId
            ? 'Integration item is linked to the likely area.'
            : 'Integration title matched.',
        }),
      );
    }
  }

  for (const task of tasks) {
    const score =
      scoreTextMatch(queryTokens, task.title) + (likelyAreaId && task.areaId === likelyAreaId ? 0.16 : 0);
    if (score >= 0.32) {
      addItem(
        contextItem('task', task.id, task.title, titleCaseLocal(task.status), {
          areaId: task.areaId,
          status: task.areaId ? 'verified' : 'candidate',
          confidence: Math.min(0.8, 0.42 + score),
          reason: 'Existing task overlaps with the intent.',
          sourceRefs: task.sourceRefs,
        }),
      );
    }
  }

  for (const project of projects) {
    const score =
      scoreTextMatch(queryTokens, `${project.title ?? ''} ${project.outcome ?? ''}`) +
      (likelyAreaId && project.areaId === likelyAreaId ? 0.16 : 0);
    if (score >= 0.32) {
      addItem(
        contextItem('project', project.id, project.title ?? project.id, project.outcome ?? 'Project', {
          areaId: project.areaId,
          status: project.status === 'done' ? 'verified' : 'candidate',
          confidence: Math.min(0.78, 0.42 + score),
          reason: 'Existing project overlaps with the intent.',
        }),
      );
    }
  }

  for (const previous of intents) {
    if (typeof input !== 'string' && previous.id === input.id) continue;
    const score = scoreTextMatch(queryTokens, previous.rawInput);
    if (score >= 0.45) {
      addItem(
        contextItem('intent', previous.id, previous.rawInput, titleCaseLocal(previous.classification), {
          areaId: previous.likelyAreaId,
          status: previous.status === 'draft_plan_ready' ? 'verified' : 'candidate',
          confidence: Math.min(0.78, 0.36 + score),
          reason: 'Previous intent overlaps with this capture.',
        }),
      );
    }
  }

  verified.sort((a, b) => b.confidence - a.confidence);
  candidate.sort((a, b) => b.confidence - a.confidence);
  contradictions.sort((a, b) => b.confidence - a.confidence);

  const sourceRefs = [...verified, ...candidate, ...contradictions]
    .flatMap((item) =>
      item.sourceRefs.length ? item.sourceRefs : [sourceRef(item.kind, item.id, item.title)],
    )
    .filter((ref, index, refs) => refs.findIndex((candidateRef) => candidateRef.id === ref.id) === index)
    .slice(0, 8);

  return {
    query,
    likelyAreaId,
    verified: verified.slice(0, 6),
    candidate: candidate.slice(0, 6),
    contradictions: contradictions.slice(0, 4),
    sourceRefs,
    questions: [],
    noResults: verified.length === 0 && candidate.length === 0 && contradictions.length === 0,
  };
}

function buildStructuredIntent(
  input: Intent | string,
  contextPack: IntentContextPack,
  kind: ParsedIntentKind,
  questions: IntentQuestion[],
  assumptions: string[],
): Intent {
  if (typeof input !== 'string') {
    return {
      ...input,
      classification: kind,
      status: intentStatusFor(kind, questions),
      likelyAreaId: contextPack.likelyAreaId,
      assumptions,
      questions,
      candidateFactIds: collectCandidateFactIds(contextPack),
    };
  }
  const id = `intent_parsed_${slugifyLocal(input).slice(0, 32) || 'capture'}`;
  return {
    id,
    rawInput: input.trim(),
    source: 'text',
    capturedAt: new Date('2026-06-30T12:00:00.000-04:00').toISOString(),
    classification: kind,
    status: intentStatusFor(kind, questions),
    likelyAreaId: contextPack.likelyAreaId,
    assumptions,
    questions,
    candidateFactIds: collectCandidateFactIds(contextPack),
  };
}

function officialAndContextRefs(text: string, contextPack: IntentContextPack): SourceRef[] {
  const refs = [...contextPack.sourceRefs, ...officialRefsForIntent(text)];
  return refs.filter((ref, index) => refs.findIndex((candidateRef) => candidateRef.id === ref.id) === index);
}

function proposedArtifact(
  kind: ProposedArtifact['kind'],
  title: string,
  areaId: string | undefined,
  detail: string,
  sourceRefs: SourceRef[],
  status: ProposedArtifact['status'] = 'proposed',
): ProposedArtifact {
  return { kind, title, areaId, detail, sourceRefs, status };
}

export function generateGroundedIntentPlan(
  intent: Intent,
  contextPack: IntentContextPack = buildIntentContextPack(intent),
  projectNeed: ProjectNeed = projectNeedFor(intent.classification as ParsedIntentKind, intent.rawInput),
): GeneratedIntentPlan {
  const text = intent.rawInput.toLowerCase();
  const refs = officialAndContextRefs(text, contextPack);
  const officialSourceRefs = officialRefsForIntent(text);
  const questions = intent.questions;
  const areaId = intent.likelyAreaId || contextPack.likelyAreaId;
  const proposedArtifacts: ProposedArtifact[] = [];
  const digitalActions: DigitalAction[] = [];
  const physicalActions: string[] = [];
  let status = questions.length ? 'blocked_on_questions' : 'draft';
  let outcome = 'Turn the raw intent into a concrete next action without applying anything yet.';
  let readyToApply = questions.length === 0;

  if (intent.classification === 'area_setup') {
    status = 'blocked_on_questions';
    outcome = `Confirm the CardHunt context that should be remembered before creating tasks.`;
    readyToApply = false;
    const verifiedFacts = contextPack.verified.filter((item) => item.areaId === 'area_cardhunt');
    for (const fact of verifiedFacts.filter((item) => item.kind === 'areaFact').slice(0, 2)) {
      proposedArtifacts.push(
        proposedArtifact(
          'area_fact',
          fact.title,
          fact.areaId,
          'Already verified CardHunt context.',
          fact.sourceRefs,
        ),
      );
    }
    if (containsAny(text, ['andrew', 'manager'])) {
      proposedArtifacts.push(
        proposedArtifact(
          'area_fact',
          'Andrew may be your CardHunt manager',
          'area_cardhunt',
          'Candidate relationship; requires confirmation before becoming a fact.',
          refs,
          'blocked',
        ),
      );
      digitalActions.push({
        kind: 'email_draft',
        title: 'Draft a short context-check note for Andrew',
        areaId: 'area_cardhunt',
        priority: 2,
      });
      proposedArtifacts.push(
        proposedArtifact(
          'email_draft',
          'Ask Andrew what buyer onboarding success should look like',
          'area_cardhunt',
          'Draft only; nothing sends without approval.',
          refs,
          'blocked',
        ),
      );
    }
  } else if (containsAny(text, ['tax', 'irs', '1099', 'w-2', 'w2'])) {
    status = 'draft';
    readyToApply = false;
    outcome = 'Know what remains for taxes, confirm the filing route, and schedule the next work block.';
    digitalActions.push(
      { kind: 'task', title: 'List missing tax documents', areaId: 'area_money', priority: 1 },
      {
        kind: 'calendar_event',
        title: 'Tax document cleanup',
        durationMinutes: 90,
        areaId: 'area_money',
      },
    );
    physicalActions.push(
      "Find last year's return.",
      'Collect W-2, 1099, bank, brokerage, and donation records.',
    );
    proposedArtifacts.push(
      proposedArtifact(
        'project',
        'Tax filing cleanup',
        'area_money',
        'Project only if multiple sessions remain.',
        refs,
      ),
      proposedArtifact('task', 'List missing tax documents', 'area_money', 'First bounded task.', refs),
      proposedArtifact('calendar_event', 'Tax document cleanup', 'area_money', '90 minute draft hold.', refs),
    );
  } else if (containsAny(text, ['passport'])) {
    status = 'blocked_on_questions';
    readyToApply = false;
    outcome = 'Determine the passport route before creating tasks, calendar blocks, or assumptions.';
    proposedArtifacts.push(
      proposedArtifact(
        'project',
        'Passport route clarification',
        'area_trip',
        'Blocked until the user says renew, first-time apply, find, check expiration, or replace.',
        refs,
        'blocked',
      ),
    );
  } else if (intent.classification === 'habit') {
    status = questions.length ? 'blocked_on_questions' : 'draft';
    readyToApply = questions.length === 0;
    outcome = 'Make the habit real with the smallest repeatable commitment.';
    digitalActions.push({
      kind: 'task',
      title: containsAny(text, ['banjo'])
        ? 'Do first 20 minute banjo practice'
        : 'Do the first practice block',
      areaId,
      priority: 3,
      durationMinutes: 20,
    });
    proposedArtifacts.push(
      proposedArtifact(
        'task',
        containsAny(text, ['banjo']) ? 'Do first 20 minute banjo practice' : 'Do the first practice block',
        areaId,
        'Task-only by default; no large project unless corrected.',
        refs,
      ),
    );
  } else if (intent.classification === 'replan') {
    status = 'draft';
    readyToApply = false;
    outcome = 'Recover the rest of the day without pretending the missed morning did not happen.';
    digitalActions.push(
      { kind: 'calendar_event', title: 'Protect one realistic focus block', durationMinutes: 45, areaId },
      { kind: 'task', title: 'Defer nonessential inbox cleanup', areaId, priority: 2 },
    );
    physicalActions.push(
      'Eat something before opening the highest-pressure thread.',
      'Put the phone away for the focus block.',
    );
    proposedArtifacts.push(
      proposedArtifact(
        'calendar_event',
        'Protect one realistic focus block',
        areaId,
        'Draft hold only.',
        refs,
      ),
      proposedArtifact(
        'task',
        'Defer nonessential inbox cleanup',
        areaId,
        'Requires approval if it moves commitments.',
        refs,
      ),
    );
  } else {
    status = questions.length ? 'blocked_on_questions' : 'draft';
    readyToApply = questions.length === 0;
    proposedArtifacts.push(
      proposedArtifact(
        'task',
        'Clarify the next action',
        areaId,
        'Default task draft until corrected.',
        refs,
      ),
    );
  }

  return {
    id: `plan_${intent.id}`,
    intentId: intent.id,
    status,
    outcome,
    digitalActions,
    physicalActions,
    sourceRefs: refs,
    assumptions: intent.assumptions,
    questions,
    proposedArtifacts,
    projectNeed,
    readyToApply,
    officialSourceRefs,
  };
}

/** Parse raw or seeded intent text into a provisional object plus draft plan. */
export function parseIntent(input: Intent | string): ParsedIntent {
  const contextPack = buildIntentContextPack(input);
  const text = intentText(input);
  const classification = intentKindFor(text, contextPack.likelyAreaId);
  const projectNeed = projectNeedFor(classification, text);
  const questions = questionsForIntent(classification, text, contextPack);
  const contextWithQuestions = { ...contextPack, questions } satisfies IntentContextPack;
  const assumptions = intentAssumptions(classification, text, contextWithQuestions);
  const intent = buildStructuredIntent(input, contextWithQuestions, classification, questions, assumptions);
  const plan = generateGroundedIntentPlan(intent, contextWithQuestions, projectNeed);

  return {
    intent,
    classification,
    likelyAreaId: intent.likelyAreaId,
    projectNeed,
    contextPack: contextWithQuestions,
    plan,
    candidateFactIds: collectCandidateFactIds(contextWithQuestions),
  };
}
