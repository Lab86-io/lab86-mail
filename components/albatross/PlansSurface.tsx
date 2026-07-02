'use client';

// Research (Albatross contract - research before code):
// - Mobbin/Lightfield "tasks created from doc" cascade (5b5f4b9f-5940-47a0-845d-f6c74bac4de8):
//   generated artifacts cascade in beneath the source content -> staggered card reveal.
// - Mobbin/Grok Tasks (83c6a6f4-9a04-43d8-a2af-f1eae69e9eee): created items as flat dense
//   cards with metadata -> applied-state checklist tone.
// - Mobbin/Cosmos (e5adf3d5), Indeed (ace777b6), Juicebox (04c29067): one-question-at-a-time
//   with big prompt, single input, "n of m" progress, quiet skip.
// - Mobbin/Skillshare (88c2216e), Relevance AI (0fb61e3e), ElevenLabs (560e2903): generating
//   states are calm status text center stage, never spinner-first.
// - motion.dev/docs/react-animation: stagger via per-child delays; delays derive from
//   planRevealSequence indexes (deterministic, testable); useReducedMotion -> fade-only.

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import {
  Archive,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  Hourglass,
  Link2,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageCircleQuestion,
  Mic,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Type,
  WandSparkles,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
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

export interface IntentQuestion {
  id: string;
  prompt: string;
  answer?: string;
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
  planning: { label: 'Planning', tone: 'accent', icon: 'sparkles', pulse: true },
  needs_answers: { label: 'Needs you', tone: 'warning', icon: 'message-circle-question', pulse: false },
  ready: { label: 'Ready', tone: 'accent', icon: 'wand-sparkles', pulse: false },
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

export type IntentFilter = 'all' | 'needs_you' | 'ready' | 'done';

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
}

interface ApplyResponse {
  ok: boolean;
  operationBatchId: string;
  applicationId: string;
  projectId?: string;
  operations: { operationId: string; tool: string; artifactId: string; title: string }[];
  approvals: { approvalId: string; title: string; toolName?: string }[];
  unresolved: { title?: string; blockedReason?: string }[];
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

// ---------------------------------------------------------------------------
// Small local atoms (reimplemented per contract - no AlbatrossSurfaces import)
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, LucideIcon> = {
  'circle-dot': CircleDot,
  sparkles: Sparkles,
  'message-circle-question': MessageCircleQuestion,
  'wand-sparkles': WandSparkles,
  'check-circle': CheckCircle2,
  check: Check,
  archive: Archive,
};

const ACTION_ICONS: Record<string, LucideIcon> = {
  task: ListChecks,
  calendar_event: CalendarDays,
  email_draft: Mail,
};

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
      className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--color-accent)] px-5 text-[14px] font-semibold text-[var(--color-accent-foreground)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
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
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
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
      await postJson('/api/albatross/plan', {
        intentId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="flex flex-col gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[12.5px] font-semibold text-[var(--color-text)]">Intents</h2>
            <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{visible.length}</span>
            <button
              type="button"
              onClick={() => setShowArchived((prev) => !prev)}
              className={cn(
                'ml-auto text-[11px] font-medium transition-colors',
                showArchived
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]',
              )}
            >
              Archived
            </button>
          </div>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'needs_you', label: 'Needs you' },
              { value: 'ready', label: 'Ready' },
              { value: 'done', label: 'Done' },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {intents === undefined ? (
            <p className="px-3 py-4 text-[12px] text-[var(--color-text-faint)]">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-4 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              Nothing on your mind yet. Hit New Intent and dump one thing you&apos;ve been avoiding.
            </p>
          ) : (
            visible.map((intent) => (
              <IntentListRow
                key={intent._id}
                intent={intent}
                selected={intent._id === selectedId}
                onSelect={() => {
                  userClearedRef.current = false;
                  setSelectedId(intent._id);
                }}
              />
            ))
          )}
        </div>
      </aside>

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

function IntentListRow({
  intent,
  selected,
  onSelect,
}: {
  intent: IntentRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = intentStatusMeta(intent.status);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors',
        selected ? 'bg-[var(--color-selected-soft)]' : 'hover:bg-[var(--color-hover-soft)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">
          {intentDisplayTitle(intent)}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
          {relativeTime(intent.updatedAt)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn('size-1.5 shrink-0 rounded-full', meta.pulse && 'animate-pulse')}
          style={{
            backgroundColor:
              meta.tone === 'neutral' ? 'var(--color-text-faint)' : `var(--color-${meta.tone})`,
          }}
        />
        <span
          className={cn(
            'text-[11px] font-medium text-[var(--color-text-muted)]',
            meta.pulse && 'animate-pulse text-[var(--color-accent)]',
          )}
        >
          {meta.label}
        </span>
        {intent.planError && intent.status !== 'planning' ? (
          <span className="text-[11px] font-medium text-[var(--color-danger)]">Plan failed</span>
        ) : null}
      </div>
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
  onAnswerAll: (answers: { id: string; answer: string }[]) => Promise<void>;
  onAnswerLater: () => void;
  onSetStatus: (status: 'done' | 'archived') => void;
}) {
  const meta = intentStatusMeta(intent.status);
  const StatusIcon = STATUS_ICONS[meta.icon] ?? CircleDot;
  const source = SOURCE_META[intent.source] ?? SOURCE_META.text;
  const failure = intent.planError || requestError;

  if (intent.status === 'planning') return <PlanningStage intent={intent} reduced={reduced} />;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-5">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
          {intentDisplayTitle(intent)}
        </h1>
        <Tag tone={meta.tone}>
          <StatusIcon className="size-3" />
          {meta.label}
        </Tag>
      </header>

      <RawDump intent={intent} sourceLabel={source.label} SourceIcon={source.icon} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          // Keyed by plan, not status: the ready->applied flip must NOT remount
          // PlanReveal, or the apply response (created-things checklist) is lost.
          key={plan?._id ?? intent.status}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
          className="flex flex-col gap-5"
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
                className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text)] hover:bg-[var(--color-hover-soft)]"
              >
                <RefreshCw className="size-3.5" />
                Try again
              </button>
            </div>
          ) : intent.status === 'captured' ? (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] p-5">
              <p className="text-[13px] text-[var(--color-text-muted)]">
                Albatross will read your mail, calendar, and areas, then turn this into a plan.
              </p>
              <PrimaryButton reduced={reduced} onClick={onRequestPlan}>
                <Sparkles className="size-4" />
                Make a plan
              </PrimaryButton>
            </div>
          ) : intent.status === 'needs_answers' ? (
            <QuestionStepper
              intent={intent}
              reduced={reduced}
              onAnswerAll={onAnswerAll}
              onAnswerLater={onAnswerLater}
            />
          ) : plan ? (
            <PlanReveal intent={intent} plan={plan} reduced={reduced} />
          ) : (
            <p className="text-[13px] text-[var(--color-text-muted)]">No plan recorded for this intent.</p>
          )}
        </motion.div>
      </AnimatePresence>

      {intent.status !== 'archived' ? (
        <footer className="mt-2 flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
          {intent.status !== 'done' ? (
            <QuietButton onClick={() => onSetStatus('done')}>
              <Check className="size-3.5" />
              Done
            </QuietButton>
          ) : null}
          <QuietButton onClick={() => onSetStatus('archived')}>
            <Archive className="size-3.5" />
            Archive
          </QuietButton>
        </footer>
      ) : null}
    </div>
  );
}

// The raw dump is the user's own words: verbatim, quote-styled, never editable.
function RawDump({
  intent,
  sourceLabel,
  SourceIcon,
}: {
  intent: IntentRow;
  sourceLabel: string;
  SourceIcon: LucideIcon;
}) {
  return (
    <figure className="rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <blockquote className="whitespace-pre-wrap font-display text-[15px] leading-relaxed text-[var(--color-text)]">
        {intent.rawText}
      </blockquote>
      <figcaption className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
        <SourceIcon className="size-3" />
        <span>{sourceLabel}</span>
        <span>·</span>
        <span>{relativeTime(intent.createdAt)}</span>
      </figcaption>
    </figure>
  );
}

// Planning keeps the user's own words center stage under a soft animated wash -
// Skillshare/Relevance-style "calm working", not a spinner.
function PlanningStage({ intent, reduced }: { intent: IntentRow; reduced: boolean }) {
  return (
    <div className="relative flex h-full min-h-[360px] items-center justify-center overflow-hidden px-8">
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(60% 50% at 50% 40%, var(--color-accent-soft) 0%, transparent 70%)',
        }}
        animate={reduced ? { opacity: 0.5 } : { opacity: [0.35, 0.75, 0.35] }}
        transition={reduced ? undefined : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative flex max-w-xl flex-col items-center gap-4 text-center">
        <blockquote className="whitespace-pre-wrap font-display text-[17px] leading-relaxed text-[var(--color-text)]">
          {intent.rawText}
        </blockquote>
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-accent)]">
          <Sparkles className={cn('size-4', !reduced && 'animate-pulse')} />
          Reading your mail, calendar, and areas…
        </div>
      </div>
    </div>
  );
}

// One-question-at-a-time stepper (Cosmos/Indeed/Juicebox pattern).
function QuestionStepper({
  intent,
  reduced,
  onAnswerAll,
  onAnswerLater,
}: {
  intent: IntentRow;
  reduced: boolean;
  onAnswerAll: (answers: { id: string; answer: string }[]) => Promise<void>;
  onAnswerLater: () => void;
}) {
  const open = openQuestions(intent);
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const done = step >= open.length;
  const current = done ? undefined : open[step];

  const regenerate = async () => {
    setSubmitting(true);
    try {
      await onAnswerAll(open.map((question) => ({ id: question.id, answer: drafts[question.id] ?? '' })));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 py-8">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={done ? 'review' : current?.id}
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -8 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
          className="flex flex-col gap-3"
        >
          {done || !current ? (
            <>
              <p className="text-[12px] font-medium text-[var(--color-text-faint)]">All set</p>
              <ul className="flex flex-col gap-1.5">
                {open.map((question) => (
                  <li key={question.id} className="text-[12.5px] leading-relaxed">
                    <span className="text-[var(--color-text-muted)]">{question.prompt}</span>{' '}
                    <span className="font-medium text-[var(--color-text)]">{drafts[question.id] || '—'}</span>
                  </li>
                ))}
              </ul>
              <PrimaryButton reduced={reduced} disabled={submitting} onClick={regenerate}>
                <RefreshCw className="size-4" />
                {submitting ? 'Regenerating…' : 'Regenerate plan'}
              </PrimaryButton>
            </>
          ) : (
            <>
              <p className="text-[12px] font-medium tabular-nums text-[var(--color-text-faint)]">
                {step + 1} of {open.length}
              </p>
              <p className="font-display text-[19px] font-semibold leading-snug text-[var(--color-text)]">
                {current.prompt}
              </p>
              <input
                // biome-ignore lint/a11y/noAutofocus: keyboard-first stepper - the input is the whole step and focus must follow each question
                autoFocus
                value={drafts[current.id] ?? ''}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [current.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (drafts[current.id] ?? '').trim()) {
                    event.preventDefault();
                    setStep(step + 1);
                  }
                }}
                placeholder="Type your answer, press Enter"
                className="h-10 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg)] px-3 text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={!(drafts[current.id] ?? '').trim()}
                  onClick={() => setStep(step + 1)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--color-accent-foreground)] disabled:opacity-40"
                >
                  Continue
                  <ArrowRight className="size-3.5" />
                </button>
                <QuietButton onClick={onAnswerLater}>Answer later</QuietButton>
              </div>
            </>
          )}
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

function PlanReveal({ intent, plan, reduced }: { intent: IntentRow; plan: PlanRow; reduced: boolean }) {
  const sequence = planRevealSequence(plan);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const [projectMode, setProjectMode] = useState<'auto' | 'project' | 'task_only'>('auto');
  const disabledReason = applyDisabledReason(intent, plan);
  const isApplied = applied !== null || plan.status === 'applied';

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
            <Sparkles className="size-4" />
            {applying ? 'Creating…' : 'Make it real'}
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
    const Icon = ACTION_ICONS[item.action.kind] ?? ListChecks;
    const detail = actionDetailLine(item.action);
    return (
      <motion.div
        {...motionProps}
        className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Icon className="size-4" />
        </span>
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
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
          In the real world
        </p>
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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
            Plan brief
          </span>
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
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                Waiting for your OK
              </p>
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
