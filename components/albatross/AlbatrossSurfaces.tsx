'use client';

import {
  Archive,
  ArrowRight,
  AtSign,
  BellOff,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FolderPlus,
  GitPullRequest,
  Globe,
  Inbox,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  type LucideIcon,
  Mail,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type AlbatrossApplicationInput,
  type AlbatrossApplicationPlan,
  type AlbatrossApplicationStep,
  type AlbatrossArtifactKind,
  type AlbatrossProjectMode,
  buildAlbatrossApplicationPlan,
} from '@/lib/albatross/work-model';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import {
  type Approval,
  AREA_LENSES,
  type Area,
  type AreaAssignment,
  type AreaDetail,
  type AreaFact,
  type AreaLensItem,
  type AreaLensItemKind,
  type AreaLensKey,
  type ArtifactClassification,
  type ArtifactKind,
  applyReviewDecision,
  approvalQueue,
  areaName,
  areas,
  type BoardCard,
  buildAreaDetail,
  buildAreaLens,
  buildAreaLensCounts,
  buildAreaSummaries,
  buildAreaTaskGroups,
  buildIntentWorkbench,
  buildKanbanColumns,
  buildNoiseRules,
  buildProjectPane,
  buildProjectTaskGroups,
  buildRecentCorrections,
  buildReviewDetail,
  buildReviewQueue,
  buildSetupPlan,
  buildSetupStep,
  type CapturedIntent,
  type ContextReviewItem,
  classifyArtifact,
  classifyThread,
  type DraftedFact,
  deriveActiveSprint,
  draftedFactKey,
  draftSetupFact,
  type FactStatus,
  type GeneratedIntentPlan,
  type Intent,
  type IntentContextItem,
  type IntentQuestion,
  intents,
  type ParsedIntent,
  type ParsedIntentKind,
  type ProjectNeed,
  type ProjectPaneModel,
  type ProposedArtifact,
  parseIntent,
  type ReviewActionKind,
  type ReviewDecisionEffect,
  type ReviewDetail,
  reviewDecisionOptions,
  SETUP_FACT_KINDS,
  type SetupFactKind,
  type SetupStep,
  type SourceRef,
  summarizeSetupProgress,
  toClassifierArtifact,
} from './surface-data';

type AlbatrossSurfaceKind = 'areas' | 'intents' | 'unassigned';

// Capture moved out of this wrapper: the global IntentCaptureLauncher in
// AppShell owns the New Intent button on every surface, and the live intent →
// plan loop renders in PlansSurface. This wrapper keeps Areas and the
// Unassigned review queue; the legacy seed-driven Intents surface stays
// reachable for the 'intents' kind but is no longer routed by the shell.
export function AlbatrossSurface({ kind }: { kind: AlbatrossSurfaceKind }) {
  return (
    <div className="relative flex h-full min-w-0 flex-col">
      {kind === 'intents' ? (
        <IntentsSurface captured={[]} />
      ) : kind === 'unassigned' ? (
        <UnassignedSurface />
      ) : (
        <AreasSurface />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

const ARTIFACT_ICON: Record<ArtifactKind, LucideIcon> = {
  mailThread: Mail,
  calendarEvent: CalendarDays,
  mcpItem: GitPullRequest,
  intent: CircleDot,
};

const FACT_META: Record<FactStatus, { label: string; tone: Tone }> = {
  verified: { label: 'Verified', tone: 'success' },
  candidate: { label: 'Candidate', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

const AREA_KIND_LABEL: Record<string, string> = {
  work: 'Work',
  life_admin: 'Life admin',
  personal: 'Personal',
  learning: 'Learning',
  candidate: 'Candidate',
};

const SMART_LABEL: Record<string, string> = {
  needs_reply: 'Needs reply',
  main: 'Main',
  review: 'Review',
  noise: 'Noise',
  finance_admin: 'Finance / admin',
};

const SOURCE_LABEL: Record<string, string> = {
  mailThread: 'Email',
  calendarEvent: 'Calendar',
  mcpItem: 'Integration',
  intent: 'Capture',
  userConfirmation: 'Confirmed',
};

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function priorityWord(priority: number): string {
  return priority <= 1 ? 'High' : priority === 2 ? 'Medium' : 'Low';
}

function priorityTone(priority: number): Tone {
  return priority <= 1 ? 'danger' : priority === 2 ? 'warning' : 'neutral';
}

function confidenceLabel(value: number): string {
  if (value >= 0.85) return 'High confidence';
  if (value >= 0.6) return 'Medium confidence';
  return 'Low confidence';
}

/* ------------------------------------------------------------------ */
/* Shared presentation                                                 */
/* ------------------------------------------------------------------ */

function Surface({
  title,
  count,
  controls,
  children,
}: {
  title: string;
  count?: number;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="@container flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 pb-3 pt-12 md:pt-4">
        <h1 className="shrink-0 font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
          {title}
        </h1>
        {typeof count === 'number' ? (
          <span className="text-[12px] tabular-nums text-[var(--color-text-faint)]">{count}</span>
        ) : null}
        {controls ? <div className="ml-auto flex items-center gap-2">{controls}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </section>
  );
}

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function PanelHeader({ title, count, trailing }: { title: string; count?: number; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
      <h2 className="text-[12.5px] font-semibold text-[var(--color-text)]">{title}</h2>
      {typeof count === 'number' ? (
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{count}</span>
      ) : null}
      {trailing ? <div className="ml-auto flex items-center gap-1.5">{trailing}</div> : null}
    </div>
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
            'h-7 px-2.5 text-[12px] font-medium transition-colors',
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

function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  if (tone === 'neutral') {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)]">
        {children}
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: `var(--color-${tone})`, backgroundColor: `var(--color-${tone}-soft)` }}
    >
      {children}
    </span>
  );
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: tone === 'neutral' ? 'var(--color-text-faint)' : `var(--color-${tone})` }}
    />
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-[12.5px]">
      <dt className="w-24 shrink-0 text-[var(--color-text-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[var(--color-text)]">{children}</dd>
    </div>
  );
}

// Evidence is deliberately quiet: small text chips that name the source object,
// sitting next to the claim they support (sources-near-claims), never a badge row.
function Evidence({ refs }: { refs: SourceRef[] }) {
  if (!refs.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {refs.map((ref) => (
        <span
          key={ref.id}
          className="max-w-full truncate rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]"
          title={ref.prompt ?? ref.label}
        >
          {ref.label ?? SOURCE_LABEL[ref.kind] ?? titleCase(ref.kind)}
        </span>
      ))}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="py-1.5 text-[12px] text-[var(--color-text-faint)]">{children}</p>;
}

function selectRowClass(selected: boolean): string {
  return cn(
    'w-full border-l-2 px-3 py-2.5 text-left transition-colors',
    selected
      ? 'border-l-[var(--color-accent)] bg-[var(--color-accent-soft)]'
      : 'border-l-transparent hover:bg-[var(--color-hover-soft)]',
  );
}

/* ------------------------------------------------------------------ */
/* Areas - the context graph as an index + inspector                   */
/* ------------------------------------------------------------------ */

// Unassigned lost its rail slot in the nav collapse; this is its front door.
// The count keeps the review habit honest without demanding a daily visit.
function ReviewQueueButton() {
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const pending = buildReviewQueue().length;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setPrimaryView('unassigned')}
      className="gap-1.5"
    >
      <Inbox className="size-3.5" />
      Review queue
      {pending ? <span className="ml-0.5 tabular-nums text-[var(--color-text-faint)]">{pending}</span> : null}
    </Button>
  );
}

function AreasSurface() {
  const summaries = buildAreaSummaries();
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const [selectedId, setSelectedId] = useState(summaries[0]?.area.id ?? '');
  const [setupOpen, setSetupOpen] = useState(false);
  // Setup writes are session-local: drafted facts keyed by area, plus any area
  // drafts the user creates/edits. Nothing pretends to persist (issue #72).
  const [setupDrafts, setSetupDrafts] = useState<DraftedFact[]>([]);
  const [confirmedSetupFacts, setConfirmedSetupFacts] = useState<Set<string>>(() => new Set());
  const [areaDrafts, setAreaDrafts] = useState<AreaDraft[]>([]);
  const setupOverlay = useMemo(
    () => ({ drafts: setupDrafts, confirmedFactIds: confirmedSetupFacts }),
    [setupDrafts, confirmedSetupFacts],
  );
  const progress = useMemo(() => summarizeSetupProgress(setupOverlay), [setupOverlay]);
  const visible =
    filter === 'all' ? summaries : summaries.filter((s) => s.factCounts.candidate > 0 || s.reviewCount > 0);
  const activeId = visible.some((summary) => summary.area.id === selectedId)
    ? selectedId
    : (visible[0]?.area.id ?? '');
  const detail = activeId ? buildAreaDetail(activeId) : null;
  const draftsForActive = setupDrafts.filter((draft) => draft.areaId === activeId);

  return (
    <Surface
      title="Areas"
      controls={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSetupOpen(true)}
            className="gap-1.5"
          >
            <Pencil className="size-3.5" />
            Set up context
            <span className="ml-0.5 tabular-nums text-[var(--color-text-faint)]">
              {progress.completeAreas}/{progress.totalAreas}
            </span>
          </Button>
          <ReviewQueueButton />
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'review', label: 'Needs review' },
            ]}
          />
        </>
      }
    >
      <AreaSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        drafts={setupDrafts}
        onDraftFact={(draft) => setSetupDrafts((prev) => [...prev, draft])}
        confirmedFacts={confirmedSetupFacts}
        onConfirmFact={(factKey) => setConfirmedSetupFacts((prev) => new Set(prev).add(factKey))}
        onRemoveDraft={(draft) => {
          setSetupDrafts((prev) => prev.filter((entry) => entry !== draft));
          setConfirmedSetupFacts((prev) => {
            const next = new Set(prev);
            next.delete(draftedFactKey(draft));
            return next;
          });
        }}
        areaDrafts={areaDrafts}
        onAreaDraft={(draft) =>
          setAreaDrafts((prev) => {
            const next = prev.filter((entry) => entry.id !== draft.id);
            return [...next, draft];
          })
        }
      />
      <div className="grid gap-4 @[900px]:grid-cols-[minmax(0,320px)_minmax(0,1fr)] @[900px]:items-start">
        <Panel className="@[900px]:max-h-[calc(100vh-9.5rem)]">
          <PanelHeader title="Areas" count={visible.length} />
          <div className="min-h-0 overflow-y-auto">
            {visible.map(({ area, factCounts, linkedCount, reviewCount }) => {
              const needsReview = factCounts.candidate > 0 || reviewCount > 0;
              return (
                <button
                  key={area.id}
                  type="button"
                  onClick={() => setSelectedId(area.id)}
                  className={selectRowClass(area.id === activeId)}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-display text-[13.5px] font-semibold text-[var(--color-text)]">
                      {area.name}
                    </span>
                    {area.status !== 'active' ? <Tag tone="neutral">{titleCase(area.status)}</Tag> : null}
                  </div>
                  <div className="mt-0.5 flex items-center gap-x-2 text-[11.5px] text-[var(--color-text-faint)]">
                    <span>{AREA_KIND_LABEL[area.kind] ?? titleCase(area.kind)}</span>
                    <span aria-hidden>/</span>
                    <span>{factCounts.verified} verified</span>
                    {needsReview ? (
                      <span className="ml-auto inline-flex items-center gap-1 text-[var(--color-warning)]">
                        <Dot tone="warning" />
                        {factCounts.candidate + reviewCount} to review
                      </span>
                    ) : (
                      <span className="ml-auto">{linkedCount} linked</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {detail ? <AreaInspector detail={detail} drafts={draftsForActive} /> : null}
      </div>
    </Surface>
  );
}

function AreaInspector({ detail, drafts = [] }: { detail: AreaDetail; drafts?: DraftedFact[] }) {
  const { verified, candidate, rejected } = detail.facts;
  const lensCounts = useMemo(() => buildAreaLensCounts(detail.area.id), [detail.area.id]);
  return (
    <Panel>
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate font-display text-[17px] font-semibold text-[var(--color-text)]">
            {detail.area.name}
          </h2>
          <Tag tone={detail.area.status === 'active' ? 'success' : 'neutral'}>
            {titleCase(detail.area.status)}
          </Tag>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          {detail.area.description}
        </p>
        <dl className="mt-2 @[560px]:grid @[560px]:grid-cols-2 @[560px]:gap-x-8">
          <Prop label="Kind">{AREA_KIND_LABEL[detail.area.kind] ?? titleCase(detail.area.kind)}</Prop>
          <Prop label="Priority">
            {detail.area.priority} / {priorityWord(detail.area.priority)}
          </Prop>
          <Prop label="Facts">
            {verified.length} verified / {candidate.length} candidate / {rejected.length} rejected
          </Prop>
          <Prop label="Linked">{detail.links.length} artifacts</Prop>
          {detail.projects.length ? (
            <Prop label="Projects">
              {detail.projects.map((project) => project.title ?? titleCase(project.status)).join(', ')}
            </Prop>
          ) : null}
        </dl>
      </div>

      <Tabs defaultValue="lenses" className="gap-0">
        <div className="border-b border-[var(--color-border)] px-3 py-2">
          <TabsList className="h-8">
            <TabsTrigger value="lenses" className="text-[12.5px]">
              Lenses
            </TabsTrigger>
            <TabsTrigger value="facts" className="text-[12.5px]">
              Facts
            </TabsTrigger>
            <TabsTrigger value="changes" className="text-[12.5px]">
              Changes
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="lenses" className="p-0">
          <AreaLensView areaId={detail.area.id} counts={lensCounts} />
        </TabsContent>
        <TabsContent value="facts" className="px-4 py-3">
          <FactsTab detail={detail} drafts={drafts} />
        </TabsContent>
        <TabsContent value="changes" className="px-4 py-3">
          <ChangesTab detail={detail} />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}

function FactsTab({ detail, drafts = [] }: { detail: AreaDetail; drafts?: DraftedFact[] }) {
  const [filter, setFilter] = useState<'all' | FactStatus>('all');
  // Local, optimistic verify/reject so the human-control loop is real in the
  // prototype without pretending to persist anything.
  const [decided, setDecided] = useState<Record<string, FactStatus>>({});
  const total = detail.facts.verified.length + detail.facts.candidate.length + detail.facts.rejected.length;
  if (total === 0 && drafts.length === 0)
    return <Note>No facts recorded for this area yet. Use "Set up context" to add some.</Note>;

  const statuses: FactStatus[] = filter === 'all' ? ['verified', 'candidate', 'rejected'] : [filter];

  return (
    <div className="flex flex-col gap-3">
      {drafts.length ? (
        <section className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 py-2">
          <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">
            Added in setup <span className="font-normal text-[var(--color-text-faint)]">/ this session</span>
          </h3>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {drafts.map((draft) => (
              <div
                key={`${draft.areaId}-${draft.kind}-${draft.value}`}
                className="flex items-start gap-2 py-1.5"
              >
                <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--color-text)]">
                  {draft.value}
                </p>
                <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
                  {titleCase(draft.kind)}
                </span>
                <Tag tone={draft.status === 'verified' ? 'success' : 'warning'}>
                  {FACT_META[draft.status].label}
                </Tag>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {total === 0 ? null : (
        <>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${total}` },
              { value: 'verified', label: 'Verified' },
              { value: 'candidate', label: 'Candidate' },
              { value: 'rejected', label: 'Rejected' },
            ]}
          />
          {statuses.map((status) => {
            const facts = detail.facts[status];
            if (!facts.length) return null;
            return (
              <section key={status} className="flex flex-col">
                <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">
                  {FACT_META[status].label}{' '}
                  <span className="text-[var(--color-text-faint)]">{facts.length}</span>
                </h3>
                <div className="divide-y divide-[var(--color-border)]">
                  {facts.map((fact) => (
                    <FactRow
                      key={fact.id}
                      fact={fact}
                      decision={decided[fact.id]}
                      onDecide={(next) =>
                        setDecided((prev) => {
                          if (!next) {
                            const { [fact.id]: _removed, ...rest } = prev;
                            return rest;
                          }
                          return { ...prev, [fact.id]: next };
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function FactRow({
  fact,
  decision,
  onDecide,
}: {
  fact: AreaFact;
  decision?: FactStatus;
  onDecide: (status: FactStatus | null) => void;
}) {
  const confirmation = fact.confirmationRefs[0];
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-3">
        <p
          className={cn(
            'min-w-0 flex-1 text-[13px] leading-snug text-[var(--color-text)]',
            fact.status === 'rejected' && 'text-[var(--color-text-muted)] line-through',
          )}
        >
          {fact.value}
        </p>
        <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{titleCase(fact.kind)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Evidence refs={fact.sourceRefs} />
        {confirmation?.confirmedAt ? (
          <span className="text-[11px] text-[var(--color-success)]">
            Confirmed {fmtDate(confirmation.confirmedAt)}
          </span>
        ) : null}
      </div>
      {fact.status === 'candidate' ? (
        decision ? (
          <p className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
            {decision === 'verified' ? 'Verified by you' : 'Rejected by you'} /{' '}
            <button
              type="button"
              onClick={() => onDecide(null)}
              className="text-[var(--color-accent)] hover:underline"
            >
              Undo
            </button>
          </p>
        ) : (
          <div className="mt-1.5 flex gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => onDecide('verified')}>
              Verify
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
              onClick={() => onDecide('rejected')}
            >
              Reject
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issue #75 - Area lenses                                             */
/* ------------------------------------------------------------------ */
/* One area, sliced the way you'd actually work it. The lens strip is a */
/* dense horizontal tab row (Jira/Slite pattern) with live counts; each  */
/* row carries an explicit verified/candidate marker and - where the     */
/* assignment can be wrong - a quiet correction affordance so the human  */
/* always keeps the steering wheel.                                      */

const LENS_ICON: Record<AreaLensKey, LucideIcon> = {
  needs_reply: Mail,
  open_loops: CircleDot,
  tasks: ListChecks,
  events: CalendarDays,
  files_links: Link2,
  people: Users,
  noise: BellOff,
};

const LENS_ITEM_ICON: Record<AreaLensItemKind, LucideIcon> = {
  mailThread: Mail,
  calendarEvent: CalendarDays,
  mcpItem: GitPullRequest,
  intent: CircleDot,
  task: ListChecks,
  fact: AtSign,
  person: Users,
  project: Layers,
};

const LENS_EMPTY: Record<AreaLensKey, string> = {
  needs_reply: 'Nothing waiting on a reply here.',
  open_loops: 'No open loops - every assignment and fact is settled.',
  tasks: 'No tasks in this area yet.',
  events: 'No events linked to this area.',
  files_links: 'No files, repos, or links captured yet.',
  people: 'No people recorded for this area.',
  noise: 'Nothing has been marked as noise here.',
};

function AreaLensView({ areaId, counts }: { areaId: string; counts: Record<AreaLensKey, number> }) {
  const [lens, setLens] = useState<AreaLensKey>('needs_reply');
  // Session-local reassignment: each correction maps an item id to where the
  // user moved it, so the optimistic change is legible and undoable.
  const [moves, setMoves] = useState<Record<string, string>>({});
  const items = useMemo(() => buildAreaLens(areaId, lens), [areaId, lens]);

  return (
    <div className="flex flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-3 py-2">
        {AREA_LENSES.map((entry) => {
          const active = entry.key === lens;
          const count = counts[entry.key] ?? 0;
          const Icon = LENS_ICON[entry.key];
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setLens(entry.key)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-soft)] hover:text-[var(--color-text)]',
              )}
            >
              <Icon className="size-3.5" />
              {entry.label}
              {count ? (
                <span
                  className={cn(
                    'tabular-nums',
                    active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]',
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="px-4 py-3">
        {items.length === 0 ? (
          <Note>{LENS_EMPTY[lens]}</Note>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {items.map((item) => (
              <LensRow
                key={`${item.kind}-${item.id}`}
                areaId={areaId}
                item={item}
                movedTo={moves[item.id]}
                onMove={(areaName) => setMoves((prev) => ({ ...prev, [item.id]: areaName }))}
                onUndo={() => setMoves((prev) => withoutKey(prev, item.id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const LENS_STATUS_TONE: Record<'verified' | 'candidate' | 'rejected', Tone> = {
  verified: 'success',
  candidate: 'warning',
  rejected: 'danger',
};

function LensRow({
  areaId,
  item,
  movedTo,
  onMove,
  onUndo,
}: {
  areaId: string;
  item: AreaLensItem;
  movedTo?: string;
  onMove: (areaName: string) => void;
  onUndo: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const Icon = LENS_ITEM_ICON[item.kind] ?? CircleDot;
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]',
                item.status === 'rejected' && 'text-[var(--color-text-muted)] line-through',
              )}
            >
              {item.title}
            </span>
            {item.status ? <Tag tone={LENS_STATUS_TONE[item.status]}>{titleCase(item.status)}</Tag> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--color-text-faint)]">
            <span className="min-w-0 truncate">{item.detail}</span>
            {item.meta ? (
              <>
                <span aria-hidden>/</span>
                <span className="min-w-0 truncate">{item.meta}</span>
              </>
            ) : null}
          </div>
          {item.reason ? (
            <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{item.reason}</p>
          ) : null}

          {item.canReassign ? (
            movedTo ? (
              <p className="mt-1 text-[11.5px] text-[var(--color-success)]">
                Moved to {movedTo} /{' '}
                <button type="button" onClick={onUndo} className="text-[var(--color-accent)] hover:underline">
                  Undo
                </button>
              </p>
            ) : picking ? (
              <div className="mt-1.5">
                <AreaPicker
                  excludeAreaId={areaId}
                  onPick={(area) => {
                    onMove(area.name);
                    setPicking(false);
                  }}
                  onCancel={() => setPicking(false)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="mt-1 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              >
                Wrong area? Move it
              </button>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Compact, reusable area chooser used by the lens correction affordance and the
// triage decision flow. Lists real areas so a correction routes somewhere true.
function AreaPicker({
  excludeAreaId,
  onPick,
  onCancel,
  includeNew = false,
  onNew,
}: {
  excludeAreaId?: string;
  onPick: (area: Area) => void;
  onCancel: () => void;
  includeNew?: boolean;
  onNew?: () => void;
}) {
  const options = areas.filter((area) => area.id !== excludeAreaId);
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2">
      {options.map((area) => (
        <button
          key={area.id}
          type="button"
          onClick={() => onPick(area)}
          className="rounded-full border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {area.name}
        </button>
      ))}
      {includeNew && onNew ? (
        <button
          type="button"
          onClick={onNew}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-control-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus className="size-3" />
          New area
        </button>
      ) : null}
      <button
        type="button"
        onClick={onCancel}
        className="ml-auto inline-flex size-5 items-center justify-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
        aria-label="Cancel"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function ChangesTab({ detail }: { detail: AreaDetail }) {
  if (!detail.changes.length) return <Note>No recorded changes for this area.</Note>;
  return (
    <ol className="flex flex-col gap-3">
      {detail.changes.map((change) => (
        <li key={change.id} className="flex gap-3">
          <span className="mt-1.5">
            <Dot tone="success" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-[var(--color-text)]">{change.summary}</p>
            <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
              {fmtDateTime(change.completedAt)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Intents - capture -> questions -> plan -> approval                  */
/* ------------------------------------------------------------------ */

const INTENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  needs_questions: { label: 'Needs answers', tone: 'warning' },
  needs_confirmation: { label: 'Needs confirmation', tone: 'warning' },
  draft_plan_ready: { label: 'Plan ready', tone: 'success' },
  draft: { label: 'Draft', tone: 'neutral' },
};

function intentStatusTag(status: string) {
  const meta = INTENT_STATUS[status] ?? { label: titleCase(status), tone: 'neutral' as Tone };
  return <Tag tone={meta.tone}>{meta.label}</Tag>;
}

type IntentLifecycle = 'active' | 'staged' | 'paused' | 'archived' | 'done';

interface IntentCorrection {
  areaId?: string;
  classification?: ParsedIntentKind;
  projectNeed?: ProjectNeed;
  facts?: Record<string, 'confirmed' | 'dismissed'>;
}

const EMPTY_ANSWERS: Record<string, string> = {};
const EMPTY_CORRECTION: IntentCorrection = {};

const LIFECYCLE_META: Record<Exclude<IntentLifecycle, 'active'>, { label: string; tone: Tone }> = {
  staged: { label: 'Staged', tone: 'accent' },
  paused: { label: 'Paused', tone: 'neutral' },
  archived: { label: 'Archived', tone: 'neutral' },
  done: { label: 'Done', tone: 'success' },
};

const INTENT_KIND_LABEL: Record<ParsedIntentKind, string> = {
  task: 'Task',
  project: 'Project',
  idea: 'Idea',
  obligation: 'Obligation',
  errand: 'Errand',
  habit: 'Habit',
  relationship: 'Relationship',
  area_setup: 'Area setup',
  replan: 'Replan',
};

const INTENT_KIND_OPTIONS = Object.keys(INTENT_KIND_LABEL) as ParsedIntentKind[];

const PROJECT_NEED_LABEL: Record<ProjectNeed, string> = {
  task_only: 'Just a task',
  project: 'Project',
  unknown: 'Not sure',
  context_update: 'Context only',
};

const PROPOSED_KIND_META: Record<ProposedArtifact['kind'], { label: string; icon: LucideIcon }> = {
  task: { label: 'Task', icon: ListChecks },
  calendar_event: { label: 'Event', icon: CalendarPlus },
  project: { label: 'Project', icon: Layers },
  email_draft: { label: 'Email draft', icon: Mail },
  area_fact: { label: 'Area fact', icon: AtSign },
};

const CONTEXT_TONE: Record<'verified' | 'candidate' | 'rejected', Tone> = {
  verified: 'success',
  candidate: 'warning',
  rejected: 'danger',
};

type IntentsMode = 'intents' | 'board' | 'approvals';

// Lifted apply state per intent (issue #81). The pane stays a dumb renderer; the
// surface owns the async tool call so the application result survives switching
// between intents and modes. Nothing here fakes success - a failed call keeps the
// error and falls back to the locally computed preview.
interface ApplyOutcome {
  phase: 'applying' | 'applied' | 'failed';
  result?: ApplyResult;
  error?: string;
}

function IntentsSurface({
  captured = [],
  onNewIntent,
}: {
  captured?: CapturedIntent[];
  onNewIntent?: () => void;
}) {
  // Captures dumped this session sit on top of the seeded backlog and run through
  // the SAME parser as seeded intents, so a fresh thought is shown as a parsed
  // object (area, plan, questions) - just flagged as a session capture - instead
  // of a dead raw holding panel.
  const all = useMemo<Intent[]>(() => [...captured, ...intents], [captured]);
  const capturedIds = useMemo(() => new Set(captured.map((intent) => intent.id)), [captured]);
  const [mode, setMode] = useState<IntentsMode>('intents');
  const [filter, setFilter] = useState<'all' | 'captured' | 'needs_you' | 'ready'>('all');
  const [selectedId, setSelectedId] = useState(all[0]?.id ?? '');
  // Corrections, answers, lifecycle, and apply results are session-local and keyed
  // per intent so moving between intents keeps your in-flight work, and nothing
  // touches Convex or the seed (issue #79: correct, answer, and apply are local).
  const [answersByIntent, setAnswersByIntent] = useState<Record<string, Record<string, string>>>({});
  const [corrections, setCorrections] = useState<Record<string, IntentCorrection>>({});
  const [lifecycle, setLifecycle] = useState<Record<string, IntentLifecycle>>({});
  const [applyByIntent, setApplyByIntent] = useState<Record<string, ApplyOutcome>>({});
  const capturedParsedById = useMemo(
    () => new Map(captured.map((intent) => [intent.id, parseIntent(intent)] as const)),
    [captured],
  );

  const visible = all.filter((intent) => {
    const parsedCapture = capturedParsedById.get(intent.id);
    const status = parsedCapture?.intent.status ?? intent.status;
    if (filter === 'captured') return capturedIds.has(intent.id);
    if (filter === 'needs_you') return status === 'needs_questions' || status === 'needs_confirmation';
    if (filter === 'ready') return status === 'draft_plan_ready';
    return true;
  });
  const activeId = visible.some((intent) => intent.id === selectedId) ? selectedId : (visible[0]?.id ?? '');
  const activeCaptured = captured.find((intent) => intent.id === activeId) ?? null;

  const bench = useMemo(
    () => (activeId && !activeCaptured ? buildIntentWorkbench(activeId) : null),
    [activeId, activeCaptured],
  );
  const parsed = useMemo<ParsedIntent | null>(
    () =>
      activeCaptured
        ? (capturedParsedById.get(activeCaptured.id) ?? parseIntent(activeCaptured))
        : (bench?.parsed ?? null),
    [activeCaptured, bench, capturedParsedById],
  );
  const approvals = bench?.approvals ?? [];

  const applyPlan = async (intentId: string, input: AlbatrossApplicationInput) => {
    setApplyByIntent((prev) => ({ ...prev, [intentId]: { phase: 'applying' } }));
    try {
      const result = await callTool<ApplyResult>('albatross_apply_intent_plan', {
        intentId: input.intentId,
        intentText: input.intentText,
        areaId: input.areaId,
        account: input.account,
        projectMode: input.projectMode,
        plan: input.plan,
      });
      setApplyByIntent((prev) => ({ ...prev, [intentId]: { phase: 'applied', result } }));
    } catch (error) {
      setApplyByIntent((prev) => ({
        ...prev,
        [intentId]: { phase: 'failed', error: error instanceof Error ? error.message : String(error) },
      }));
    }
  };

  const filterOptions: { value: 'all' | 'captured' | 'needs_you' | 'ready'; label: string }[] = [
    { value: 'all', label: 'All' },
    ...(captured.length ? [{ value: 'captured' as const, label: 'Captured' }] : []),
    { value: 'needs_you', label: 'Needs you' },
    { value: 'ready', label: 'Plan ready' },
  ];

  return (
    <Surface
      title="Intents"
      controls={
        <>
          {mode === 'intents' && onNewIntent ? (
            <Button type="button" size="sm" onClick={onNewIntent} className="gap-1.5">
              <Plus className="size-4" />
              New Intent
            </Button>
          ) : null}
          {mode === 'intents' ? (
            <Segmented value={filter} onChange={setFilter} options={filterOptions} />
          ) : null}
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'intents', label: 'Intents' },
              { value: 'board', label: 'Board' },
              { value: 'approvals', label: 'Approvals' },
            ]}
          />
        </>
      }
    >
      {mode === 'board' ? <WorkBoard /> : null}
      {mode === 'approvals' ? <ApprovalQueuePanel /> : null}
      <div
        className={cn(
          'grid gap-4 @[900px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)] @[900px]:items-start',
          mode !== 'intents' && 'hidden',
        )}
      >
        <Panel className="@[900px]:max-h-[calc(100vh-9.5rem)]">
          <PanelHeader title="Captured" count={visible.length} />
          <div className="min-h-0 overflow-y-auto">
            {visible.map((intent) => {
              const isCaptured = capturedIds.has(intent.id);
              const parsedCapture = capturedParsedById.get(intent.id);
              const questionCount = parsedCapture?.intent.questions.length ?? intent.questions.length;
              const status = lifecycle[intent.id] ?? 'active';
              const lifeMeta = status === 'active' ? null : LIFECYCLE_META[status];
              return (
                <button
                  key={intent.id}
                  type="button"
                  onClick={() => setSelectedId(intent.id)}
                  className={selectRowClass(intent.id === activeId)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--color-text-faint)]">
                      {intent.source === 'voice' ? 'Voice' : 'Text'}
                    </span>
                    <span className="ml-auto">
                      {lifeMeta ? (
                        <Tag tone={lifeMeta.tone}>{lifeMeta.label}</Tag>
                      ) : isCaptured ? (
                        <Tag tone="accent">Just captured</Tag>
                      ) : (
                        intentStatusTag(intent.status)
                      )}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-[var(--color-text)]">
                    {intent.rawInput}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--color-text-faint)]">
                    <span className="min-w-0 truncate">
                      {isCaptured
                        ? `Session capture / ${areaName(parsedCapture?.likelyAreaId)}`
                        : areaName(intent.likelyAreaId)}
                    </span>
                    {questionCount ? (
                      <span className="ml-auto shrink-0 text-[var(--color-warning)]">
                        {questionCount} question{questionCount === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>

        {parsed ? (
          <IntentPane
            key={activeId}
            parsed={parsed}
            approvals={approvals}
            isCaptured={Boolean(activeCaptured)}
            answers={answersByIntent[activeId] ?? EMPTY_ANSWERS}
            onAnswer={(questionId, value) =>
              setAnswersByIntent((prev) => ({
                ...prev,
                [activeId]: { ...(prev[activeId] ?? {}), [questionId]: value },
              }))
            }
            correction={corrections[activeId] ?? EMPTY_CORRECTION}
            onCorrect={(patch) =>
              setCorrections((prev) => ({ ...prev, [activeId]: { ...(prev[activeId] ?? {}), ...patch } }))
            }
            status={lifecycle[activeId] ?? 'active'}
            onStatus={(next) => setLifecycle((prev) => ({ ...prev, [activeId]: next }))}
            application={applyByIntent[activeId]}
            onApply={(input) => applyPlan(activeId, input)}
            onResetApply={() => setApplyByIntent((prev) => withoutKey(prev, activeId))}
          />
        ) : (
          <Panel>
            <div className="px-4 py-3">
              <Note>Select a captured thought to see how Albatross parsed it.</Note>
            </div>
          </Panel>
        )}
      </div>
    </Surface>
  );
}

// The Intent pane is the operational object view: the raw capture stays close as
// evidence, but the pane leads with how Albatross read it, what it would create,
// and every place the user can correct or steer it. The Apply plan section (issue
// #81) runs safe artifacts through real tools and routes human-facing writes to
// the approval queue - nothing here pretends to send.
function IntentPane({
  parsed,
  approvals,
  isCaptured,
  answers,
  onAnswer,
  correction,
  onCorrect,
  status,
  onStatus,
  application,
  onApply,
  onResetApply,
}: {
  parsed: ParsedIntent;
  approvals: Approval[];
  isCaptured: boolean;
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
  correction: IntentCorrection;
  onCorrect: (patch: Partial<IntentCorrection>) => void;
  status: IntentLifecycle;
  onStatus: (next: IntentLifecycle) => void;
  application?: ApplyOutcome;
  onApply: (input: AlbatrossApplicationInput) => void;
  onResetApply: () => void;
}) {
  const { intent, plan, contextPack } = parsed;
  const questions = intent.questions;
  const effectiveArea = correction.areaId ?? parsed.likelyAreaId;
  const effectiveClass = correction.classification ?? parsed.classification;
  const effectiveNeed = correction.projectNeed ?? parsed.projectNeed;
  const openQuestions = questions.filter((question) => !answers[question.id]?.trim());
  const allAnswered = openQuestions.length === 0;
  const hasStageableDraft =
    plan.proposedArtifacts.some((artifact) => artifact.status !== 'blocked') ||
    plan.digitalActions.length > 0 ||
    plan.physicalActions.length > 0;
  const canStage = allAnswered && hasStageableDraft;
  const blocked = !canStage;

  // The apply input mirrors what the tool will receive, so the local preview and
  // the real call agree on what runs, what queues, and what stays unresolved.
  const applyInput = useMemo<AlbatrossApplicationInput>(
    () => buildApplyInput(parsed, effectiveArea, effectiveNeed),
    [parsed, effectiveArea, effectiveNeed],
  );
  const applyPreview = useMemo(() => buildAlbatrossApplicationPlan(applyInput), [applyInput]);

  const questionsNode = questions.length ? (
    <QuestionsSection questions={questions} answers={answers} onAnswer={onAnswer} />
  ) : null;
  const planNode = (
    <ProposedPlanSection plan={plan} effectiveNeed={effectiveNeed} originalNeed={parsed.projectNeed} />
  );

  return (
    <Panel>
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-text-faint)]">
          {isCaptured ? <Tag tone="accent">Session capture</Tag> : null}
          <span>{intent.source === 'voice' ? 'Voice capture' : 'Typed capture'}</span>
          <span aria-hidden>/</span>
          <span>{fmtDateTime(intent.capturedAt)}</span>
          <span className="ml-auto">
            {status === 'active' ? (
              intentStatusTag(intent.status)
            ) : (
              <Tag tone={LIFECYCLE_META[status].tone}>{LIFECYCLE_META[status].label}</Tag>
            )}
          </span>
        </div>
        <RawCapture text={intent.rawInput} source={intent.source} />
        {intent.assumptions.length ? (
          <div className="mt-3">
            <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Understood</h3>
            <ul className="mt-1 flex flex-col gap-0.5">
              {intent.assumptions.map((assumption) => (
                <li key={assumption} className="flex gap-2 text-[12px] text-[var(--color-text-muted)]">
                  <span className="text-[var(--color-text-faint)]">-</span>
                  <span className="min-w-0 flex-1">{assumption}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <IntentReadSection
        effectiveArea={effectiveArea}
        effectiveClass={effectiveClass}
        effectiveNeed={effectiveNeed}
        parsed={parsed}
        correction={correction}
        onCorrect={onCorrect}
      />

      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Outcome</h3>
        <p className="mt-1 text-[13px] leading-snug text-[var(--color-text)]">{plan.outcome}</p>
        {blocked ? (
          <p className="mt-1 text-[12px] text-[var(--color-warning)]">
            {openQuestions.length
              ? `Blocked until you answer ${openQuestions.length} question${openQuestions.length === 1 ? '' : 's'} below.`
              : 'Blocked until the draft has at least one action or object that can be staged.'}
          </p>
        ) : null}
      </div>

      {/* When blocked, the questions Albatross needs come before the plan;
          otherwise the plan leads and questions sit underneath as refinements. */}
      {blocked ? (
        <>
          {questionsNode}
          {planNode}
        </>
      ) : (
        <>
          {planNode}
          {questionsNode}
        </>
      )}

      <ContextSection contextPack={contextPack} correction={correction} onCorrect={onCorrect} />

      <ReferencesSection plan={plan} />

      {approvals.length ? <ApprovalsSection approvals={approvals} /> : null}

      <ApplyPlanSection
        preview={applyPreview}
        application={application}
        canApply={canStage}
        openQuestionCount={openQuestions.length}
        onApply={() => onApply(applyInput)}
        onReset={onResetApply}
      />

      <LifecycleFooter
        status={status}
        onStatus={onStatus}
        canApply={canStage}
        openQuestionCount={openQuestions.length}
      />
    </Panel>
  );
}

// The raw dump is the source of truth, so it stays one click away as evidence -
// collapsed by default with an inline preview so the pane can lead with the read.
function RawCapture({ text, source }: { text: string; source: 'text' | 'voice' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-[var(--color-text-faint)] transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-muted)]">
          {source === 'voice' ? 'Transcript' : 'Raw capture'}
        </span>
        {open ? null : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-faint)]">{text}</span>
        )}
      </button>
      {open ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-[var(--color-bg-subtle)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-text)]">
          {text}
        </p>
      ) : null}
    </div>
  );
}

// Every value Albatross inferred is shown with a correction control right beside
// it - area, type, and the project-vs-task scope are the user's to override, all
// session-local. This is the "keep the human steering" rule the issue calls for.
function IntentReadSection({
  effectiveArea,
  effectiveClass,
  effectiveNeed,
  parsed,
  correction,
  onCorrect,
}: {
  effectiveArea: string;
  effectiveClass: ParsedIntentKind;
  effectiveNeed: ProjectNeed;
  parsed: ParsedIntent;
  correction: IntentCorrection;
  onCorrect: (patch: Partial<IntentCorrection>) => void;
}) {
  const [pickingArea, setPickingArea] = useState(false);
  const needOptions = useMemo(() => {
    const base: { value: ProjectNeed; label: string }[] = [
      { value: 'task_only', label: PROJECT_NEED_LABEL.task_only },
      { value: 'project', label: PROJECT_NEED_LABEL.project },
      { value: 'unknown', label: PROJECT_NEED_LABEL.unknown },
    ];
    if (parsed.projectNeed === 'context_update' || effectiveNeed === 'context_update') {
      base.unshift({ value: 'context_update', label: PROJECT_NEED_LABEL.context_update });
    }
    return base;
  }, [parsed.projectNeed, effectiveNeed]);

  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Albatross read</h3>
        <span className="text-[11px] text-[var(--color-text-faint)]">/ correct anything wrong</span>
      </div>

      <dl className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="w-16 shrink-0 text-[var(--color-text-faint)]">Area</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="font-medium text-[var(--color-text)]">
              {effectiveArea ? areaName(effectiveArea) : 'Unassigned'}
            </span>
            {correction.areaId ? (
              <button
                type="button"
                onClick={() => onCorrect({ areaId: undefined })}
                className="text-[11.5px] text-[var(--color-accent)] hover:underline"
              >
                Reset
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPickingArea((prev) => !prev)}
                className="text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              >
                Change
              </button>
            )}
          </dd>
        </div>
        {pickingArea ? (
          <AreaPicker
            excludeAreaId={effectiveArea || undefined}
            onPick={(area) => {
              onCorrect({ areaId: area.id });
              setPickingArea(false);
            }}
            onCancel={() => setPickingArea(false)}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="w-16 shrink-0 text-[var(--color-text-faint)]">Type</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <select
              value={effectiveClass}
              onChange={(event) => onCorrect({ classification: event.target.value as ParsedIntentKind })}
              aria-label="Intent type"
              className="h-7 rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2 text-[12px] text-[var(--color-text)] outline-none focus-visible:border-[var(--color-accent)]"
            >
              {INTENT_KIND_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {INTENT_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
            {correction.classification ? (
              <button
                type="button"
                onClick={() => onCorrect({ classification: undefined })}
                className="text-[11.5px] text-[var(--color-accent)] hover:underline"
              >
                Reset to {INTENT_KIND_LABEL[parsed.classification]}
              </button>
            ) : null}
          </dd>
        </div>

        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="w-16 shrink-0 pt-1 text-[var(--color-text-faint)]">Scope</dt>
          <dd className="flex min-w-0 flex-1 flex-col gap-1">
            <Segmented<ProjectNeed>
              value={effectiveNeed}
              onChange={(value) => onCorrect({ projectNeed: value })}
              options={needOptions}
            />
            <p className="text-[11.5px] text-[var(--color-text-muted)]">
              {effectiveNeed === 'project'
                ? 'Treated as a multi-step project.'
                : effectiveNeed === 'task_only'
                  ? 'Kept as a single task - no project is created.'
                  : effectiveNeed === 'context_update'
                    ? 'Updates area context before any task is created.'
                    : 'Scope still open - apply keeps this lightweight until you decide.'}
              {correction.projectNeed ? (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => onCorrect({ projectNeed: undefined })}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    Reset to {PROJECT_NEED_LABEL[parsed.projectNeed]}
                  </button>
                </>
              ) : null}
            </p>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function QuestionsSection({
  questions,
  answers,
  onAnswer,
}: {
  questions: IntentQuestion[];
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
}) {
  const answered = questions.filter((question) => answers[question.id]?.trim()).length;
  const done = answered === questions.length;
  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Answer to unblock</h3>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
          {answered}/{questions.length}
        </span>
        {done ? (
          <span className="ml-auto text-[11.5px] text-[var(--color-success)]">All answered</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {questions.map((question) => (
          <QuestionRow
            key={question.id}
            question={question}
            value={answers[question.id]}
            onAnswer={(value) => onAnswer(question.id, value)}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  value,
  onAnswer,
}: {
  question: IntentQuestion;
  value?: string;
  onAnswer: (value: string) => void;
}) {
  const labelId = `intent-question-${question.id}`;
  return (
    <fieldset className="border-0 p-0">
      <legend id={labelId} className="text-[12.5px] text-[var(--color-text)]">
        {question.text}
      </legend>
      <div className="mt-1.5">
        {question.kind === 'short_text' ? (
          <input
            type="text"
            aria-labelledby={labelId}
            value={value ?? ''}
            onChange={(event) => onAnswer(event.target.value)}
            placeholder="Type an answer"
            className="h-8 w-full max-w-sm rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus-visible:border-[var(--color-accent)]"
          />
        ) : question.kind === 'confirm' ? (
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="xs"
              variant={value === 'yes' ? 'default' : 'outline'}
              onClick={() => onAnswer('yes')}
            >
              Yes
            </Button>
            <Button
              type="button"
              size="xs"
              variant={value === 'no' ? 'secondary' : 'outline'}
              onClick={() => onAnswer('no')}
            >
              No
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(question.choices ?? []).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => onAnswer(choice)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                  value === choice
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'border-[var(--color-control-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
                )}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
      </div>
    </fieldset>
  );
}

function ProposedPlanSection({
  plan,
  effectiveNeed,
  originalNeed,
}: {
  plan: GeneratedIntentPlan;
  effectiveNeed: ProjectNeed;
  originalNeed: ProjectNeed;
}) {
  const hasProjectDraft = plan.proposedArtifacts.some((artifact) => artifact.kind === 'project');
  // The user can disagree with the project/task scope; reflect that honestly
  // against the draft objects without regenerating the plan (issue #81 applies).
  const scopeNote =
    effectiveNeed !== originalNeed && hasProjectDraft
      ? effectiveNeed === 'task_only'
        ? 'You marked this as just a task - the project draft below would be dropped on apply.'
        : effectiveNeed === 'project'
          ? 'You marked this as a project - the task drafts below would roll up under it on apply.'
          : null
      : null;

  const hasBody =
    plan.digitalActions.length > 0 || plan.physicalActions.length > 0 || plan.proposedArtifacts.length > 0;

  if (!hasBody) {
    return (
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Proposed plan</h3>
        <Note>No actions drafted yet - answer the questions and this fills in.</Note>
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Proposed plan</h3>
        <span className="ml-auto text-[11px] text-[var(--color-text-faint)]">
          Drafts only / nothing runs yet
        </span>
      </div>
      {scopeNote ? <p className="mt-1 text-[12px] text-[var(--color-warning)]">{scopeNote}</p> : null}

      {plan.digitalActions.length ? (
        <div className="mt-3">
          <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Digital actions</h4>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {plan.digitalActions.map((action) => {
              const Icon =
                action.kind === 'calendar_event'
                  ? CalendarPlus
                  : action.kind === 'email_draft'
                    ? Mail
                    : ListChecks;
              return (
                <div key={`${action.kind}-${action.title}`} className="flex items-center gap-2 py-1.5">
                  <Icon className="size-4 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text)]">
                    {action.title}
                  </span>
                  {action.durationMinutes ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                      {action.durationMinutes}m
                    </span>
                  ) : null}
                  {action.priority ? (
                    <Tag tone={priorityTone(action.priority)}>P{action.priority}</Tag>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {plan.physicalActions.length ? (
        <div className="mt-3">
          <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Away from the app</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {plan.physicalActions.map((step) => (
              <li key={step} className="flex gap-2 text-[12.5px] text-[var(--color-text)]">
                <span className="text-[var(--color-text-faint)]">-</span>
                <span className="min-w-0 flex-1">{step}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan.proposedArtifacts.length ? (
        <div className="mt-3">
          <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Objects it would create</h4>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {plan.proposedArtifacts.map((artifact) => (
              <ProposedArtifactRow key={`${artifact.kind}-${artifact.title}`} artifact={artifact} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProposedArtifactRow({ artifact }: { artifact: ProposedArtifact }) {
  const meta = PROPOSED_KIND_META[artifact.kind];
  const Icon = meta.icon;
  const blocked = artifact.status === 'blocked';
  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-text)]">
              {artifact.title}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{meta.label}</span>
            <Tag tone={blocked ? 'warning' : 'neutral'}>{blocked ? 'Blocked' : 'Proposed'}</Tag>
          </div>
          {artifact.areaId ? (
            <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">{areaName(artifact.areaId)}</p>
          ) : null}
          {artifact.detail ? (
            <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{artifact.detail}</p>
          ) : null}
          {artifact.sourceRefs.length ? (
            <div className="mt-1">
              <Evidence refs={artifact.sourceRefs} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// What Albatross already knows about this intent, split verified / candidate /
// conflict so confidence is never blurred. Candidate area facts carry confirm or
// dismiss controls - the same human boundary the rest of the app keeps; a person
// or relationship never auto-promotes to a verified fact.
function ContextSection({
  contextPack,
  correction,
  onCorrect,
}: {
  contextPack: ParsedIntent['contextPack'];
  correction: IntentCorrection;
  onCorrect: (patch: Partial<IntentCorrection>) => void;
}) {
  const { verified, candidate, contradictions, noResults } = contextPack;
  const factDecision = (id: string) => correction.facts?.[id];
  const setFact = (id: string, decision: 'confirmed' | 'dismissed' | null) => {
    const next = { ...(correction.facts ?? {}) };
    if (decision) next[id] = decision;
    else delete next[id];
    onCorrect({ facts: next });
  };

  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">What Albatross already knows</h3>
      {noResults ? (
        <Note>No related context found - nothing is being assumed about this yet.</Note>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {verified.length ? (
            <ContextGroup
              label="Verified"
              tone="success"
              items={verified}
              factDecision={factDecision}
              onFact={setFact}
            />
          ) : null}
          {candidate.length ? (
            <ContextGroup
              label="Candidate / unconfirmed"
              tone="warning"
              items={candidate}
              factDecision={factDecision}
              onFact={setFact}
            />
          ) : null}
          {contradictions.length ? (
            <ContextGroup
              label="Possible conflicts"
              tone="danger"
              items={contradictions}
              factDecision={factDecision}
              onFact={setFact}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ContextGroup({
  label,
  tone,
  items,
  factDecision,
  onFact,
}: {
  label: string;
  tone: Tone;
  items: IntentContextItem[];
  factDecision: (id: string) => 'confirmed' | 'dismissed' | undefined;
  onFact: (id: string, decision: 'confirmed' | 'dismissed' | null) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5">
        <Dot tone={tone} />
        <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">{label}</h4>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{items.length}</span>
      </div>
      <div className="mt-1 divide-y divide-[var(--color-border)]">
        {items.map((item) => (
          <ContextItemRow
            key={`${item.kind}-${item.id}`}
            item={item}
            decision={factDecision(item.id)}
            onFact={onFact}
          />
        ))}
      </div>
    </section>
  );
}

function ContextItemRow({
  item,
  decision,
  onFact,
}: {
  item: IntentContextItem;
  decision?: 'confirmed' | 'dismissed';
  onFact: (id: string, decision: 'confirmed' | 'dismissed' | null) => void;
}) {
  const tone = CONTEXT_TONE[item.status as 'verified' | 'candidate' | 'rejected'] ?? 'neutral';
  const correctable = item.kind === 'areaFact' && item.status === 'candidate';
  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-[var(--color-text)]">
          {item.title}
        </span>
        <Tag tone={tone}>{titleCase(item.status)}</Tag>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--color-text-faint)]">
        <span className="min-w-0 truncate">{item.detail}</span>
        <span aria-hidden>/</span>
        <span>{confidenceLabel(item.confidence)}</span>
      </div>
      <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{item.reason}</p>
      {item.sourceRefs.length ? (
        <div className="mt-1">
          <Evidence refs={item.sourceRefs} />
        </div>
      ) : null}
      {correctable ? (
        decision ? (
          <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
            {decision === 'confirmed' ? 'Confirmed by you' : 'Dismissed by you'} /{' '}
            <button
              type="button"
              onClick={() => onFact(item.id, null)}
              className="text-[var(--color-accent)] hover:underline"
            >
              Undo
            </button>
          </p>
        ) : (
          <div className="mt-1.5 flex gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => onFact(item.id, 'confirmed')}>
              Confirm
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
              onClick={() => onFact(item.id, 'dismissed')}
            >
              Dismiss
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

// Source evidence stays close to the claims, and official references are shown as
// real links when a URL exists (IRS, State Dept) so the grounding is checkable.
function ReferencesSection({ plan }: { plan: GeneratedIntentPlan }) {
  const officialIds = new Set(plan.officialSourceRefs.map((ref) => ref.id));
  const otherRefs = plan.sourceRefs.filter((ref) => !officialIds.has(ref.id));
  if (!plan.officialSourceRefs.length && !otherRefs.length) return null;
  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">References</h3>
      {plan.officialSourceRefs.length ? (
        <div className="mt-2">
          <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Official sources</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {plan.officialSourceRefs.map((ref) => (
              <li key={ref.id} className="text-[12.5px]">
                {ref.url ? (
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    {ref.label ?? ref.url}
                  </a>
                ) : (
                  <span className="text-[var(--color-text)]">{ref.label ?? ref.id}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {otherRefs.length ? (
        <div className="mt-2">
          <h4 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Evidence</h4>
          <Evidence refs={otherRefs} />
        </div>
      ) : null}
    </div>
  );
}

// Lifecycle controls: apply (stage for approval), pause, archive, done - all
// session-local. Apply is disabled until every question is answered, and the copy
// is explicit that staging does not execute anything (issue #81 owns real apply).
function LifecycleFooter({
  status,
  onStatus,
  canApply,
  openQuestionCount,
}: {
  status: IntentLifecycle;
  onStatus: (next: IntentLifecycle) => void;
  canApply: boolean;
  openQuestionCount: number;
}) {
  if (status !== 'active') {
    const meta = LIFECYCLE_META[status];
    const copy: Record<Exclude<IntentLifecycle, 'active'>, string> = {
      staged: 'Staged for approval - nothing has been sent, scheduled, or created.',
      paused: 'Paused - held out of your active intents. Nothing was executed.',
      archived: 'Archived - hidden from the active list. Nothing was executed.',
      done: 'Marked done for this session. Nothing was executed.',
    };
    const revertLabel =
      status === 'staged'
        ? 'Unstage'
        : status === 'done'
          ? 'Reopen'
          : status === 'paused'
            ? 'Resume'
            : 'Restore';
    return (
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={meta.tone}>{meta.label}</Tag>
          <p className="min-w-0 flex-1 text-[12px] text-[var(--color-text-muted)]">{copy[status]}</p>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => onStatus('active')}>
            <Play className="size-3.5" />
            {revertLabel}
          </Button>
          {status === 'staged' ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onStatus('done')}>
              <CheckCircle2 className="size-3.5" />
              Mark done
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={() => onStatus('paused')}>
          <Pause className="size-3.5" />
          Pause
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onStatus('archived')}>
          <Archive className="size-3.5" />
          Archive
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onStatus('done')}>
          <CheckCircle2 className="size-3.5" />
          Done
        </Button>
        <span className="ml-auto text-[11.5px] text-[var(--color-text-faint)]">
          {canApply
            ? 'Pause or archive are local to this session.'
            : `Answer ${openQuestionCount} question${openQuestionCount === 1 ? '' : 's'} above to apply.`}
        </span>
      </div>
    </div>
  );
}

function ApprovalsSection({ approvals }: { approvals: Approval[] }) {
  // undefined = still awaiting a decision; the human gate is right next to the
  // action it controls: explicit control plus correction.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});

  return (
    <div className="px-4 py-3">
      <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Approval gate</h3>
      <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
        Nothing is sent or scheduled until you approve it.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {approvals.map((approval) => {
          const decided = approval.id in decisions;
          const Icon = approval.kind === 'calendar_invite' ? CalendarPlus : Mail;
          return (
            <Confirmation
              key={approval.id}
              approval={decided ? { id: approval.id, approved: decisions[approval.id] } : { id: approval.id }}
              state={decided ? 'approval-responded' : 'approval-requested'}
              className="gap-1.5 border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-[12.5px] font-medium text-[var(--color-text)]">{approval.title}</span>
              </div>
              <ConfirmationTitle>{approval.summary}</ConfirmationTitle>
              <ConfirmationRequest>
                <p className="text-[11px] text-[var(--color-text-faint)]">
                  Requires your approval / {approval.undoWindowSeconds}s undo after it runs.
                </p>
              </ConfirmationRequest>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => setDecisions((prev) => ({ ...prev, [approval.id]: false }))}
                >
                  Reject
                </ConfirmationAction>
                <ConfirmationAction
                  onClick={() => setDecisions((prev) => ({ ...prev, [approval.id]: true }))}
                >
                  Approve
                </ConfirmationAction>
              </ConfirmationActions>
              <ConfirmationAccepted>
                <p className="text-[12px] text-[var(--color-success)]">
                  Approved - will run with a {approval.undoWindowSeconds}s undo window.{' '}
                  <button
                    type="button"
                    onClick={() => setDecisions((prev) => withoutKey(prev, approval.id))}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    Undo
                  </button>
                </p>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <p className="text-[12px] text-[var(--color-text-muted)]">
                  Rejected - nothing was sent.{' '}
                  <button
                    type="button"
                    onClick={() => setDecisions((prev) => withoutKey(prev, approval.id))}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    Undo
                  </button>
                </p>
              </ConfirmationRejected>
            </Confirmation>
          );
        })}
      </div>
    </div>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/* ------------------------------------------------------------------ */
/* Issue #81 - Apply plan through real tools and operation batches     */
/* ------------------------------------------------------------------ */
/* The pane builds the same application input the tool receives, so the */
/* local preview and the real call agree on what runs, what queues for  */
/* approval, and what stays unresolved. The button calls the tool; the   */
/* result is reported verbatim - operation batch, applied artifacts,     */
/* queued approvals, unresolved reasons - with no fabricated success.    */

interface ApplyResultOperation {
  operationId?: string;
  tool?: string;
  title?: string;
  artifactId?: string;
  projectId?: string;
}
interface ApplyResultApproval {
  approvalId?: string;
  title?: string;
  toolName?: string;
}
interface ApplyResult {
  ok: boolean;
  operationBatchId: string;
  applicationId?: string;
  projectId?: string;
  operations: ApplyResultOperation[];
  approvals: ApplyResultApproval[];
  unresolved: AlbatrossApplicationStep[];
}

const STEP_KIND_META: Record<AlbatrossArtifactKind, { label: string; icon: LucideIcon }> = {
  project: { label: 'Project', icon: Layers },
  task: { label: 'Task', icon: ListChecks },
  calendar_event: { label: 'Event', icon: CalendarPlus },
  email_draft: { label: 'Draft', icon: Mail },
  email_send: { label: 'Send email', icon: Mail },
  calendar_rsvp: { label: 'RSVP', icon: CalendarDays },
  area_fact: { label: 'Area fact', icon: AtSign },
};

function stepKindMeta(kind: string) {
  return STEP_KIND_META[kind as AlbatrossArtifactKind] ?? { label: titleCase(kind), icon: CircleDot };
}

function shortBatch(id: string): string {
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}

function projectModeFor(need: ProjectNeed): AlbatrossProjectMode {
  if (need === 'project') return 'project';
  if (need === 'task_only' || need === 'context_update') return 'task_only';
  return 'auto';
}

function buildApplyInput(parsed: ParsedIntent, areaId: string, need: ProjectNeed): AlbatrossApplicationInput {
  const plan = parsed.plan;
  return {
    intentId: parsed.intent.id,
    intentText: parsed.intent.rawInput,
    areaId: areaId || undefined,
    projectMode: projectModeFor(need),
    plan: {
      id: plan.id,
      intentId: plan.intentId,
      outcome: plan.outcome,
      digitalActions: plan.digitalActions.map((action) => ({
        kind: action.kind as AlbatrossArtifactKind,
        title: action.title,
        areaId: action.areaId,
        priority: action.priority as 1 | 2 | 3 | undefined,
        durationMinutes: action.durationMinutes,
        startIso: action.startIso,
        endIso: action.endIso,
        account: action.account,
        to: action.to,
        cc: action.cc,
        bcc: action.bcc,
        subject: action.subject,
        body: action.body,
        html: action.html,
        attendees: action.attendees,
        calendarId: action.calendarId,
        eventId: action.eventId,
        rsvpStatus: action.rsvpStatus,
        description: action.description,
        sourceRefs: action.sourceRefs,
      })),
      proposedArtifacts: plan.proposedArtifacts.map((artifact) => ({
        kind: artifact.kind as AlbatrossArtifactKind,
        title: artifact.title,
        areaId: artifact.areaId,
        detail: artifact.detail,
        status: artifact.status,
        sourceRefs: artifact.sourceRefs,
      })),
      sourceRefs: plan.sourceRefs,
    },
  };
}

function StepLine({ title, kind, note, tone }: { title: string; kind: string; note?: string; tone?: Tone }) {
  const meta = stepKindMeta(kind);
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text)]">{title}</span>
          <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{meta.label}</span>
        </div>
        {note ? (
          <p
            className="mt-0.5 text-[11.5px] leading-snug"
            style={{ color: tone ? `var(--color-${tone})` : 'var(--color-text-muted)' }}
          >
            {note}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StepGroup({
  label,
  tone,
  count,
  children,
}: {
  label: string;
  tone: Tone;
  count: number;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section>
      <div className="flex items-center gap-1.5">
        <Dot tone={tone} />
        <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">{label}</h4>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{count}</span>
      </div>
      <div className="mt-0.5 divide-y divide-[var(--color-border)]">{children}</div>
    </section>
  );
}

function ApplyPlanSection({
  preview,
  application,
  canApply,
  openQuestionCount,
  onApply,
  onReset,
}: {
  preview: AlbatrossApplicationPlan;
  application?: ApplyOutcome;
  canApply: boolean;
  openQuestionCount: number;
  onApply: () => void;
  onReset: () => void;
}) {
  const { executableSteps, approvalSteps, unresolved } = preview;
  const runnable = executableSteps.length + approvalSteps.length;
  const phase = application?.phase;
  const result = application?.result;

  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Apply plan</h3>
        <span className="text-[11px] text-[var(--color-text-faint)]">
          / safe actions run now, human-facing ones go to approvals
        </span>
      </div>

      {phase === 'applied' && result ? (
        <ApplyResultView result={result} onReset={onReset} />
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-2.5">
            <StepGroup label="Will run now" tone="success" count={executableSteps.length}>
              {executableSteps.map((step) => (
                <StepLine key={step.id} title={step.title} kind={step.kind} />
              ))}
            </StepGroup>
            <StepGroup label="Needs your approval" tone="warning" count={approvalSteps.length}>
              {approvalSteps.map((step) => (
                <StepLine
                  key={step.id}
                  title={step.title}
                  kind={step.kind}
                  note="Human-facing - queued for approval, not sent."
                />
              ))}
            </StepGroup>
            <StepGroup label="Can't run yet" tone="danger" count={unresolved.length}>
              {unresolved.map((step) => (
                <StepLine
                  key={step.id}
                  title={step.title}
                  kind={step.kind}
                  note={step.blockedReason}
                  tone="danger"
                />
              ))}
            </StepGroup>
            {runnable + unresolved.length === 0 ? (
              <Note>This plan has nothing to apply yet - it's drafts and context only.</Note>
            ) : null}
          </div>

          {phase === 'failed' && application?.error ? (
            <div className="mt-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-3 py-2">
              <p className="text-[12px] font-medium text-[var(--color-danger)]">
                Apply failed - nothing was created.
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-text-muted)]">
                {application.error}
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">
                The breakdown above is the local preview of what would have run.
              </p>
            </div>
          ) : null}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canApply || runnable === 0 || phase === 'applying'}
                    onClick={onApply}
                    className="gap-1.5"
                  >
                    {phase === 'applying' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="size-3.5" />
                    )}
                    {phase === 'failed' ? 'Try again' : phase === 'applying' ? 'Applying' : 'Apply plan'}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!canApply
                  ? `Answer ${openQuestionCount} question${openQuestionCount === 1 ? '' : 's'} above first.`
                  : runnable === 0
                    ? 'Every step is unresolved - fix the reasons above before applying.'
                    : `Runs ${executableSteps.length} now and queues ${approvalSteps.length} for approval.`}
              </TooltipContent>
            </Tooltip>
            <span className="text-[11px] text-[var(--color-text-faint)]">
              One operation batch / approvals never auto-send.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function ApplyResultView({ result, onReset }: { result: ApplyResult; onReset: () => void }) {
  const applied = result.operations.length;
  const queued = result.approvals.length;
  const unresolved = result.unresolved.length;
  const statusTone: Tone = applied && (queued || unresolved) ? 'warning' : applied ? 'success' : 'neutral';
  const statusLabel =
    applied && (queued || unresolved) ? 'Partially applied' : applied ? 'Applied' : 'Queued';
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={statusTone}>{statusLabel}</Tag>
        <span
          className="text-[11px] tabular-nums text-[var(--color-text-faint)]"
          title={result.operationBatchId}
        >
          Batch {shortBatch(result.operationBatchId)}
        </span>
        <button
          type="button"
          onClick={onReset}
          className="ml-auto text-[11.5px] text-[var(--color-accent)] hover:underline"
        >
          Apply again
        </button>
      </div>

      <StepGroup label="Applied" tone="success" count={applied}>
        {result.operations.map((operation, index) => (
          <StepLine
            key={operation.operationId || operation.artifactId || `op-${index}`}
            title={operation.title || operation.tool || 'Operation'}
            kind={operation.tool === 'albatross_create_project' ? 'project' : 'task'}
            note={operation.tool}
          />
        ))}
      </StepGroup>
      <StepGroup label="Queued for approval" tone="warning" count={queued}>
        {result.approvals.map((approval, index) => (
          <StepLine
            key={approval.approvalId || `ap-${index}`}
            title={approval.title || 'Approval'}
            kind={approval.toolName === 'calendar_create_event' ? 'calendar_event' : 'email_send'}
            note="Waiting in the approval queue."
          />
        ))}
      </StepGroup>
      <StepGroup label="Unresolved" tone="danger" count={unresolved}>
        {result.unresolved.map((step, index) => (
          <StepLine
            key={step.id || `un-${index}`}
            title={step.title}
            kind={step.kind}
            note={step.blockedReason}
            tone="danger"
          />
        ))}
      </StepGroup>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issue #82 - Universal human approval queue                          */
/* ------------------------------------------------------------------ */
/* Everything Albatross wants to do to another human or provider waits  */
/* here, not buried inside one intent. Live tool-returned approvals sit  */
/* above the seeded ones; each card names where it came from and offers  */
/* approve / reject / review with a short undo window after a decision.  */

interface ApprovalView {
  id: string;
  title: string;
  summary?: string;
  kind: string;
  areaId?: string;
  intentId?: string;
  projectId?: string;
  source: 'live' | 'seed';
  undoWindowSeconds: number;
  status?: string;
  undoExpiresAt?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

const APPROVAL_KIND_LABEL: Record<string, string> = {
  email_draft: 'Email',
  email_send: 'Send email',
  calendar_invite: 'Calendar invite',
  calendar_rsvp: 'RSVP',
  external_action: 'External action',
};

function mapLiveApproval(row: Record<string, any>): ApprovalView {
  return {
    id: String(row._id ?? row.id ?? ''),
    title: row.title ?? 'Approval',
    summary: row.detail ?? row.risk,
    kind: row.kind ?? 'external_action',
    areaId: row.areaId,
    intentId: row.intentId,
    projectId: row.projectId,
    source: 'live',
    undoWindowSeconds: 10,
    status: row.status,
    undoExpiresAt: row.undoExpiresAt,
    toolName: row.toolName,
    toolArgs: row.toolArgs,
  };
}

const SEED_APPROVAL_VIEWS: ApprovalView[] = approvalQueue.map((approval) => ({
  id: approval.id,
  title: approval.title,
  summary: approval.summary,
  kind: approval.kind,
  areaId: approval.areaId,
  intentId: approval.sourceIntentId,
  source: 'seed',
  undoWindowSeconds: approval.undoWindowSeconds,
}));

type ApprovalDecision = 'approved' | 'rejected' | 'undone';

function decisionForApproval(view: ApprovalView, decisions: Record<string, ApprovalDecision>) {
  if (view.source === 'live' && (view.status === 'approved' || view.status === 'rejected')) {
    return view.status;
  }
  return decisions[view.id];
}

function ApprovalQueuePanel() {
  const [live, setLive] = useState<ApprovalView[] | null>(null);
  const [recentLive, setRecentLive] = useState<Record<string, ApprovalView>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [cardError, setCardError] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const load = () => {
      callTool<{ approvals: Record<string, any>[] }>('albatross_list_approval_queue', {})
        .then((res) => {
          if (!active) return;
          const nextLive = (res?.approvals ?? []).map(mapLiveApproval);
          const liveIds = new Set(nextLive.map((view) => view.id));
          setLive(nextLive);
          setRecentLive((prev) =>
            Object.fromEntries(
              Object.entries(prev).filter(
                ([id, view]) => !liveIds.has(id) && (view.undoExpiresAt ?? 0) > Date.now(),
              ),
            ),
          );
          setLoadError(null);
        })
        .catch((error) => {
          if (active) setLoadError(error instanceof Error ? error.message : String(error));
        });
    };
    load();
    const intervalId = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const decide = async (view: ApprovalView, action: ApprovalDecision) => {
    const priorDecision = decisionForApproval(view, decisions);
    if (view.source === 'live' && action === 'undone' && priorDecision !== 'approved') {
      setCardError((prev) => ({
        ...prev,
        [view.id]: 'Rejected approvals cannot be reopened from this queue yet.',
      }));
      return;
    }
    setBusy((prev) => ({ ...prev, [view.id]: true }));
    try {
      let decidedApproval: Record<string, any> | undefined;
      if (view.source === 'live') {
        if (action === 'approved') {
          const result = await callTool<{ approval?: Record<string, any> }>('albatross_approve_action', {
            approvalId: view.id,
          });
          decidedApproval = result?.approval;
        } else if (action === 'rejected') {
          await callTool('albatross_reject_action', { approvalId: view.id });
        } else if (priorDecision === 'approved') {
          await callTool('albatross_undo_approval', { approvalId: view.id });
        }
      }
      if (view.source === 'live' && action === 'approved') {
        const updatedView = {
          ...view,
          status: 'approved',
          undoExpiresAt: decidedApproval?.undoExpiresAt,
        };
        setLive(
          (prev) =>
            prev?.map((item) =>
              item.id === view.id
                ? {
                    ...item,
                    status: 'approved',
                    undoExpiresAt: decidedApproval?.undoExpiresAt,
                  }
                : item,
            ) ?? prev,
        );
        if (decidedApproval?.undoExpiresAt) {
          setRecentLive((prev) => ({
            ...prev,
            [view.id]: updatedView,
          }));
        }
      }
      if (view.source === 'live' && action === 'rejected') {
        setLive(
          (prev) =>
            prev?.map((item) => (item.id === view.id ? { ...item, status: 'rejected' } : item)) ?? prev,
        );
      }
      if (view.source === 'live' && action === 'undone') {
        setLive((prev) => prev?.filter((item) => item.id !== view.id) ?? prev);
        setRecentLive((prev) => withoutKey(prev, view.id));
      }
      setDecisions((prev) =>
        action === 'undone' ? withoutKey(prev, view.id) : { ...prev, [view.id]: action },
      );
      setCardError((prev) => withoutKey(prev, view.id));
    } catch (error) {
      setCardError((prev) => ({
        ...prev,
        [view.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusy((prev) => withoutKey(prev, view.id));
    }
  };

  const liveViews = live ?? [];
  const liveIds = new Set(liveViews.map((view) => view.id));
  const recentViews = Object.values(recentLive).filter(
    (view) => !liveIds.has(view.id) && (view.undoExpiresAt ?? 0) > Date.now(),
  );
  const all = [...liveViews, ...recentViews, ...SEED_APPROVAL_VIEWS];
  const pendingCount = all.filter((view) => !decisionForApproval(view, decisions)).length;

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Approval queue"
          count={pendingCount}
          trailing={
            live === null && !loadError ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-faint)]">
                <Loader2 className="size-3 animate-spin" />
                Syncing
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-faint)]">
                <ShieldCheck className="size-3" />
                {liveViews.length} live / {SEED_APPROVAL_VIEWS.length} seeded
              </span>
            )
          }
        />
        <div className="px-4 py-3">
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Everything Albatross wants to do to another person or provider waits here. Nothing leaves the app
            until you approve it.
          </p>
          {loadError ? (
            <p className="mt-1.5 text-[11.5px] text-[var(--color-text-faint)]">
              Live queue unavailable ({loadError}). Showing seeded approvals only.
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2">
            {all.length ? (
              all.map((view) => (
                <ApprovalCard
                  key={`${view.source}-${view.id}`}
                  view={view}
                  decision={decisionForApproval(view, decisions)}
                  busy={busy[view.id]}
                  error={cardError[view.id]}
                  onDecide={(action) => decide(view, action)}
                />
              ))
            ) : (
              <div className="flex items-center gap-2 py-4 text-[12px] text-[var(--color-text-faint)]">
                <Inbox className="size-4" />
                Nothing is waiting for your approval.
              </div>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ApprovalCard({
  view,
  decision,
  busy,
  error,
  onDecide,
}: {
  view: ApprovalView;
  decision?: ApprovalDecision;
  busy?: boolean;
  error?: string;
  onDecide: (action: ApprovalDecision) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const Icon = view.kind === 'calendar_invite' || view.kind === 'calendar_rsvp' ? CalendarPlus : Mail;
  const sourceBits = [
    view.areaId ? areaName(view.areaId) : null,
    view.intentId ? `Intent ${view.intentId.replace(/^intent[_-]?/, '')}` : null,
    view.projectId ? 'Project' : null,
  ].filter(Boolean) as string[];
  const liveUndoSeconds =
    view.source === 'live' && view.undoExpiresAt && view.undoExpiresAt > Date.now()
      ? Math.max(1, Math.ceil((view.undoExpiresAt - Date.now()) / 1000))
      : 0;
  const canUndoApproved = view.source === 'seed' || liveUndoSeconds > 0;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 text-[12.5px] font-medium text-[var(--color-text)]">
              {view.title}
            </span>
            <Tag tone="neutral">{APPROVAL_KIND_LABEL[view.kind] ?? titleCase(view.kind)}</Tag>
            <Tag tone={view.source === 'live' ? 'accent' : 'neutral'}>
              {view.source === 'live' ? 'Live' : 'Seeded'}
            </Tag>
          </div>
          {view.summary ? (
            <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-text-muted)]">{view.summary}</p>
          ) : null}
          {sourceBits.length ? (
            <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
              {sourceBits.join(' / ')}
            </p>
          ) : null}

          {reviewing && view.toolArgs ? (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-[var(--color-bg-elevated)] px-2 py-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
              {JSON.stringify(view.toolArgs, null, 2)}
            </pre>
          ) : null}

          {error ? <p className="mt-1 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {decision === 'approved' ? (
              <>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-success)]">
                  <Check className="size-3.5" />
                  Approved
                </span>
                {canUndoApproved ? (
                  <>
                    <span className="text-[11px] text-[var(--color-text-faint)]">
                      {view.source === 'live' ? liveUndoSeconds : view.undoWindowSeconds}s to undo
                    </span>
                    <button
                      type="button"
                      onClick={() => onDecide('undone')}
                      className="text-[11.5px] text-[var(--color-accent)] hover:underline"
                    >
                      Undo
                    </button>
                  </>
                ) : null}
              </>
            ) : decision === 'rejected' ? (
              <>
                <span className="text-[11.5px] text-[var(--color-text-muted)]">Rejected - nothing sent.</span>
                {view.source === 'seed' ? (
                  <button
                    type="button"
                    onClick={() => onDecide('undone')}
                    className="text-[11.5px] text-[var(--color-accent)] hover:underline"
                  >
                    Undo
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="xs"
                  disabled={busy}
                  onClick={() => onDecide('approved')}
                  className="gap-1"
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  Approve
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                  onClick={() => onDecide('rejected')}
                >
                  Reject
                </Button>
                <button
                  type="button"
                  onClick={() => setReviewing((prev) => !prev)}
                  className="text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                >
                  {reviewing ? 'Hide details' : 'Review'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issues #83 + #84 - Work board, sprints, and the project pane        */
/* ------------------------------------------------------------------ */
/* A GitHub/Linear-style operational board over seed tasks and projects: */
/* Kanban columns, area and project groupings, a derived weekly sprint,  */
/* and a project pane that reads more like an issue tracker than a       */
/* dashboard. Standalone tasks render even without project/sprint data.  */

type BoardView = 'kanban' | 'areas' | 'projects' | 'sprints';

function WorkBoard() {
  const [view, setView] = useState<BoardView>('kanban');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'kanban', label: 'Kanban' },
            { value: 'areas', label: 'Areas' },
            { value: 'projects', label: 'Projects' },
            { value: 'sprints', label: 'Sprints' },
          ]}
        />
        <span className="text-[11.5px] text-[var(--color-text-faint)]">
          Read model / your seeded tasks and projects
        </span>
      </div>
      {view === 'kanban' ? <KanbanView /> : null}
      {view === 'areas' ? <AreaBoardView /> : null}
      {view === 'projects' ? <ProjectsView /> : null}
      {view === 'sprints' ? <SprintsView /> : null}
    </div>
  );
}

function BoardTaskCard({ card }: { card: BoardCard }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 shadow-[var(--shadow-soft)]">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-[var(--color-text)]">
          {card.title}
        </span>
        {card.priority ? <Tag tone={priorityTone(card.priority)}>P{card.priority}</Tag> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-faint)]">
        <span className="min-w-0 truncate">{card.areaName}</span>
        <span aria-hidden>/</span>
        <span className="min-w-0 truncate">{card.projectTitle ?? 'Standalone'}</span>
      </div>
    </div>
  );
}

function BoardTaskRow({ card, showArea = true }: { card: BoardCard; showArea?: boolean }) {
  return (
    <div className="py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-[var(--color-text)]">
          {card.title}
        </span>
        {card.priority ? <Tag tone={priorityTone(card.priority)}>P{card.priority}</Tag> : null}
        <Tag tone="neutral">{card.statusLabel}</Tag>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-faint)]">
        {showArea ? (
          <>
            <span>{card.areaName}</span>
            <span aria-hidden>/</span>
          </>
        ) : null}
        <span className="min-w-0 truncate">{card.projectTitle ?? 'Standalone'}</span>
      </div>
    </div>
  );
}

function KanbanView() {
  const columns = useMemo(() => buildKanbanColumns(), []);
  return (
    <div className="grid gap-3 @[640px]:grid-cols-2 @[1100px]:grid-cols-4">
      {columns.map((column) => (
        <div
          key={column.key}
          className="flex min-w-0 flex-col gap-2 rounded-lg bg-[var(--color-bg-subtle)] p-2.5"
        >
          <div className="flex items-center gap-2 px-0.5">
            <h3 className="text-[12px] font-semibold text-[var(--color-text)]">{column.label}</h3>
            <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
              {column.cards.length}
            </span>
          </div>
          {column.cards.length ? (
            column.cards.map((card) => <BoardTaskCard key={card.id} card={card} />)
          ) : (
            <p className="px-0.5 py-1 text-[11.5px] text-[var(--color-text-faint)]">Nothing here.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function AreaBoardView() {
  const groups = useMemo(() => buildAreaTaskGroups(), []);
  return (
    <div className="grid gap-4 @[800px]:grid-cols-2 @[800px]:items-start">
      {groups.map((group) => (
        <Panel key={group.areaId || 'unassigned'}>
          <PanelHeader title={group.areaName} count={group.cards.length} />
          <div className="divide-y divide-[var(--color-border)] px-3">
            {group.cards.map((card) => (
              <BoardTaskRow key={card.id} card={card} showArea={false} />
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function CountChips({ counts }: { counts: ProjectPaneModel['counts'] }) {
  const chips: { label: string; value: number; tone: Tone }[] = [
    { label: 'To do', value: counts.todo, tone: 'neutral' },
    { label: 'In progress', value: counts.inProgress, tone: 'accent' },
    { label: 'In review', value: counts.review, tone: 'warning' },
    { label: 'Done', value: counts.done, tone: 'success' },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-bg-muted)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]"
        >
          <Dot tone={chip.tone} />
          {chip.label}
          <span className="tabular-nums text-[var(--color-text-faint)]">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}

function ProjectsView() {
  const groups = useMemo(() => buildProjectTaskGroups(), []);
  const realProjects = groups.filter((group) => group.project);
  const [selectedId, setSelectedId] = useState(realProjects[0]?.project?.id ?? '');
  const pane = useMemo(() => (selectedId ? buildProjectPane(selectedId) : null), [selectedId]);

  return (
    <div className="grid gap-4 @[900px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)] @[900px]:items-start">
      <Panel className="@[900px]:max-h-[calc(100vh-12rem)]">
        <PanelHeader title="Projects" count={realProjects.length} />
        <div className="min-h-0 overflow-y-auto">
          {groups.map((group) => {
            const project = group.project;
            const selected = Boolean(project && project.id === selectedId);
            return (
              <button
                key={project?.id ?? 'standalone'}
                type="button"
                disabled={!project}
                onClick={() => project && setSelectedId(project.id)}
                className={cn(selectRowClass(selected), !project && 'cursor-default opacity-80')}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">
                    {group.title}
                  </span>
                  {project ? (
                    <Tag tone={PROJECT_STATUS_TONE[project.status] ?? 'neutral'}>
                      {titleCase(project.status)}
                    </Tag>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-x-2 text-[11.5px] text-[var(--color-text-faint)]">
                  <span>{project ? areaName(project.areaId) : 'No project'}</span>
                  <span aria-hidden>/</span>
                  <span>
                    {group.cards.length} task{group.cards.length === 1 ? '' : 's'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      {pane ? (
        <ProjectPane pane={pane} />
      ) : (
        <Panel>
          <div className="px-4 py-3">
            <Note>Select a project to open its pane.</Note>
          </div>
        </Panel>
      )}
    </div>
  );
}

const PROJECT_STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  paused: 'neutral',
  done: 'accent',
  archived: 'neutral',
};

type ProjectAffordance = 'active' | 'paused' | 'archived' | 'done';

function ProjectPane({ pane }: { pane: ProjectPaneModel }) {
  const { project, cards, intents: linkedIntents, evidence, approvals, completions, counts } = pane;
  // Status changes are a local affordance only - issue #83 explicitly says not to
  // fake backend operations, so a moved status shows here and says so plainly.
  const [localStatus, setLocalStatus] = useState<ProjectAffordance | null>(null);
  const status = localStatus ?? (project.status as ProjectAffordance);

  return (
    <Panel>
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-display text-[16px] font-semibold text-[var(--color-text)]">
            {project.title ?? titleCase(project.status)}
          </h2>
          <Tag tone={PROJECT_STATUS_TONE[status] ?? 'neutral'}>{titleCase(status)}</Tag>
        </div>
        {project.outcome ? (
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            {project.outcome}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-faint)]">
          <span>{areaName(project.areaId)}</span>
          <span aria-hidden>/</span>
          <span>
            {counts.total} task{counts.total === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mt-2">
          <CountChips counts={counts} />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setLocalStatus(status === 'paused' ? 'active' : 'paused')}
          >
            <Pause className="size-3" />
            {status === 'paused' ? 'Resume' : 'Pause'}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setLocalStatus('done')}>
            <CheckCircle2 className="size-3" />
            Done
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setLocalStatus('archived')}
            className="text-[var(--color-text-muted)]"
          >
            <Archive className="size-3" />
            Archive
          </Button>
        </div>
        {localStatus ? (
          <p className="mt-1.5 text-[11px] text-[var(--color-text-faint)]">
            Shown locally - project status isn't written back to the backend in this slice.
          </p>
        ) : null}
      </div>

      {linkedIntents.length ? (
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Linked intents</h3>
          <ul className="mt-1.5 flex flex-col gap-1">
            {linkedIntents.map((intent) => (
              <li key={intent.id} className="flex gap-2 text-[12.5px] text-[var(--color-text)]">
                <CircleDot className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)]" />
                <span className="min-w-0 flex-1">{intent.rawInput}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Tasks</h3>
          <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{cards.length}</span>
        </div>
        {cards.length ? (
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {cards.map((card) => (
              <BoardTaskRow key={card.id} card={card} showArea={false} />
            ))}
          </div>
        ) : (
          <Note>No tasks linked to this project yet.</Note>
        )}
      </div>

      {evidence.length ? (
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Evidence</h3>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {evidence.map((item) => (
              <span
                key={`${item.kind}-${item.id}`}
                className="max-w-full truncate rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]"
                title={`${item.detail}`}
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {approvals.length ? (
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Approvals</h3>
          <div className="mt-1.5 divide-y divide-[var(--color-border)]">
            {approvals.map((approval) => (
              <div key={approval.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text)]">
                  {approval.title}
                </span>
                <Tag tone="neutral">{APPROVAL_KIND_LABEL[approval.kind] ?? titleCase(approval.kind)}</Tag>
                <Tag tone={approval.status === 'pending' ? 'warning' : 'neutral'}>
                  {titleCase(approval.status)}
                </Tag>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {completions.length ? (
        <div className="px-4 py-3">
          <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Recent activity</h3>
          <ol className="mt-1.5 flex flex-col gap-2">
            {completions.map((event) => (
              <li key={event.id} className="flex gap-2">
                <span className="mt-1.5">
                  <Dot tone="success" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-[var(--color-text)]">{event.summary}</p>
                  <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
                    {fmtDateTime(event.completedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Panel>
  );
}

function SprintsView() {
  const [now] = useState(() => Date.now());
  const sprint = useMemo(() => deriveActiveSprint(now), [now]);
  const [persistedStatus, setPersistedStatus] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const done = sprint.counts.done;
  const ratio = sprint.counts.total ? done / sprint.counts.total : 0;
  const closed = persistedStatus === 'closed' || persistedStatus === 'archived';

  useEffect(() => {
    let active = true;
    callTool<{ sprints: Array<{ externalId?: string; status?: string }> }>('albatross_list_sprints', {
      limit: 50,
    })
      .then((res) => {
        if (!active) return;
        const persisted = (res?.sprints ?? []).find((row) => row.externalId === sprint.id);
        setPersistedStatus(persisted?.status ?? null);
      })
      .catch(() => {
        if (active) setPersistedStatus(null);
      });
    return () => {
      active = false;
    };
  }, [sprint.id]);

  const closeSprint = async () => {
    setClosing(true);
    setCloseError(null);
    try {
      await callTool('albatross_create_sprint', {
        externalId: sprint.id,
        title: sprint.title,
        goal: 'Derived from open Albatross work.',
        cadence: sprint.cadence,
        status: 'closed',
        startAt: sprint.startAt,
        endAt: sprint.endAt,
      });
      setPersistedStatus('closed');
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : String(error));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="grid gap-4 @[900px]:grid-cols-[minmax(0,1fr)_minmax(0,260px)] @[900px]:items-start">
      <Panel>
        <PanelHeader title="Active sprint" trailing={<Tag tone="accent">Weekly</Tag>} />
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-[var(--color-text)]">
              {sprint.title}
            </h2>
            {closed ? <Tag tone="neutral">Closed</Tag> : <Tag tone="success">Active</Tag>}
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">
            {sprint.startLabel} – {sprint.endLabel} / derived from open work
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
              {done}/{sprint.counts.total} done
            </span>
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Sprint backlog</h3>
            <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
              {sprint.cards.length}
            </span>
          </div>
          {sprint.cards.length ? (
            <div className="mt-1 divide-y divide-[var(--color-border)]">
              {sprint.cards.map((card) => (
                <BoardTaskRow key={card.id} card={card} />
              ))}
            </div>
          ) : (
            <Note>No open work in this sprint window.</Note>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Sprint summary" />
        <div className="flex flex-col gap-3 px-4 py-3">
          <CountChips counts={sprint.counts} />
          <Separator />
          <div className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
            <p>
              <span className="text-[var(--color-text-faint)]">Cadence:</span> Weekly, resets Monday.
            </p>
            <p>
              <span className="text-[var(--color-text-faint)]">Monthly:</span> closed sprints roll up into
              each area's history.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={closed || closing}
            onClick={closeSprint}
            className="gap-1.5"
          >
            {closing ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
            {closed ? 'Sprint closed' : closing ? 'Closing sprint' : 'Close sprint'}
          </Button>
          {closeError ? (
            <p className="text-[11px] text-[var(--color-danger)]">{closeError}</p>
          ) : (
            <p className="text-[11px] text-[var(--color-text-faint)]">
              Closing writes this derived sprint into the Albatross work model.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unassigned - an inbox-style triage queue (issues #73 + #74)         */
/* ------------------------------------------------------------------ */
/* Every action names what it does now AND how classification changes  */
/* going forward, before you commit - context is never learned         */
/* silently. The classifier's own read (primary / candidate / verified */
/* / unassigned, with reasons) sits beside the smart-mail category so   */
/* both signals stay legible.                                           */

// A locally committed triage decision: the projected effect plus the area it
// routed to, so the optimistic change is fully described back to the user.
interface CommittedDecision {
  effect: ReviewDecisionEffect;
  areaName?: string;
}

function UnassignedSurface() {
  const queue = buildReviewQueue();
  const noiseRules = buildNoiseRules();
  const seedCorrections = buildRecentCorrections();
  const [selectedId, setSelectedId] = useState(queue[0]?.item.id ?? '');
  const [committed, setCommitted] = useState<Record<string, CommittedDecision>>({});
  const detail = buildReviewDetail(selectedId) ?? buildReviewDetail(queue[0]?.item.id ?? '');

  // Anything committed this session that writes durable context is shown on top
  // of the seeded corrections, so the queue -> context loop is visible, not silent.
  const optimisticCorrections = queue
    .map(({ item, artifact }) => {
      const decision = committed[item.id];
      if (!decision?.effect.persistsContext) return null;
      return { id: item.id, title: artifact.title, decision };
    })
    .filter((row): row is { id: string; title: string; decision: CommittedDecision } => row !== null);

  return (
    <Surface title="Unassigned" count={queue.length}>
      <div className="grid gap-4 @[1080px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)] @[1080px]:items-start">
        <Panel className="@[1080px]:max-h-[calc(100vh-9.5rem)]">
          <PanelHeader title="Review queue" count={queue.length} />
          <div className="min-h-0 overflow-y-auto">
            {queue.map(({ item, artifact, thread, candidateAreas }) => {
              const Icon = ARTIFACT_ICON[item.artifactKind] ?? CircleDot;
              const decision = committed[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={selectRowClass(item.id === selectedId)}
                >
                  <div className="flex items-center gap-2">
                    {thread?.unread ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
                        title="Unread"
                      />
                    ) : null}
                    <Icon className="size-4 shrink-0 text-[var(--color-text-faint)]" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">
                      {artifact.title}
                    </span>
                    {thread ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                        {fmtDate(thread.lastDate)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 pl-6 text-[12px] text-[var(--color-text-muted)]">
                    {item.reason}
                  </p>
                  {candidateAreas.length ? (
                    <p className="mt-1 truncate pl-6 text-[11.5px] text-[var(--color-text-faint)]">
                      Suggested: {candidateAreas.join(', ')}
                    </p>
                  ) : null}
                  {decision ? (
                    <p className="mt-1 pl-6 text-[11.5px] text-[var(--color-success)]">
                      {decision.effect.label}
                      {decision.areaName ? ` -> ${decision.areaName}` : ''}
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 @[1320px]:grid-cols-[minmax(0,1fr)_minmax(0,250px)] @[1320px]:items-start">
          {detail ? (
            <TriageDetail
              key={detail.item.id}
              detail={detail}
              committed={committed[detail.item.id]}
              onCommit={(decision) => setCommitted((prev) => ({ ...prev, [detail.item.id]: decision }))}
              onUndo={() => setCommitted((prev) => withoutKey(prev, detail.item.id))}
            />
          ) : (
            <Panel>
              <Note>No items waiting for a decision.</Note>
            </Panel>
          )}

          <div className="flex flex-col gap-4">
            <Panel>
              <PanelHeader title="Noise rules" count={noiseRules.length} />
              <div className="divide-y divide-[var(--color-border)] px-3">
                {noiseRules.length ? (
                  noiseRules.map((rule) => (
                    <div key={rule.id} className="py-2">
                      <p className="text-[12px] leading-snug text-[var(--color-text)]">{rule.value}</p>
                      {rule.confirmationRefs[0]?.confirmedAt ? (
                        <span className="text-[11px] text-[var(--color-text-faint)]">
                          Confirmed {fmtDate(rule.confirmationRefs[0].confirmedAt)}
                        </span>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <Note>No noise rules yet.</Note>
                )}
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Recent corrections"
                count={optimisticCorrections.length + seedCorrections.length}
              />
              <div className="divide-y divide-[var(--color-border)] px-3">
                {optimisticCorrections.map(({ id, title, decision }) => (
                  <div key={`live-${id}`} className="py-2">
                    <p className="text-[12px] leading-snug text-[var(--color-text)]">
                      {decision.effect.label}: "{title}"
                    </p>
                    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)]">
                      <Dot tone="accent" />
                      {decision.areaName ? `${decision.areaName} / ` : ''}Just now
                    </span>
                  </div>
                ))}
                {seedCorrections.length ? (
                  seedCorrections.map((event) => (
                    <div key={event.id} className="py-2">
                      <p className="text-[12px] leading-snug text-[var(--color-text)]">{event.summary}</p>
                      <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
                        {areaName(event.areaId)} / {fmtDate(event.completedAt)}
                      </span>
                    </div>
                  ))
                ) : optimisticCorrections.length ? null : (
                  <Note>No corrections recorded.</Note>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </Surface>
  );
}

// Issue #74 - surface what the deterministic classifier actually concluded for
// this artifact: a primary assignment (with verified/candidate status + reason),
// rare reasoned secondaries, or the explicit reason it stayed Unassigned. The
// smart-mail category is preserved separately so "loud is not important" stays visible.
function ClassifierReadout({ item }: { item: ContextReviewItem }) {
  const classification = useMemo<ArtifactClassification | null>(() => {
    if (item.artifactKind === 'mailThread') return classifyThread(item.artifactId);
    const artifact = toClassifierArtifact(item.artifactKind, item.artifactId);
    return artifact ? classifyArtifact(artifact) : null;
  }, [item.artifactKind, item.artifactId]);

  if (!classification) return null;
  const { primary, secondary, unassignedReason } = classification;

  return (
    <div>
      <h3 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">
        What the classifier sees
      </h3>
      {primary ? (
        <div className="flex flex-col gap-1.5">
          <AssignmentRow assignment={primary} assignmentRole="Primary" />
          {secondary.map((assignment) => (
            <AssignmentRow key={assignment.areaId} assignment={assignment} assignmentRole="Secondary" />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Tag tone="neutral">Unassigned</Tag>
            <span className="text-[11.5px] text-[var(--color-text-faint)]">below the confidence bar</span>
          </div>
          {unassignedReason ? (
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{unassignedReason}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AssignmentRow({
  assignment,
  assignmentRole,
}: {
  assignment: AreaAssignment;
  assignmentRole: 'Primary' | 'Secondary';
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-faint)]">
          {assignmentRole}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">
          {assignment.areaName}
        </span>
        <Tag tone={assignment.status === 'verified' ? 'success' : 'warning'}>
          {assignment.status === 'verified' ? 'Verified' : 'Candidate'}
        </Tag>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--color-text-faint)]">
        <span>{confidenceLabel(assignment.confidence)}</span>
        <span aria-hidden>/</span>
        <span className="min-w-0">{assignment.reason}</span>
      </div>
    </div>
  );
}

function TriageDetail({
  detail,
  committed,
  onCommit,
  onUndo,
}: {
  detail: ReviewDetail;
  committed?: CommittedDecision;
  onCommit: (decision: CommittedDecision) => void;
  onUndo: () => void;
}) {
  const { item, artifact, thread, candidateAreas, candidateFacts } = detail;
  const Icon = ARTIFACT_ICON[item.artifactKind] ?? CircleDot;
  const options = useMemo(() => reviewDecisionOptions(item), [item]);
  // Two-step: pick an action to preview its effect, then confirm to commit.
  const [pendingAction, setPendingAction] = useState<ReviewActionKind | null>(null);
  // Some actions route to an area; default to the suggested one but let the user
  // re-aim before committing so nothing lands in the wrong place.
  const [targetAreaId, setTargetAreaId] = useState<string | undefined>(item.candidateAreaIds?.[0]);

  const pendingEffect = pendingAction
    ? applyReviewDecision(item, pendingAction, NEEDS_AREA.has(pendingAction) ? targetAreaId : undefined)
    : null;

  return (
    <Panel>
      <PanelHeader
        title="Decision"
        trailing={
          thread ? (
            <Tag tone="neutral">{SMART_LABEL[thread.smartPrimary] ?? titleCase(thread.smartPrimary)}</Tag>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-[var(--color-text-faint)]" />
            <h2 className="min-w-0 truncate text-[15px] font-semibold text-[var(--color-text)]">
              {artifact.title}
            </h2>
          </div>
          <p className="mt-0.5 pl-6 text-[12px] text-[var(--color-text-muted)]">
            {artifact.detail}
            {thread ? ` / ${fmtDateTime(thread.lastDate)}` : ''}
          </p>
        </div>

        <dl>
          <Prop label="Why here">{item.reason}</Prop>
          {thread ? <Prop label="Preview">{thread.snippet}</Prop> : null}
          <Prop label="Suggested">
            {candidateAreas.length ? candidateAreas.map((area) => area.name).join(', ') : 'No area yet'}
          </Prop>
        </dl>

        <ClassifierReadout item={item} />

        {candidateFacts.length ? (
          <div>
            <h3 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Fact to settle</h3>
            <div className="divide-y divide-[var(--color-border)]">
              {candidateFacts.map((fact) => (
                <div key={fact.id} className="py-2">
                  <p className="text-[12.5px] leading-snug text-[var(--color-text)]">{fact.value}</p>
                  <div className="mt-1">
                    <Evidence refs={fact.sourceRefs} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <h3 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Evidence</h3>
          <Evidence refs={item.sourceRefs} />
        </div>

        <Separator />

        {committed ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
            <p className="text-[12.5px] font-medium text-[var(--color-success)]">{committed.effect.effect}</p>
            {committed.effect.goingForward ? (
              <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                <span className="text-[var(--color-text-faint)]">Going forward:</span>{' '}
                {committed.effect.goingForward}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                onUndo();
                setPendingAction(null);
              }}
              className="mt-1.5 text-[11.5px] text-[var(--color-accent)] hover:underline"
            >
              Undo this
            </button>
          </div>
        ) : pendingEffect ? (
          <DecisionPreview
            effect={pendingEffect}
            item={item}
            onPickArea={setTargetAreaId}
            onConfirm={() => {
              onCommit({ effect: pendingEffect, areaName: pendingEffect.targetAreaName });
              setPendingAction(null);
            }}
            onCancel={() => setPendingAction(null)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[11.5px] text-[var(--color-text-faint)]">
              Pick an action to see what it does before anything is saved.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {options.map((option, index) => (
                <Button
                  key={option.action}
                  type="button"
                  size="sm"
                  variant={index === 0 ? 'default' : 'outline'}
                  className={cn(
                    option.danger && 'text-[var(--color-danger)] hover:text-[var(--color-danger)]',
                  )}
                  onClick={() => {
                    setTargetAreaId(item.candidateAreaIds?.[0]);
                    setPendingAction(option.action);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// Actions that route an artifact (or fact) into a specific area, so the picker
// is offered before commit.
const NEEDS_AREA = new Set<ReviewActionKind>(['assign_area', 'create_area', 'verify_fact']);

function DecisionPreview({
  effect,
  item,
  onPickArea,
  onConfirm,
  onCancel,
}: {
  effect: ReviewDecisionEffect;
  item: ContextReviewItem;
  onPickArea: (areaId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const needsArea = NEEDS_AREA.has(effect.action);
  const targetArea = effect.targetAreaId ? areas.find((area) => area.id === effect.targetAreaId) : null;
  const canConfirm = !needsArea || Boolean(targetArea);
  const [reaiming, setReaiming] = useState(false);
  return (
    <div
      className={cn(
        'rounded-md border p-3',
        effect.danger
          ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)]'
          : 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-[var(--color-text)]">{effect.label}</span>
        {effect.persistsContext ? (
          <Tag tone={effect.danger ? 'danger' : 'accent'}>Writes context</Tag>
        ) : (
          <Tag tone="neutral">No change</Tag>
        )}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-snug text-[var(--color-text)]">{effect.effect}</p>
      {effect.goingForward ? (
        <p className="mt-1 text-[12px] leading-snug text-[var(--color-text-muted)]">
          <span className="text-[var(--color-text-faint)]">Going forward:</span> {effect.goingForward}
        </p>
      ) : null}

      {needsArea ? (
        reaiming ? (
          <div className="mt-2">
            <AreaPicker
              excludeAreaId={undefined}
              onPick={(area) => {
                onPickArea(area.id);
                setReaiming(false);
              }}
              onCancel={() => setReaiming(false)}
            />
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] text-[var(--color-text-faint)]">
            Routes to {targetArea ? targetArea.name : 'an area you pick'} /{' '}
            <button
              type="button"
              onClick={() => setReaiming(true)}
              className="text-[var(--color-accent)] hover:underline"
            >
              {item.candidateAreaIds?.length ? 'Change area' : 'Pick area'}
            </button>
          </p>
        )
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={effect.danger ? 'destructive' : 'default'}
          onClick={onConfirm}
          disabled={!canConfirm}
        >
          <Check className="size-3.5" />
          Confirm
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issue #72 - Area setup                                              */
/* ------------------------------------------------------------------ */
/* Setup teaches Albatross what you are responsible for, organised by   */
/* area. It is resumable (jump to any area) and skippable (never a form  */
/* to finish), asks one plain responsibility question per area, and lets */
/* you draft verifiable context - people, domains, repos, websites,      */
/* tools, calendars, accounts. People (and area membership) stay         */
/* candidates until you explicitly confirm them; identifiers you type    */
/* are taken at your word. Everything written here is a session-local    */
/* draft, clearly labelled as such.                                      */

// A locally drafted area - either brand new, or an edit of a seeded one. Never
// auto-confirmed; it is a proposal until the user acts on it elsewhere.
interface AreaDraft {
  id: string;
  name: string;
  kind: string;
  description?: string;
  sourceAreaId?: string;
}

const SETUP_SLOT_ICON: Record<SetupFactKind, LucideIcon> = {
  person: Users,
  domain: AtSign,
  repo: GitPullRequest,
  website: Globe,
  tool: Wrench,
  calendar: CalendarDays,
  account: Mail,
};

const SETUP_AREA_KINDS = ['work', 'life_admin', 'personal', 'learning'] as const;

function AreaSetupDialog({
  open,
  onOpenChange,
  drafts,
  onDraftFact,
  onRemoveDraft,
  confirmedFacts,
  onConfirmFact,
  areaDrafts,
  onAreaDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: DraftedFact[];
  onDraftFact: (draft: DraftedFact) => void;
  onRemoveDraft: (draft: DraftedFact) => void;
  confirmedFacts: Set<string>;
  onConfirmFact: (factKey: string) => void;
  areaDrafts: AreaDraft[];
  onAreaDraft: (draft: AreaDraft) => void;
}) {
  const setupOverlay = useMemo(
    () => ({ drafts, confirmedFactIds: confirmedFacts }),
    [drafts, confirmedFacts],
  );
  const plan = useMemo(() => buildSetupPlan(setupOverlay), [setupOverlay]);
  const progress = useMemo(() => summarizeSetupProgress(plan), [plan]);
  const [activeAreaId, setActiveAreaId] = useState(plan[0]?.area.id ?? '');
  const [creating, setCreating] = useState(false);

  // Responsibility answers are local to the dialog; confirmations are lifted so
  // progress outside the dialog reflects the current setup session too.
  const [responses, setResponses] = useState<Record<string, string>>({});

  const allSteps = plan;
  const activeStep = useMemo(
    () => (activeAreaId ? buildSetupStep(activeAreaId, setupOverlay) : null),
    [activeAreaId, setupOverlay],
  );
  const activeDraftArea =
    areaDrafts.find((draft) => draft.id === activeAreaId || draft.sourceAreaId === activeAreaId) ?? null;
  const goNext = () => {
    const idx = allSteps.findIndex((step) => step.area.id === activeAreaId);
    const next = allSteps[idx + 1];
    if (next) setActiveAreaId(next.area.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-[var(--color-border)] px-5 py-4 text-left">
          <DialogTitle className="font-display text-[18px]">Set up your areas</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            Teach Albatross what you're responsible for - by area, not by demographics. Add what you can; you
            can stop and come back anytime.
          </DialogDescription>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
              />
            </div>
            <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-text-faint)]">
              {progress.completeAreas} of {progress.totalAreas} areas ready
            </span>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden sm:grid-cols-[200px_minmax(0,1fr)]">
          <div className="hidden min-h-0 flex-col overflow-y-auto border-r border-[var(--color-border)] sm:flex">
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
              Areas
            </p>
            {allSteps.map((step) => (
              <SetupStepRow
                key={step.area.id}
                name={step.area.name}
                kindLabel={AREA_KIND_LABEL[step.area.kind] ?? titleCase(step.area.kind)}
                started={step.started}
                complete={step.complete}
                active={step.area.id === activeAreaId}
                onClick={() => {
                  setCreating(false);
                  setActiveAreaId(step.area.id);
                }}
              />
            ))}
            {areaDrafts.filter((d) => !d.sourceAreaId).length ? (
              <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
                New (draft)
              </p>
            ) : null}
            {areaDrafts
              .filter((d) => !d.sourceAreaId)
              .map((draft) => (
                <SetupStepRow
                  key={draft.id}
                  name={draft.name}
                  kindLabel={AREA_KIND_LABEL[draft.kind] ?? titleCase(draft.kind)}
                  started={drafts.some((f) => f.areaId === draft.id)}
                  complete={false}
                  active={draft.id === activeAreaId}
                  onClick={() => {
                    setCreating(false);
                    setActiveAreaId(draft.id);
                  }}
                />
              ))}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className={cn(
                'mt-1 flex items-center gap-1.5 px-3 py-2 text-left text-[12.5px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-accent)]',
                creating && 'text-[var(--color-accent)]',
              )}
            >
              <FolderPlus className="size-3.5" />
              New area
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {creating ? (
              <NewAreaForm
                draftIndex={areaDrafts.filter((draft) => !draft.sourceAreaId).length + 1}
                onCreate={(draft) => {
                  onAreaDraft(draft);
                  setActiveAreaId(draft.id);
                  setCreating(false);
                }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <SetupStepEditor
                areaId={activeAreaId}
                step={activeStep}
                draftArea={activeDraftArea}
                drafts={drafts.filter((draft) => draft.areaId === activeAreaId)}
                response={responses[activeAreaId] ?? ''}
                confirmedFacts={confirmedFacts}
                onResponse={(value) => setResponses((prev) => ({ ...prev, [activeAreaId]: value }))}
                onDraftFact={onDraftFact}
                onRemoveDraft={onRemoveDraft}
                onConfirmFact={onConfirmFact}
                onEditArea={(draft) => {
                  onAreaDraft(draft);
                }}
                onSkip={goNext}
                hasNext={allSteps.findIndex((step) => step.area.id === activeAreaId) < allSteps.length - 1}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SetupStepRow({
  name,
  kindLabel,
  started,
  complete,
  active,
  onClick,
}: {
  name: string;
  kindLabel: string;
  started: boolean;
  complete: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={selectRowClass(active)}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            complete
              ? 'bg-[var(--color-success)]'
              : started
                ? 'bg-[var(--color-warning)]'
                : 'bg-[var(--color-border-strong)]',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-text)]">
          {name}
        </span>
      </div>
      <span className="mt-0.5 block pl-3.5 text-[11px] text-[var(--color-text-faint)]">
        {complete ? 'Ready' : started ? 'In progress' : kindLabel}
      </span>
    </button>
  );
}

function SetupStepEditor({
  areaId,
  step,
  draftArea,
  drafts,
  response,
  confirmedFacts,
  onResponse,
  onDraftFact,
  onRemoveDraft,
  onConfirmFact,
  onEditArea,
  onSkip,
  hasNext,
}: {
  areaId: string;
  step: SetupStep | null;
  draftArea: AreaDraft | null;
  drafts: DraftedFact[];
  response: string;
  confirmedFacts: Set<string>;
  onResponse: (value: string) => void;
  onDraftFact: (draft: DraftedFact) => void;
  onRemoveDraft: (draft: DraftedFact) => void;
  onConfirmFact: (factId: string) => void;
  onEditArea: (draft: AreaDraft) => void;
  onSkip: () => void;
  hasNext: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (!areaId) return <Note>Pick an area to start, or create a new one.</Note>;

  const name = draftArea?.name ?? step?.area.name ?? 'Area';
  const kind = draftArea?.kind ?? step?.area.kind ?? 'work';
  const prompt = step ? step.responsibilityPrompt : `What are you responsible for in ${name}?`;
  // Seeded slots carry existing facts; a brand-new draft area starts empty.
  const slots = step
    ? step.slots.map((slot) => ({ kind: slot.kind, meta: slot.meta, facts: slot.facts }))
    : SETUP_FACT_KINDS.map((meta) => ({ kind: meta.kind, meta, facts: [] as AreaFact[] }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate font-display text-[16px] font-semibold text-[var(--color-text)]">
            {name}
          </h3>
          <Tag tone="neutral">{AREA_KIND_LABEL[kind] ?? titleCase(kind)}</Tag>
          {draftArea ? <Tag tone="accent">Draft</Tag> : null}
          {step ? (
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            >
              <Pencil className="size-3" />
              Edit
            </button>
          ) : null}
        </div>

        {editing && step ? (
          <EditAreaForm
            area={step.area}
            onSave={(draft) => {
              onEditArea(draft);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
            {draftArea?.description ?? step?.area.description ?? 'A new area to organise your work.'}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={`resp-${areaId}`} className="text-[12.5px] font-medium text-[var(--color-text)]">
          {prompt}
        </label>
        <Textarea
          id={`resp-${areaId}`}
          value={response}
          onChange={(event) => onResponse(event.target.value)}
          placeholder="A sentence in your own words - optional, but it sharpens everything below."
          className="mt-1.5 min-h-[2.5rem] text-[12.5px]"
        />
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
          Context for this area
        </p>
        {slots.map((slot) => (
          <SetupSlotEditor
            key={slot.kind}
            areaId={areaId}
            slotKind={slot.kind}
            label={slot.meta.label}
            prompt={slot.meta.prompt}
            placeholder={slot.meta.placeholder}
            autoVerifies={slot.meta.autoVerifies}
            facts={slot.facts}
            drafts={drafts.filter((draft) => draft.kind === slot.kind)}
            confirmedFacts={confirmedFacts}
            onDraftFact={onDraftFact}
            onRemoveDraft={onRemoveDraft}
            onConfirmFact={onConfirmFact}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {hasNext ? (
          <Button type="button" size="sm" variant="outline" onClick={onSkip} className="gap-1">
            Skip for now
            <ChevronRight className="size-3.5" />
          </Button>
        ) : null}
        <p className="text-[11.5px] text-[var(--color-text-faint)]">
          Two solid context types is enough to start classifying - you don't have to fill everything.
        </p>
      </div>
    </div>
  );
}

function SetupSlotEditor({
  areaId,
  slotKind,
  label,
  prompt,
  placeholder,
  autoVerifies,
  facts,
  drafts,
  confirmedFacts,
  onDraftFact,
  onRemoveDraft,
  onConfirmFact,
}: {
  areaId: string;
  slotKind: SetupFactKind;
  label: string;
  prompt: string;
  placeholder: string;
  autoVerifies: boolean;
  facts: AreaFact[];
  drafts: DraftedFact[];
  confirmedFacts: Set<string>;
  onDraftFact: (draft: DraftedFact) => void;
  onRemoveDraft: (draft: DraftedFact) => void;
  onConfirmFact: (factId: string) => void;
}) {
  const [value, setValue] = useState('');
  const inputId = useId();
  const Icon = SETUP_SLOT_ICON[slotKind];
  const add = () => {
    const draft = draftSetupFact(areaId, slotKind, value);
    if (draft) {
      onDraftFact(draft);
      setValue('');
    }
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-[var(--color-text-faint)]" />
        <span className="text-[12.5px] font-medium text-[var(--color-text)]">{label}</span>
        {!autoVerifies ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default text-[11px] text-[var(--color-warning)]">held to confirm</span>
            </TooltipTrigger>
            <TooltipContent>People and relationships stay candidates until you confirm them.</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <p className="mt-0.5 text-[11.5px] text-[var(--color-text-faint)]">{prompt}</p>

      {facts.length || drafts.length ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {facts.map((fact) => {
            const confirmed = confirmedFacts.has(fact.id);
            const status: FactStatus = confirmed ? 'verified' : fact.status;
            return (
              <div key={fact.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--color-text)]">
                  {fact.value}
                </span>
                <Tag tone={status === 'verified' ? 'success' : status === 'candidate' ? 'warning' : 'danger'}>
                  {confirmed ? 'Confirmed' : FACT_META[status].label}
                </Tag>
                {fact.status === 'candidate' && !confirmed ? (
                  <button
                    type="button"
                    onClick={() => onConfirmFact(fact.id)}
                    className="shrink-0 text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    Confirm
                  </button>
                ) : null}
              </div>
            );
          })}
          {drafts.map((draft) => {
            const confirmed = confirmedFacts.has(draftedFactKey(draft));
            const status: FactStatus = confirmed ? 'verified' : draft.status;
            return (
              <div key={`${draft.areaId}-${draft.kind}-${draft.value}`} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--color-text)]">
                  {draft.value}
                </span>
                <Tag tone={status === 'verified' ? 'success' : 'warning'}>
                  {confirmed ? 'Confirmed' : draft.status === 'verified' ? 'Added' : 'Candidate'}
                </Tag>
                {draft.status === 'candidate' && !confirmed ? (
                  <button
                    type="button"
                    onClick={() => onConfirmFact(draftedFactKey(draft))}
                    className="shrink-0 text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    Confirm
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveDraft(draft)}
                  className="shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
                  aria-label="Remove"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center gap-1.5">
        <label htmlFor={inputId} className="sr-only">
          Add {label.toLowerCase()}
        </label>
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="h-7 min-w-0 flex-1 rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus-visible:border-[var(--color-accent)]"
        />
        <Button type="button" size="xs" variant="outline" onClick={add} disabled={!value.trim()}>
          <Plus className="size-3" />
          Add
        </Button>
      </div>
      {!autoVerifies && value.trim() ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
          Saved as a candidate - confirm it before Albatross treats it as known.
        </p>
      ) : null}
    </div>
  );
}

function NewAreaForm({
  draftIndex,
  onCreate,
  onCancel,
}: {
  draftIndex: number;
  onCreate: (draft: AreaDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('work');
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-display text-[16px] font-semibold text-[var(--color-text)]">New area</h3>
      <div>
        <label htmlFor={`${id}-name`} className="text-[12.5px] font-medium text-[var(--color-text)]">
          What do you call it?
        </label>
        <input
          id={`${id}-name`}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Side project, Family, Apartment"
          className="mt-1.5 h-8 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus-visible:border-[var(--color-accent)]"
        />
      </div>
      <div>
        <span className="text-[12.5px] font-medium text-[var(--color-text)]">What kind of area?</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {SETUP_AREA_KINDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                kind === option
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'border-[var(--color-control-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              )}
            >
              {AREA_KIND_LABEL[option] ?? titleCase(option)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return;
            onCreate({
              id: `area-draft-${slugify(trimmed) || 'area'}-${kind}-${draftIndex}`,
              name: trimmed,
              kind,
            });
          }}
          disabled={!name.trim()}
        >
          Create draft area
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <Note>
        This stays a draft until you add context and confirm it - nothing is created behind your back.
      </Note>
    </div>
  );
}

function EditAreaForm({
  area,
  onSave,
  onCancel,
}: {
  area: Area;
  onSave: (draft: AreaDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(area.name);
  const [description, setDescription] = useState(area.description);
  const id = useId();
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      <label htmlFor={`${id}-name`} className="sr-only">
        Area name
      </label>
      <input
        id={`${id}-name`}
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-8 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-bg-elevated)] px-2.5 text-[12.5px] text-[var(--color-text)] outline-none focus-visible:border-[var(--color-accent)]"
      />
      <label htmlFor={`${id}-description`} className="sr-only">
        Area description
      </label>
      <Textarea
        id={`${id}-description`}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        className="min-h-[2.5rem] text-[12px]"
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          onClick={() =>
            onSave({
              id: `area-draft-edit-${area.id}`,
              name: name.trim() || area.name,
              kind: area.kind,
              description,
              sourceAreaId: area.id,
            })
          }
        >
          Save draft
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
