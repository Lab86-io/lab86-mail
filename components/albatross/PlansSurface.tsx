'use client';

// Research (Albatross contract - research before code):
// - Mobbin/Lightfield cascade (5b5f4b9f): generated artifacts stagger in beneath the source.
// - Mobbin/Grok Tasks (83c6a6f4): created items as flat dense cards -> applied checklist tone.
// - Mobbin/Cosmos (e5adf3d5), Indeed (ace777b6), Juicebox (04c29067): one-question-at-a-time
//   with big prompt, single input, "n of m" progress, quiet skip.
// - Mobbin/Turo web search (16067ed9): selectable result cards synced to a live map panel on
//   the right -> option cards + inline map column pairing.
// - Mobbin/Vercel marketplace (fc8114d7): "We found some options" AI-suggested choice cards
//   with one affirm action -> option card + "Use this one" pattern.
// - motion.dev/docs/react-animation: stagger via per-child delays derived from
//   planRevealSequence indexes (deterministic, testable); useReducedMotion -> fade-only.
// - Mobbin/Things 3 Today (235f4304), Amie done divider (8651d9b8): identity left,
//   metadata right, done = filled mark + faded title -> the hover rail rows.
// - Mobbin/Transit trip timeline (56fe42c4), BlaBlaCar stops (1903ead2): time bands
//   with connectors -> the dossier's temporal-module standard (see intent-plan.ts).
// - Dia browser reports (Refero teardown of diabrowser.com): editorial masthead,
//   condensed display type, whitespace as structure -> the plan dossier craft bar.

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  Hourglass,
  Link2,
  type LucideIcon,
  MessageCircleQuestion,
  Mic,
  PanelLeft,
  TriangleAlert,
  Type,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextVortex, type VortexSource } from '@/components/albatross/ContextVortex';
import { ChamaacDock, ChamaacDockTile } from '@/components/ui/chamaac-dock';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import {
  intentInitials,
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  railExpandTransition,
  railLabelMotion,
  railTileLabel,
} from '@/lib/albatross/intent-rail';
import {
  type AppliedPlanStep,
  injectPlanArtifactRuntime,
  type PlanStepState,
  parseToggleStepMessage,
  type StepCardState,
  stepStatesForArtifact,
  toggleStepDecision,
} from '@/lib/albatross/plan-artifact-runtime';
import { useClientStore } from '@/lib/client-state';
import { postBriefTheme } from '@/lib/theme/brief-theme';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Pure types + helpers (exported for bun:test - no DOM, no hooks)
// ---------------------------------------------------------------------------

export type IntentStatus =
  | 'captured'
  | 'planning'
  | 'needs_answers'
  | 'ready'
  | 'applied'
  | 'done'
  | 'archived';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

// A choosable answer for a question - usually a real nearby place found on
// the web during planning. Free-text answering stays available alongside.
export interface QuestionOption {
  id: string;
  title: string;
  detail?: string;
  address?: string;
  hoursText?: string;
  website?: string;
}

export interface IntentQuestion {
  id: string;
  prompt: string;
  options?: QuestionOption[];
  answer?: string;
  answeredOptionId?: string;
  answeredAt?: number;
}

export interface DigitalActionLike {
  kind: string;
  title: string;
  description?: string;
  priority?: number;
  startIso?: string;
  to?: string;
  subject?: string;
  body?: string;
}

export interface PlanLike {
  status: 'draft' | 'needs_answers' | 'ready' | 'applied' | 'superseded';
  outcome?: string;
  summary?: string;
  digitalActions?: DigitalActionLike[];
  physicalActions?: { title: string; detail?: string; url?: string }[];
  assumptions?: string[];
  sourceRefs?: { kind: string; id: string; label?: string; url?: string }[];
  artifactHtml?: string;
  mapQuery?: string;
}

export interface IntentLike {
  status: IntentStatus;
  rawText?: string;
  title?: string;
  questions?: IntentQuestion[];
  planError?: string;
}

export interface IntentStatusMeta {
  label: string;
  tone: Tone;
  icon: string;
  pulse: boolean;
}

const STATUS_META: Record<IntentStatus, IntentStatusMeta> = {
  captured: { label: 'Captured', tone: 'neutral', icon: 'circle-dot', pulse: false },
  planning: { label: 'Planning', tone: 'accent', icon: 'hourglass', pulse: true },
  needs_answers: { label: 'Needs you', tone: 'warning', icon: 'message-circle-question', pulse: false },
  ready: { label: 'Ready', tone: 'accent', icon: 'list-checks', pulse: false },
  applied: { label: 'Applied', tone: 'success', icon: 'check-circle', pulse: false },
  done: { label: 'Done', tone: 'success', icon: 'check', pulse: false },
  archived: { label: 'Archived', tone: 'neutral', icon: 'archive', pulse: false },
};

export function intentStatusMeta(status: string): IntentStatusMeta {
  return STATUS_META[status as IntentStatus] ?? STATUS_META.captured;
}

export type RevealItemKind = 'outcome' | 'action' | 'physical' | 'assumptions' | 'sources' | 'artifact';

export interface RevealItem {
  key: string;
  kind: RevealItemKind;
  action?: DigitalActionLike;
}

// Deterministic action ordering inside the reveal: tasks land first (the plan's
// backbone), then time commitments, then outbound words, then anything new.
// The map lives in its own persistent side column, not in the cascade.
const ACTION_KIND_ORDER = ['task', 'calendar_event', 'email_draft'];

export function planRevealSequence(plan: PlanLike | null | undefined): RevealItem[] {
  if (!plan) return [];
  const items: RevealItem[] = [];
  if (plan.outcome?.trim() || plan.summary?.trim()) items.push({ key: 'outcome', kind: 'outcome' });
  const rank = (kind: string) => {
    const found = ACTION_KIND_ORDER.indexOf(kind);
    return found === -1 ? ACTION_KIND_ORDER.length : found;
  };
  const actions = (plan.digitalActions ?? []).map((action, index) => ({ action, index }));
  actions.sort((a, b) => rank(a.action.kind) - rank(b.action.kind) || a.index - b.index);
  for (const { action, index } of actions) items.push({ key: `action-${index}`, kind: 'action', action });
  if (plan.physicalActions?.length) items.push({ key: 'physical', kind: 'physical' });
  if (plan.assumptions?.length) items.push({ key: 'assumptions', kind: 'assumptions' });
  if (plan.sourceRefs?.length) items.push({ key: 'sources', kind: 'sources' });
  if (plan.artifactHtml) items.push({ key: 'artifact', kind: 'artifact' });
  return items;
}

export function openQuestions(intent: IntentLike | null | undefined): IntentQuestion[] {
  return (intent?.questions ?? []).filter((question) => !question.answer);
}

export function nextUnansweredQuestion(intent: IntentLike | null | undefined): IntentQuestion | null {
  return (intent?.questions ?? []).find((question) => !question.answer) ?? null;
}

export function applyDisabledReason(
  intent: IntentLike | null | undefined,
  plan: PlanLike | null | undefined,
): string | null {
  if (!intent) return 'No intent selected.';
  if (intent.status === 'planning') return 'Albatross is still planning.';
  if (!plan) return 'No plan yet - generate one first.';
  if (plan.status === 'applied' || intent.status === 'applied') return 'Already made real.';
  if (plan.status === 'superseded') return 'This plan was replaced by a newer one.';
  if (openQuestions(intent).length > 0 || plan.status === 'needs_answers') {
    return 'Answer the open questions first.';
  }
  if (plan.status !== 'ready') return 'This plan is not ready yet.';
  return null;
}

// The artifact IS the plan view when the model composed one (daily-brief
// style, full pane). The cascade remains the fallback for artifact-less plans.
export function planStageMode(
  intent: IntentLike | null | undefined,
  plan: PlanLike | null | undefined,
): 'artifact' | 'cascade' {
  if (!intent || !plan?.artifactHtml) return 'cascade';
  if (intent.status === 'needs_answers') return 'cascade';
  const status = plan.status;
  return status === 'ready' || status === 'applied' ? 'artifact' : 'cascade';
}

// True when every question carries an answer - the signal that answering the
// last question should immediately regenerate the plan (no extra button).
export function answersReadyForRegen(intent: IntentLike | null | undefined): boolean {
  const questions = intent?.questions ?? [];
  return questions.length > 0 && questions.every((question) => Boolean(question.answer));
}

// The most recently answered option-question whose chosen option still exists.
export function chosenQuestionOption(intent: IntentLike | null | undefined): QuestionOption | null {
  const questions = intent?.questions ?? [];
  for (let i = questions.length - 1; i >= 0; i--) {
    const question = questions[i];
    if (!question.answeredOptionId || !question.options?.length) continue;
    const option = question.options.find((entry) => entry.id === question.answeredOptionId);
    if (option) return option;
  }
  return null;
}

// Every answered option-question, as receipt rows for the view-mode choice
// display ("show options, not just ask"): the chosen option plus how many
// alternatives it beat. Pure and testable.
export interface AnsweredChoice {
  prompt: string;
  option: QuestionOption;
  alternatives: number;
}

export function answeredOptionChoices(intent: IntentLike | null | undefined): AnsweredChoice[] {
  const rows: AnsweredChoice[] = [];
  for (const question of intent?.questions ?? []) {
    if (!question.answer || !question.options?.length) continue;
    const option = question.answeredOptionId
      ? question.options.find((entry) => entry.id === question.answeredOptionId)
      : undefined;
    if (!option) continue;
    rows.push({ prompt: question.prompt, option, alternatives: question.options.length - 1 });
  }
  return rows;
}

// "123 Main St"-shaped: a street number, up to four words, then a street token.
const STREET_RE =
  /\b\d{1,6}\s+(?:[\w.'-]+\s+){0,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|hwy|highway|plaza|pkwy|parkway|ct|court|sq|square)\b/i;
const MAPS_URL_RE = /(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

export function looksLikeAddress(text: string | null | undefined): boolean {
  return Boolean(text && STREET_RE.test(text));
}

// What the inline map should show: a hovered/selected option wins, then the
// answered option, then the first address-bearing physical step. Null hides
// the map column entirely.
export function mapQueryForIntent(
  intent: IntentLike | null | undefined,
  plan: PlanLike | null | undefined,
  previewOption?: QuestionOption | null,
): string | null {
  const optionQuery = (option: QuestionOption) =>
    option.address ? `${option.title}, ${option.address}` : option.title;
  if (previewOption) return optionQuery(previewOption);
  const chosen = chosenQuestionOption(intent);
  if (chosen) return optionQuery(chosen);
  if (plan?.mapQuery?.trim()) return plan.mapQuery.trim();
  for (const action of plan?.physicalActions ?? []) {
    if (looksLikeAddress(action.detail)) return `${action.title}, ${action.detail}`;
    if (action.url && MAPS_URL_RE.test(action.url)) return action.title;
  }
  return null;
}

// The vortex shows what planning actually reads: mail/calendar/tasks searched
// around the dump's words, the user's real area names, and the web when
// location is available. Pure and testable.
export function vortexSourcesForIntent(
  intent: IntentLike | null | undefined,
  areaNames: string[],
): VortexSource[] {
  const keywords = (intent?.rawText ?? '').trim().split(/\s+/).slice(0, 5).join(' ');
  const detail = keywords ? `search: ${keywords}` : undefined;
  return [
    { id: 'mail', label: 'Mail', kind: 'mail', detail },
    { id: 'calendar', label: 'Calendar', kind: 'calendar', detail },
    { id: 'tasks', label: 'Tasks', kind: 'tasks', detail: undefined },
    {
      id: 'areas',
      label: 'Areas',
      kind: 'areas',
      detail: areaNames.length ? areaNames.slice(0, 3).join(', ') : undefined,
    },
    { id: 'web', label: 'Web', kind: 'web', detail: 'places near you' },
  ];
}

// Best-effort browser location for plan generation (nearby-place research).
// Silently resolves undefined on SSR, denial, or timeout - never throws.
export function getGeo(timeoutMs = 2500): Promise<{ latitude: number; longitude: number } | undefined> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(undefined);
      return;
    }
    // A promise settles once, so the timeout and callbacks may race freely.
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        clearTimeout(timer);
        resolve({ latitude: coords.latitude, longitude: coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { timeout: timeoutMs, maximumAge: 300_000 },
    );
  });
}

export type IntentFilter = 'all' | 'needs_you' | 'ready' | 'done';

/** A 'planning' intent whose updatedAt stopped moving is likely orphaned (the
 * generation died with the process — deploys do this). The cron reconciles it
 * server-side; this powers the client's earlier "Retry" affordance. */
export function planningIsStale(updatedAt: number, nowMs: number, thresholdMs = 4 * 60_000): boolean {
  return Number.isFinite(updatedAt) && nowMs - updatedAt > thresholdMs;
}

export function intentMatchesFilter(intent: IntentLike, filter: IntentFilter): boolean {
  if (filter === 'needs_you') return intent.status === 'needs_answers' || Boolean(intent.planError);
  if (filter === 'ready') return intent.status === 'ready';
  if (filter === 'done') return intent.status === 'done' || intent.status === 'applied';
  return true;
}

export function intentDisplayTitle(intent: IntentLike): string {
  if (intent.title?.trim()) return intent.title.trim();
  const firstLine = (intent.rawText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : 'Untitled intent';
}

export function relativeTime(ts: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Data shapes as they arrive from Convex / the apply route
// ---------------------------------------------------------------------------

interface IntentRow extends IntentLike {
  _id: string;
  rawText: string;
  source: 'text' | 'voice' | 'chat' | 'import';
  latestPlanId?: string;
  createdAt: number;
  updatedAt: number;
}

interface PlanRow extends PlanLike {
  _id: string;
  appliedAt?: number;
  // stepKey -> created artifact mapping recorded at apply time (card-backed
  // steps carry the board cardId; the dossier's task cards toggle those).
  appliedSteps?: AppliedPlanStep[];
}

interface AnswerEntry {
  id: string;
  answer: string;
  answeredOptionId?: string;
}

interface ApplyResponse {
  ok: boolean;
  operationBatchId: string;
  applicationId: string;
  projectId?: string;
  operations: { operationId: string; tool: string; artifactId: string; title: string }[];
  approvals: { approvalId: string; title: string; toolName?: string }[];
  unresolved: { title?: string; blockedReason?: string }[];
  appliedSteps?: AppliedPlanStep[];
  artifactAttachedTo?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Small local atoms (reimplemented per contract - no AlbatrossSurfaces import)
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = { task: 'Task', calendar_event: 'Event', email_draft: 'Draft' };

const SOURCE_META: Record<IntentRow['source'], { label: string; icon: LucideIcon }> = {
  voice: { label: 'Voice', icon: Mic },
  text: { label: 'Text', icon: Type },
  chat: { label: 'Chat', icon: MessageCircleQuestion },
  import: { label: 'Import', icon: ArrowRight },
};

function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  if (tone === 'neutral') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)]">
        {children}
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: `var(--color-${tone})`, backgroundColor: `var(--color-${tone}-soft)` }}
    >
      {children}
    </span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'h-6 px-2 text-[11px] font-medium transition-colors',
            index > 0 && 'border-l border-[var(--color-border)]',
            value === option.value
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// Buttons stay text-only across this surface (no icons on buttons).
function PrimaryButton({
  reduced,
  disabled,
  onClick,
  children,
}: {
  reduced: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={onClick}
      whileTap={reduced || disabled ? undefined : { scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="inline-flex h-10 items-center rounded-lg bg-[var(--color-accent)] px-5 text-[14px] font-semibold text-[var(--color-accent-foreground)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
    >
      {children}
    </motion.button>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] font-medium text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function PlansSurface({ initialIntentId }: { initialIntentId?: string | null }) {
  const reduced = useReducedMotion() ?? false;
  // Queries fire before the Clerk token reaches the Convex client on first
  // load; running them unauthenticated throws server-side. Skip until ready.
  const { isAuthenticated } = useConvexAuth();
  const intents = useQuery(
    api.albatrossIntents.listIntents,
    isAuthenticated ? { includeArchived: true } : 'skip',
  ) as IntentRow[] | undefined;
  const [filter, setFilter] = useState<IntentFilter>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialIntentId ?? null);
  // "Answer later" returns to the list; without this flag the auto-select
  // effect would immediately re-open the same intent.
  const userClearedRef = useRef(false);

  const visible = (intents ?? []).filter(
    (intent) => (showArchived || intent.status !== 'archived') && intentMatchesFilter(intent, filter),
  );

  useEffect(() => {
    if (selectedId || userClearedRef.current || !visible.length) return;
    setSelectedId(visible[0]._id);
  }, [selectedId, visible]);

  const workbench = useQuery(
    api.albatrossIntents.getIntentWorkbench,
    isAuthenticated && selectedId ? { intentId: selectedId as Id<'albatrossIntents'> } : 'skip',
  ) as { intent: IntentRow; plan: PlanRow | null } | undefined;

  const answerQuestionsMutation = useMutation(api.albatrossIntents.answerQuestions);
  const updateIntentMutation = useMutation(api.albatrossIntents.updateIntent);

  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const requestPlan = useCallback(async (intentId: string) => {
    setRequestErrors((prev) => ({ ...prev, [intentId]: '' }));
    try {
      // Geo lets planning find real nearby places for option questions.
      const geo = await getGeo();
      await postJson('/api/albatross/plan', {
        intentId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        geo,
      });
    } catch (error) {
      setRequestErrors((prev) => ({
        ...prev,
        [intentId]: error instanceof Error ? error.message : 'Plan request failed.',
      }));
    }
  }, []);

  const selected = workbench?.intent && workbench.intent._id === selectedId ? workbench : undefined;

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <IntentRail
        intents={intents}
        visible={visible}
        filter={filter}
        onFilterChange={setFilter}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((prev) => !prev)}
        selectedId={selectedId}
        onSelect={(intentId) => {
          userClearedRef.current = false;
          setSelectedId(intentId);
        }}
        reduced={reduced}
      />

      <section className="min-w-0 flex-1 overflow-y-auto">
        {selectedId && selected ? (
          <IntentStage
            key={selected.intent._id}
            intent={selected.intent}
            plan={selected.plan}
            reduced={reduced}
            requestError={requestErrors[selected.intent._id] || ''}
            onRequestPlan={() => requestPlan(selected.intent._id)}
            onAnswerAll={async (answers) => {
              await answerQuestionsMutation({
                intentId: selected.intent._id as Id<'albatrossIntents'>,
                answers,
              });
              await requestPlan(selected.intent._id);
            }}
            onAnswerLater={() => {
              userClearedRef.current = true;
              setSelectedId(null);
            }}
            onSetStatus={(status) =>
              updateIntentMutation({ intentId: selected.intent._id as Id<'albatrossIntents'>, status })
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <p className="max-w-sm text-center text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {selectedId
                ? 'Loading…'
                : intents !== undefined && !intents.length
                  ? 'Nothing on your mind yet. Hit New Intent and dump one thing you’ve been avoiding.'
                  : 'Pick an intent to see its plan.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// The intent rail: collapsed it is the Chamaac dock, vertical — a floating
// blurred pill of fixed-size rounded tiles with a 0.2s fill-fade hover (that
// dock does not magnify; see components/ui/chamaac-dock.tsx for provenance).
// Each intent is a typographic initials tile with one status-tone dot; a
// floating name label appears beside the hovered/focused tile, over the
// content, no reflow. Expansion is EXPLICIT only: the "Expand list" control
// opens the 288px labeled overlay, which stays open until its own Collapse
// control — no hover expansion anywhere. Built with plain divs + motion per
// the contract — no nested SidebarProvider.
function IntentRail({
  intents,
  visible,
  filter,
  onFilterChange,
  showArchived,
  onToggleArchived,
  selectedId,
  onSelect,
  reduced,
}: {
  intents: IntentRow[] | undefined;
  visible: IntentRow[];
  filter: IntentFilter;
  onFilterChange: (filter: IntentFilter) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  selectedId: string | null;
  onSelect: (intentId: string) => void;
  reduced: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative shrink-0" style={{ width: RAIL_COLLAPSED_PX }}>
      <motion.aside
        initial={false}
        animate={{ width: expanded ? RAIL_EXPANDED_PX : RAIL_COLLAPSED_PX }}
        transition={railExpandTransition(reduced)}
        aria-label="Intents"
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)]',
          expanded && 'shadow-[var(--shadow-pop)]',
        )}
      >
        {expanded ? (
          <motion.div
            initial={{ opacity: 0 }}
            {...railLabelMotion(true, reduced)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex flex-col border-b border-[var(--color-border)] px-3 py-2.5">
              <div className="flex h-6 items-center gap-2">
                <h2 className="whitespace-nowrap text-[12.5px] font-semibold text-[var(--color-text)]">
                  Intents
                </h2>
                <span className="text-[11px] font-semibold tabular-nums text-[var(--color-text-faint)]">
                  {visible.length}
                </span>
                <button
                  type="button"
                  onClick={onToggleArchived}
                  className={cn(
                    'ml-auto text-[11px] font-medium transition-colors',
                    showArchived
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]',
                  )}
                >
                  Archived
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="text-[11px] font-medium text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
                >
                  Collapse
                </button>
              </div>
              <div className="mt-2">
                <Segmented
                  value={filter}
                  onChange={onFilterChange}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'needs_you', label: 'Needs you' },
                    { value: 'ready', label: 'Ready' },
                    { value: 'done', label: 'Done' },
                  ]}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
              {intents === undefined ? (
                <p className="px-3 py-4 text-center text-[12px] text-[var(--color-text-faint)]">…</p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-4 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                  Nothing on your mind yet. Hit New Intent and dump one thing you&apos;ve been avoiding.
                </p>
              ) : (
                visible.map((intent) => (
                  <IntentRailRow
                    key={intent._id}
                    intent={intent}
                    selected={intent._id === selectedId}
                    reduced={reduced}
                    onSelect={() => onSelect(intent._id)}
                  />
                ))
              )}
            </div>
          </motion.div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center py-2">
            {/* The pill is 52px wide: 40px tiles + Chamaac's 3px inner
                padding + the hairline, leaving a 2px slack column inside for
                the selection edge bar beside the selected tile. */}
            <ChamaacDock className="min-h-0 w-[52px]">
              <ChamaacDockTile
                label="Expand list"
                onClick={() => setExpanded(true)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <PanelLeft className="size-4" />
              </ChamaacDockTile>
              <span
                className="text-[11px] font-semibold tabular-nums text-[var(--color-text-faint)]"
                title={`${visible.length} intents`}
              >
                {visible.length}
              </span>
              <div aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border)]" />
              <div className="flex w-full min-h-0 flex-col items-center gap-[3px] overflow-y-auto py-px [scrollbar-width:none]">
                {intents === undefined ? (
                  <p className="py-3 text-center text-[12px] text-[var(--color-text-faint)]">…</p>
                ) : (
                  visible.map((intent) => (
                    <IntentRailTile
                      key={intent._id}
                      intent={intent}
                      selected={intent._id === selectedId}
                      onSelect={() => onSelect(intent._id)}
                    />
                  ))
                )}
              </div>
            </ChamaacDock>
          </div>
        )}
      </motion.aside>
    </div>
  );
}

// Collapsed-rail intent tile: initials identity, one status-tone corner dot,
// accent edge bar + held Chamaac fill for the selection. The floating dock
// label carries the (truncated) title — no native title tooltip, one label
// mechanism.
function IntentRailTile({
  intent,
  selected,
  onSelect,
}: {
  intent: IntentRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = intentStatusMeta(intent.status);
  const title = intentDisplayTitle(intent);
  const failed = Boolean(intent.planError) && intent.status !== 'planning';
  return (
    <div className="relative flex w-full shrink-0 justify-center">
      {/* Selected intent: accent edge bar in the pill's slack column (the
          one selection mark besides the held fill). */}
      {selected ? (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-r-full bg-[var(--color-accent)]" />
      ) : null}
      <ChamaacDockTile
        label={railTileLabel(title)}
        active={selected}
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
      >
        <span className="font-display text-[13px] font-semibold tracking-tight text-[var(--color-text)]">
          {intentInitials(title)}
        </span>
        {/* One indicator per row: the status-tone dot (bottom-1 keeps it
            inside the round tile edge). */}
        <span
          className={cn('absolute bottom-1 right-1 size-1.5 rounded-full', meta.pulse && 'animate-pulse')}
          style={{
            backgroundColor: failed
              ? 'var(--color-danger)'
              : meta.tone === 'neutral'
                ? 'var(--color-text-faint)'
                : `var(--color-${meta.tone})`,
          }}
        />
      </ChamaacDockTile>
    </div>
  );
}

// Expanded-list row: identity tile plus always-visible title/status column.
function IntentRailRow({
  intent,
  selected,
  reduced,
  onSelect,
}: {
  intent: IntentRow;
  selected: boolean;
  reduced: boolean;
  onSelect: () => void;
}) {
  const meta = intentStatusMeta(intent.status);
  const title = intentDisplayTitle(intent);
  const failed = Boolean(intent.planError) && intent.status !== 'planning';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex w-full items-center px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-[var(--color-selected-soft)]' : 'hover:bg-[var(--color-hover-soft)]',
      )}
    >
      {/* Selected intent: accent edge bar (the one selection mark). */}
      {selected ? (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-[var(--color-accent)]" />
      ) : null}
      {/* Same identity shape as the collapsed Chamaac tiles: a circle. */}
      <span
        className={cn(
          'relative grid size-10 shrink-0 place-items-center rounded-full border',
          selected
            ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
        )}
      >
        <span className="font-display text-[13px] font-semibold tracking-tight text-[var(--color-text)]">
          {intentInitials(title)}
        </span>
        {/* One indicator per row: the status-tone dot. */}
        <span
          className={cn('absolute bottom-1 right-1 size-1.5 rounded-full', meta.pulse && 'animate-pulse')}
          style={{
            backgroundColor: failed
              ? 'var(--color-danger)'
              : meta.tone === 'neutral'
                ? 'var(--color-text-faint)'
                : `var(--color-${meta.tone})`,
          }}
        />
      </span>
      <motion.span
        initial={{ opacity: 0, x: reduced ? 0 : -6 }}
        {...railLabelMotion(true, reduced)}
        className="ml-2.5 flex min-w-0 flex-1 flex-col"
      >
        <span className="truncate text-[13px] font-medium text-[var(--color-text)]">{title}</span>
        <span className="flex items-center gap-1.5 text-[11px]">
          <span
            className={cn(
              'font-medium text-[var(--color-text-muted)]',
              meta.pulse && 'animate-pulse text-[var(--color-accent)]',
            )}
          >
            {failed ? 'Plan failed' : meta.label}
          </span>
          <span className="tabular-nums text-[var(--color-text-faint)]">
            {relativeTime(intent.updatedAt)}
          </span>
        </span>
      </motion.span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Right stage
// ---------------------------------------------------------------------------

function IntentStage({
  intent,
  plan,
  reduced,
  requestError,
  onRequestPlan,
  onAnswerAll,
  onAnswerLater,
  onSetStatus,
}: {
  intent: IntentRow;
  plan: PlanRow | null;
  reduced: boolean;
  requestError: string;
  onRequestPlan: () => void;
  onAnswerAll: (answers: AnswerEntry[]) => Promise<void>;
  onAnswerLater: () => void;
  onSetStatus: (status: 'done' | 'archived') => void;
}) {
  const meta = intentStatusMeta(intent.status);
  const { isAuthenticated } = useConvexAuth();
  const liveAreas = useQuery(api.albatross.listAreas, isAuthenticated ? { status: 'active' } : 'skip') as
    | { name: string }[]
    | undefined;
  const source = SOURCE_META[intent.source] ?? SOURCE_META.text;
  const failure = intent.planError || requestError;

  // Answering the last question regenerates immediately; the vortex shows
  // optimistically instead of waiting for Convex to flip status to planning
  // (answerQuestions briefly parks the intent back on `captured`).
  const [optimisticPlanning, setOptimisticPlanning] = useState(false);
  // Map column: hovered/selected option preview beats persisted state.
  const [previewOption, setPreviewOption] = useState<QuestionOption | null>(null);
  const [mapCollapsed, setMapCollapsed] = useState(false);

  useEffect(() => {
    // Real status arrived (planning) or planning finished (ready/applied):
    // either way the optimistic cover is no longer needed.
    if (intent.status !== 'needs_answers' && intent.status !== 'captured') setOptimisticPlanning(false);
    if (intent.status !== 'needs_answers') setPreviewOption(null);
  }, [intent.status]);
  useEffect(() => {
    if (requestError) setOptimisticPlanning(false);
  }, [requestError]);

  const submitAnswers = useCallback(
    async (answers: AnswerEntry[]) => {
      setOptimisticPlanning(true);
      try {
        await onAnswerAll(answers);
      } catch {
        setOptimisticPlanning(false);
      }
    },
    [onAnswerAll],
  );

  const planningVisible = intent.status === 'planning' || optimisticPlanning;

  // Surface a quiet retry when planning has visibly stalled (orphaned by a
  // deploy or a hang). Ticks only while the vortex is up.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!planningVisible) return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [planningVisible]);
  const planningStalled = intent.status === 'planning' && planningIsStale(intent.updatedAt, nowTick);
  const mapQuery = mapQueryForIntent(intent, plan, previewOption);
  const mapOption = previewOption ?? chosenQuestionOption(intent);
  const vortexTitle = (intent.rawText || intentDisplayTitle(intent)).replace(/\s+/g, ' ').trim();
  const artifactMode = plan ? planStageMode(intent, plan) === 'artifact' : false;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {planningVisible ? (
        <motion.div
          key="planning"
          className="relative h-full min-h-[420px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          // The black hole detonates: a fast blur-scale burst, then the plan
          // stage springs in behind it.
          exit={{ opacity: 0, scale: reduced ? 1 : 2.3, filter: reduced ? 'none' : 'blur(12px)' }}
          transition={{ duration: reduced ? 0 : 0.32, ease: [0.3, 0, 0.6, 1] }}
        >
          <ContextVortex
            title={vortexTitle.length > 96 ? `${vortexTitle.slice(0, 96).trimEnd()}…` : vortexTitle}
            subtitle="Reading your mail, calendar, areas, and the web…"
            sources={vortexSourcesForIntent(
              intent,
              (liveAreas ?? []).map((area) => area.name),
            )}
          />
          {planningStalled ? (
            <div className="absolute inset-x-0 bottom-10 flex flex-col items-center gap-1.5">
              <p className="text-[12.5px] text-[var(--color-text-muted)]">
                This is taking longer than usual.
              </p>
              <QuietButton onClick={onRequestPlan}>Retry</QuietButton>
            </div>
          ) : null}
        </motion.div>
      ) : (
        <motion.div
          key="stage"
          initial={{ opacity: 0, scale: reduced ? 1 : 0.97, y: reduced ? 0 : 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 26 }}
          className={cn('flex min-h-full items-start', artifactMode && 'h-full items-stretch')}
        >
          <div
            className={cn(
              'flex w-full min-w-0 flex-col',
              artifactMode ? 'min-h-0 flex-1' : 'mx-auto max-w-3xl gap-5 px-6 py-5',
            )}
          >
            {artifactMode ? null : (
              <header className="flex items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
                  {intentDisplayTitle(intent)}
                </h1>
                <Tag tone={meta.tone}>
                  <span className="size-1.5 rounded-full bg-current opacity-70" />
                  {meta.label}
                </Tag>
              </header>
            )}

            {artifactMode ? null : <RawDump intent={intent} sourceLabel={source.label} />}

            {/* Options are shown, not just asked about: once a choice question
                is answered, the chosen option stays visible as a designed
                receipt (tool-ui OptionList receipt grammar) in view mode. */}
            {!artifactMode && intent.status !== 'needs_answers' ? (
              <AnsweredChoicesReceipt intent={intent} />
            ) : null}

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                // Keyed by plan, not status: the ready->applied flip must NOT remount
                // PlanReveal, or the apply response (created-things checklist) is lost.
                key={plan?._id ?? intent.status}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.2 }}
                className={cn('flex flex-col gap-5', artifactMode && 'min-h-0 flex-1')}
              >
                {failure && intent.status === 'captured' ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4">
                    <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-danger)]">
                      <TriangleAlert className="size-4" />
                      Planning hit a wall
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-[var(--color-text)]">{failure}</p>
                    <button
                      type="button"
                      onClick={onRequestPlan}
                      className="mt-1 inline-flex w-fit items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text)] hover:bg-[var(--color-hover-soft)]"
                    >
                      Try again
                    </button>
                  </div>
                ) : intent.status === 'captured' ? (
                  <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] p-5">
                    <p className="text-[13px] text-[var(--color-text-muted)]">
                      Albatross will read your mail, calendar, and areas, then turn this into a plan.
                    </p>
                    <PrimaryButton reduced={reduced} onClick={onRequestPlan}>
                      Generate plan
                    </PrimaryButton>
                  </div>
                ) : intent.status === 'needs_answers' ? (
                  <QuestionStepper
                    intent={intent}
                    reduced={reduced}
                    onAnswerAll={submitAnswers}
                    onAnswerLater={onAnswerLater}
                    onPreviewOption={setPreviewOption}
                  />
                ) : plan ? (
                  <PlanReveal
                    intent={intent}
                    plan={plan}
                    reduced={reduced}
                    artifactMode={artifactMode}
                    onSetStatus={onSetStatus}
                  />
                ) : (
                  <p className="text-[13px] text-[var(--color-text-muted)]">
                    No plan recorded for this intent.
                  </p>
                )}
              </motion.div>
            </AnimatePresence>

            {intent.status !== 'archived' && !artifactMode ? (
              <footer className="mt-2 flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
                {intent.status !== 'done' ? (
                  <QuietButton onClick={() => onSetStatus('done')}>Done</QuietButton>
                ) : null}
                <QuietButton onClick={() => onSetStatus('archived')}>Archive</QuietButton>
              </footer>
            ) : null}
          </div>

          {mapQuery && !artifactMode ? (
            <MapColumn
              query={mapQuery}
              option={mapOption}
              collapsed={mapCollapsed}
              onToggle={() => setMapCollapsed((prev) => !prev)}
            />
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Inline place context (Turo-style list+map pairing): a sticky ~360px column
// with a keyless Google Maps embed for the previewed/chosen place, plus its
// hours and website. Collapsible to a thin "Show map" rail.
function MapColumn({
  query,
  option,
  collapsed,
  onToggle,
}: {
  query: string;
  option: QuestionOption | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  if (collapsed) {
    return (
      <div className="sticky top-0 shrink-0 self-start py-5 pr-4">
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
        >
          Show map
        </button>
      </div>
    );
  }
  return (
    <aside className="sticky top-0 w-[360px] shrink-0 self-start py-5 pr-6">
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-1.5">
          <span className="text-[12px] font-medium text-[var(--color-text-faint)]">Location</span>
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto text-[11px] font-medium text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
          >
            Hide
          </button>
        </div>
        <iframe
          // Keyless maps embed; Google's embed refuses to render without
          // scripts + same-origin. The src is a fixed Google origin carrying
          // only our URL-encoded place query.
          src={`https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`}
          sandbox="allow-scripts allow-same-origin"
          title={`Map of ${query}`}
          loading="lazy"
          className="h-[320px] w-full bg-[var(--color-bg-muted)]"
        />
        <div className="flex flex-col gap-0.5 px-3 py-2.5">
          <p className="text-[12.5px] font-medium text-[var(--color-text)]">{option?.title ?? query}</p>
          {[option?.address, option?.hoursText].filter(Boolean).map((line) => (
            <p key={line} className="text-[12px] text-[var(--color-text-muted)]">
              {line}
            </p>
          ))}
          {option?.website ? (
            <a
              href={option.website}
              target="_blank"
              rel="noreferrer"
              className="w-fit text-[12px] font-medium text-[var(--color-accent)] hover:underline"
            >
              {websiteLabel(option.website)}
            </a>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

// The raw dump is the user's own words: verbatim, quote-styled, never editable.
function RawDump({ intent, sourceLabel }: { intent: IntentRow; sourceLabel: string }) {
  return (
    <figure className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <blockquote className="whitespace-pre-wrap font-display text-[15px] leading-relaxed text-[var(--color-text)]">
        {intent.rawText}
      </blockquote>
      <figcaption className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
        <span>{sourceLabel}</span>
        <span>·</span>
        <span>{relativeTime(intent.createdAt)}</span>
      </figcaption>
    </figure>
  );
}

// Answered option-questions in view mode — the tool-ui OptionList "receipt"
// treatment: each choice question collapses to its chosen option (filled check,
// title, detail, website) with a quiet count of the alternatives it beat, so
// the plan page keeps SHOWING the options story instead of discarding it.
function AnsweredChoicesReceipt({ intent }: { intent: IntentRow }) {
  const rows = answeredOptionChoices(intent);
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      {rows.map((row) => (
        <div
          key={row.option.id}
          className="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-foreground)]">
            <Check className="size-3" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] text-[var(--color-text-faint)]">{row.prompt}</p>
            <p className="mt-0.5 text-[13px] font-semibold text-[var(--color-text)]">{row.option.title}</p>
            {[row.option.detail, row.option.address].filter(Boolean).map((line) => (
              <p key={line} className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                {line}
              </p>
            ))}
            {row.option.website ? (
              <a
                href={row.option.website}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[11.5px] font-medium text-[var(--color-accent)] hover:underline"
              >
                {websiteLabel(row.option.website)}
              </a>
            ) : null}
          </div>
          {row.alternatives > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
              picked over {row.alternatives} other{row.alternatives === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// One-question-at-a-time stepper (Cosmos/Indeed/Juicebox pattern). Questions
// with options render as choosable place cards (Vercel "we found some options"
// affirm pattern); free text stays available beneath. Answering the LAST
// question submits everything and regenerates immediately - no extra button.
function QuestionStepper({
  intent,
  reduced,
  onAnswerAll,
  onAnswerLater,
  onPreviewOption,
}: {
  intent: IntentRow;
  reduced: boolean;
  onAnswerAll: (answers: AnswerEntry[]) => Promise<void>;
  onAnswerLater: () => void;
  onPreviewOption: (option: QuestionOption | null) => void;
}) {
  const open = openQuestions(intent);
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, AnswerEntry>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const current = open[Math.min(step, Math.max(0, open.length - 1))];

  const advance = async (entry: AnswerEntry) => {
    const nextDrafts = { ...drafts, [entry.id]: entry };
    setDrafts(nextDrafts);
    // Pure check: with this answer merged in, is every question answered?
    const projected = (intent.questions ?? []).map((question) => ({
      ...question,
      answer: nextDrafts[question.id]?.answer || question.answer,
    }));
    if (!answersReadyForRegen({ ...intent, questions: projected })) {
      setStep(step + 1);
      return;
    }
    setSubmitting(true);
    try {
      await onAnswerAll(open.map((question) => nextDrafts[question.id] ?? { id: question.id, answer: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  if (!current) return null;
  const options = current.options ?? [];
  const pickedOption = options.find((option) => option.id === picked[current.id]);
  const text = texts[current.id] ?? '';

  const pick = (option: QuestionOption) => {
    setPicked((prev) => ({ ...prev, [current.id]: option.id }));
    onPreviewOption(option);
  };
  const confirmOption = (option: QuestionOption) => {
    if (submitting) return;
    onPreviewOption(option); // the map keeps showing the choice through regen
    void advance({ id: current.id, answer: option.title, answeredOptionId: option.id });
  };
  const submitText = () => {
    if (submitting || !text.trim()) return;
    void advance({ id: current.id, answer: text.trim() });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 py-8">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -8 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
          className="flex flex-col gap-3"
        >
          <p className="text-[12px] font-medium tabular-nums text-[var(--color-text-faint)]">
            {Math.min(step, open.length - 1) + 1} of {open.length}
          </p>
          <p className="font-display text-[19px] font-semibold leading-snug text-[var(--color-text)]">
            {current.prompt}
          </p>

          {options.length ? (
            <div role="radiogroup" aria-label={current.prompt} className="flex flex-col gap-2">
              {options.map((option) => {
                const isPicked = pickedOption?.id === option.id;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: the card embeds a real <a> (website), which a native <input type="radio"> cannot contain
                  <div
                    key={option.id}
                    role="radio"
                    aria-checked={isPicked}
                    tabIndex={0}
                    onClick={() => pick(option)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (isPicked) confirmOption(option);
                        else pick(option);
                      }
                      if (event.key === ' ') {
                        event.preventDefault();
                        pick(option);
                      }
                    }}
                    onMouseEnter={() => onPreviewOption(option)}
                    onMouseLeave={() => onPreviewOption(pickedOption ?? null)}
                    className={cn(
                      'cursor-pointer rounded-lg border p-3 transition-colors',
                      isPicked
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                        : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-strong)]',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {/* tool-ui OptionList selection grammar: a radio indicator
                          that fills with the accent when picked. */}
                      <span className="flex h-5 shrink-0 items-center">
                        <span
                          className={cn(
                            'flex size-4 items-center justify-center rounded-full border-2 transition-colors',
                            isPicked
                              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                              : 'border-[var(--color-border-strong)]',
                          )}
                        >
                          {isPicked ? <span className="size-2 rounded-full bg-current" /> : null}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-semibold text-[var(--color-text)]">{option.title}</p>
                        {[option.detail, option.address].filter(Boolean).map((line) => (
                          <p
                            key={line}
                            className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]"
                          >
                            {line}
                          </p>
                        ))}
                        {option.hoursText ? (
                          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">
                            {option.hoursText}
                          </p>
                        ) : null}
                        {option.website ? (
                          <a
                            href={option.website}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="mt-1 inline-block text-[11.5px] font-medium text-[var(--color-accent)] hover:underline"
                          >
                            {websiteLabel(option.website)}
                          </a>
                        ) : null}
                      </div>
                      {isPicked ? (
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmOption(option);
                          }}
                          className="shrink-0 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-accent-foreground)] disabled:opacity-40"
                        >
                          Use this one
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <input
            // biome-ignore lint/a11y/noAutofocus: keyboard-first stepper - the input is the whole step and focus must follow each question
            autoFocus={!options.length}
            value={text}
            disabled={submitting}
            onChange={(event) => setTexts((prev) => ({ ...prev, [current.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && text.trim()) {
                event.preventDefault();
                submitText();
              }
            }}
            placeholder={options.length ? 'None of these / something else…' : 'Type your answer, press Enter'}
            className="h-10 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg)] px-3 text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] disabled:opacity-50"
          />
          <div className="flex items-center gap-3">
            {!options.length ? (
              <button
                type="button"
                disabled={submitting || !text.trim()}
                onClick={submitText}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-accent-foreground)] disabled:opacity-40"
              >
                Continue
              </button>
            ) : null}
            <QuietButton onClick={onAnswerLater}>Answer later</QuietButton>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The reveal (Lightfield cascade) + apply
// ---------------------------------------------------------------------------

function actionDetailLine(action: DigitalActionLike): string | null {
  if (action.kind === 'calendar_event' && action.startIso) {
    const date = new Date(action.startIso);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }
  }
  if (action.kind === 'email_draft' && action.to) return `To ${action.to}`;
  if (action.description) return action.description.split('\n')[0];
  return null;
}

function PlanReveal({
  intent,
  plan,
  reduced,
  artifactMode = false,
  onSetStatus,
}: {
  intent: IntentRow;
  plan: PlanRow;
  reduced: boolean;
  artifactMode?: boolean;
  onSetStatus?: (status: 'done' | 'archived') => void;
}) {
  const sequence = planRevealSequence(plan);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const [projectMode, setProjectMode] = useState<'auto' | 'project' | 'task_only'>('auto');
  const artifactFrameRef = useRef<HTMLIFrameElement>(null);

  // Same theme contract as the Daily Brief: the artifact is --brief-* token
  // HTML; the host mirrors the app's resolved fonts and colors into it on
  // load and again whenever any customization slice moves.
  const appFont = useClientStore((s) => s.appFont);
  const accentHue = useClientStore((s) => s.accentHue);
  const accentChroma = useClientStore((s) => s.accentChroma);
  const accent2Hue = useClientStore((s) => s.accent2Hue);
  const accent2Chroma = useClientStore((s) => s.accent2Chroma);
  const bgHue = useClientStore((s) => s.bgHue);
  const surfaceTint = useClientStore((s) => s.surfaceTint);
  const postTheme = useCallback(() => {
    postBriefTheme(artifactFrameRef.current?.contentWindow, appFont);
  }, [appFont]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: color slices intentionally re-trigger the post; resolved values come from computed CSS.
  useEffect(() => {
    postTheme();
  }, [postTheme, accentHue, accentChroma, accent2Hue, accent2Chroma, bgHue, surfaceTint]);
  const disabledReason = applyDisabledReason(intent, plan);
  const isApplied = applied !== null || plan.status === 'applied';

  // ---- Interactive task cards (deterministic bridge) ----------------------
  // The dossier's Done controls post toggle_step; the host resolves the
  // stepKey to the board card created at apply time and flips it through
  // api.boards.updateCard (which records the completionEvent and ticks
  // Projects progress — never bypassed). Completion state flows back as
  // step_state, sourced from a live Convex query so a card completed on the
  // task board strikes off here too.
  const { isAuthenticated } = useConvexAuth();
  const appliedSteps = useMemo<AppliedPlanStep[]>(
    () => (plan.appliedSteps?.length ? plan.appliedSteps : (applied?.appliedSteps ?? [])),
    [plan.appliedSteps, applied],
  );
  const stepCardIds = useMemo(
    () => appliedSteps.filter((step) => step.cardId).map((step) => String(step.cardId)),
    [appliedSteps],
  );
  const cardStates = useQuery(
    api.boards.getCardStates,
    isAuthenticated && stepCardIds.length ? { cardIds: stepCardIds } : 'skip',
  ) as StepCardState[] | undefined;
  const updateCardMutation = useMutation(api.boards.updateCard);
  const artifactDoc = useMemo(
    () => (plan.artifactHtml ? injectPlanArtifactRuntime(plan.artifactHtml) : undefined),
    [plan.artifactHtml],
  );

  const postStepState = useCallback(
    (states?: PlanStepState[]) => {
      artifactFrameRef.current?.contentWindow?.postMessage(
        {
          source: 'lab86-host',
          type: 'step_state',
          steps: states ?? stepStatesForArtifact(appliedSteps, cardStates ?? []),
        },
        '*',
      );
    },
    [appliedSteps, cardStates],
  );
  useEffect(() => {
    postStepState();
  }, [postStepState]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const frame = artifactFrameRef.current;
      // Only trust messages from our own iframe document, and only the
      // allowlisted toggle_step shape (parseToggleStepMessage rejects the rest).
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseToggleStepMessage(event.data);
      if (!message) return;
      const ack = (ok: boolean, error?: string) =>
        frame.contentWindow?.postMessage(
          {
            source: 'lab86-host',
            action: 'toggle_step',
            ok,
            ...(error ? { error } : {}),
            payload: { stepKey: message.stepKey },
          },
          '*',
        );
      const decision = toggleStepDecision({
        applied: isApplied,
        steps: appliedSteps,
        cardStates: cardStates ?? [],
        stepKey: message.stepKey,
      });
      // Unapplied plans get a quiet inline hint inside the card, never an alert.
      if (decision.kind !== 'toggle') return ack(false, decision.kind);
      try {
        // Optimistic strike so the card settles instantly; the live query
        // confirms (or corrects) right after the mutation lands.
        postStepState([{ stepKey: message.stepKey, completed: decision.nextCompletedAt !== null }]);
        await updateCardMutation({
          cardId: decision.cardId as Id<'cards'>,
          completedAt: decision.nextCompletedAt,
        });
        ack(true);
      } catch (error) {
        postStepState();
        ack(false, error instanceof Error ? error.message : 'update failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isApplied, appliedSteps, cardStates, updateCardMutation, postStepState]);
  // --------------------------------------------------------------------------

  const apply = async () => {
    setApplying(true);
    setApplyError('');
    try {
      setApplied(await postJson<ApplyResponse>('/api/albatross/apply', { planId: plan._id, projectMode }));
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : 'Apply failed.');
    } finally {
      setApplying(false);
    }
  };

  // Reduced motion collapses the cascade to a plain fade (no offset, no delay).
  const reveal = (index: number) => ({
    initial: { opacity: 0, y: reduced ? 0 : 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduced ? 0.15 : 0.35, delay: reduced ? 0 : index * 0.08 },
  });

  // Artifact mode: the model-composed document IS the plan view. It fills the
  // pane (same sandboxed treatment as the Daily Brief); only the action row
  // and applied/approval summaries render natively above it.
  if (artifactMode && plan.artifactHtml) {
    return (
      <div className="relative min-h-0 flex-1">
        <motion.iframe
          ref={artifactFrameRef}
          key={plan._id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0.15 : 0.3 }}
          title="Plan"
          srcDoc={artifactDoc}
          sandbox="allow-scripts allow-popups"
          onLoad={() => {
            postTheme();
            postStepState();
          }}
          className="absolute inset-0 h-full w-full bg-[var(--color-bg)]"
        />
        {/* Controls float over the document so the plan owns every pixel. */}
        <div className="absolute right-4 top-3 flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 px-3 py-1.5 shadow-[var(--shadow-pop)] backdrop-blur-sm">
          {isApplied ? (
            <span className="text-[12px] font-medium text-[var(--color-success,#16a34a)]">Applied</span>
          ) : (
            <>
              <PrimaryButton reduced={reduced} disabled={Boolean(disabledReason) || applying} onClick={apply}>
                {applying ? 'Applying…' : 'Apply plan'}
              </PrimaryButton>
              {(plan.digitalActions?.length ?? 0) >= 4 ? (
                <Segmented
                  value={projectMode}
                  onChange={setProjectMode}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'project', label: 'Project' },
                    { value: 'task_only', label: 'Tasks only' },
                  ]}
                />
              ) : null}
            </>
          )}
          <QuietButton onClick={() => onSetStatus?.('done')}>Done</QuietButton>
          <QuietButton onClick={() => onSetStatus?.('archived')}>Archive</QuietButton>
        </div>
        {applyError || (disabledReason && !isApplied) ? (
          <div className="absolute left-4 top-3 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 px-3 py-1.5 text-[12px] shadow-[var(--shadow-pop)]">
            {applyError ? (
              <span className="text-[var(--color-danger)]">{applyError}</span>
            ) : (
              <span className="text-[var(--color-text-faint)]">{disabledReason}</span>
            )}
          </div>
        ) : null}
        {isApplied && (applied?.approvals?.length || applied?.operations?.length) ? (
          <div className="absolute inset-x-4 bottom-3 max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 p-3 shadow-[var(--shadow-pop)] backdrop-blur-sm">
            <AppliedSummary plan={plan} applied={applied} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {sequence.map((item, index) => (
        <RevealBlock key={item.key} item={item} plan={plan} motionProps={reveal(index)} />
      ))}

      {isApplied ? (
        <AppliedSummary plan={plan} applied={applied} />
      ) : (
        <motion.div {...reveal(sequence.length)} className="mt-1 flex flex-wrap items-center gap-3">
          <PrimaryButton reduced={reduced} disabled={Boolean(disabledReason) || applying} onClick={apply}>
            {applying ? 'Applying…' : 'Apply plan'}
          </PrimaryButton>
          {(plan.digitalActions?.length ?? 0) >= 4 ? (
            <Segmented
              value={projectMode}
              onChange={setProjectMode}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'project', label: 'Project' },
                { value: 'task_only', label: 'Tasks only' },
              ]}
            />
          ) : null}
          {disabledReason ? (
            <span className="text-[12px] text-[var(--color-text-faint)]">{disabledReason}</span>
          ) : null}
          {applyError ? <span className="text-[12px] text-[var(--color-danger)]">{applyError}</span> : null}
        </motion.div>
      )}
    </div>
  );
}

interface MotionRevealProps {
  initial: { opacity: number; y: number };
  animate: { opacity: number; y: number };
  transition: { duration: number; delay: number };
}

function RevealBlock({
  item,
  plan,
  motionProps,
}: {
  item: RevealItem;
  plan: PlanRow;
  motionProps: MotionRevealProps;
}) {
  if (item.kind === 'outcome') {
    return (
      <motion.div {...motionProps}>
        <p className="font-display text-[22px] font-semibold leading-snug tracking-tight text-[var(--color-text)]">
          {plan.outcome || plan.summary}
        </p>
        {plan.outcome && plan.summary ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">{plan.summary}</p>
        ) : null}
      </motion.div>
    );
  }
  if (item.kind === 'action' && item.action) {
    const detail = actionDetailLine(item.action);
    // One indicator per row: the trailing kind tag carries the type; no
    // leading icon chip (the icon-in-a-pale-chip repeated per row is exactly
    // the generated-UI signature Jakob banned).
    return (
      <motion.div
        {...motionProps}
        className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-[var(--color-text)]">
            {item.action.kind === 'email_draft' && item.action.subject
              ? item.action.subject
              : item.action.title}
          </p>
          {detail ? (
            <p className="mt-0.5 truncate text-[12px] text-[var(--color-text-muted)]">{detail}</p>
          ) : null}
        </div>
        <Tag tone="neutral">{ACTION_LABELS[item.action.kind] ?? item.action.kind}</Tag>
      </motion.div>
    );
  }
  if (item.kind === 'physical') {
    return (
      <motion.div {...motionProps} className="rounded-lg border border-[var(--color-border)] p-3">
        <p className="mb-2 text-[12px] font-medium text-[var(--color-text-faint)]">Real world</p>
        <ul className="flex flex-col gap-1.5">
          {(plan.physicalActions ?? []).map((step) => (
            <li key={step.title} className="flex items-start gap-2 text-[13px] text-[var(--color-text)]">
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
              <span className="min-w-0">
                {step.title}
                {step.detail ? (
                  <span className="text-[var(--color-text-muted)]"> — {step.detail}</span>
                ) : null}
                {step.url ? (
                  <a
                    href={step.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1.5 inline-flex items-center gap-0.5 text-[12px] text-[var(--color-accent)] hover:underline"
                  >
                    <Link2 className="size-3" />
                    Link
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </motion.div>
    );
  }
  if (item.kind === 'assumptions') {
    return (
      <motion.div {...motionProps} className="text-[12px] leading-relaxed text-[var(--color-text-faint)]">
        <span className="font-medium">Assuming:</span> {(plan.assumptions ?? []).join(' · ')}
      </motion.div>
    );
  }
  if (item.kind === 'sources') {
    return (
      <motion.div {...motionProps} className="flex flex-wrap gap-1.5">
        {(plan.sourceRefs ?? []).map((ref) =>
          ref.url ? (
            <a
              key={`${ref.kind}-${ref.id}`}
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            >
              <Link2 className="size-3" />
              {ref.label || `${ref.kind} ${ref.id}`}
            </a>
          ) : (
            <Tag key={`${ref.kind}-${ref.id}`} tone="neutral">
              {ref.label || `${ref.kind} ${ref.id}`}
            </Tag>
          ),
        )}
      </motion.div>
    );
  }
  if (item.kind === 'artifact') {
    return (
      <motion.div {...motionProps} className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-1.5">
          <span className="text-[12px] font-medium text-[var(--color-text-faint)]">Plan brief</span>
          <a
            href={`/api/albatross/plan/${plan._id}/artifact`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--color-accent)] hover:underline"
          >
            Open brief
            <ExternalLink className="size-3" />
          </a>
        </div>
        <iframe
          src={`/api/albatross/plan/${plan._id}/artifact`}
          sandbox="allow-popups"
          title="Plan brief"
          className="h-[420px] w-full bg-white"
        />
      </motion.div>
    );
  }
  return null;
}

function AppliedSummary({ plan, applied }: { plan: PlanRow; applied: ApplyResponse | null }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success-soft)] p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-success)]">
        <CheckCircle2 className="size-4" />
        Made real{plan.appliedAt ? ` ${relativeTime(plan.appliedAt)}` : ''}
      </div>
      {applied ? (
        <>
          <ul className="flex flex-col gap-1">
            {applied.operations.map((op) => (
              <li
                key={op.operationId}
                className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]"
              >
                <Check className="size-3.5 shrink-0 text-[var(--color-success)]" />
                <span className="truncate">{op.title}</span>
              </li>
            ))}
          </ul>
          {applied.approvals.length ? (
            <div className="mt-1">
              <p className="text-[12px] font-medium text-[var(--color-text-faint)]">Needs your approval</p>
              <ul className="mt-1 flex flex-col gap-1">
                {applied.approvals.map((approval) => (
                  <li
                    key={approval.approvalId}
                    className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]"
                  >
                    <Hourglass className="size-3.5 shrink-0 text-[var(--color-warning)]" />
                    <span className="truncate">{approval.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {applied.artifactAttachedTo ? (
            <p className="text-[12px] text-[var(--color-text-muted)]">Plan brief attached to the task.</p>
          ) : null}
        </>
      ) : (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">
          Everything in this plan was created. Approvals, if any, run from the approval queue.
        </p>
      )}
    </div>
  );
}
