'use client';

import {
  CalendarDays,
  CalendarPlus,
  GitPullRequest,
  ListChecks,
  type LucideIcon,
  Mail,
  Sparkles,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  type Approval,
  type AreaDetail,
  type AreaFact,
  type ArtifactKind,
  areaName,
  buildAreaDetail,
  buildAreaSummaries,
  buildIntentWorkbench,
  buildNoiseRules,
  buildRecentCorrections,
  buildReviewDetail,
  buildReviewQueue,
  type FactStatus,
  type IntentPlan,
  type IntentQuestion,
  type IntentWorkbench,
  intents,
  type ReviewDetail,
  type SourceRef,
} from './surface-data';

type AlbatrossSurfaceKind = 'areas' | 'intents' | 'unassigned';

export function AlbatrossSurface({ kind }: { kind: AlbatrossSurfaceKind }) {
  switch (kind) {
    case 'intents':
      return <IntentsSurface />;
    case 'unassigned':
      return <UnassignedSurface />;
    default:
      return <AreasSurface />;
  }
}

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

const ARTIFACT_ICON: Record<ArtifactKind, LucideIcon> = {
  mailThread: Mail,
  calendarEvent: CalendarDays,
  mcpItem: GitPullRequest,
  intent: Sparkles,
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
/* Areas — the context graph as an index + inspector                   */
/* ------------------------------------------------------------------ */

function AreasSurface() {
  const summaries = buildAreaSummaries();
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const [selectedId, setSelectedId] = useState(summaries[0]?.area.id ?? '');
  const visible =
    filter === 'all' ? summaries : summaries.filter((s) => s.factCounts.candidate > 0 || s.reviewCount > 0);
  const activeId = visible.some((summary) => summary.area.id === selectedId)
    ? selectedId
    : (visible[0]?.area.id ?? '');
  const detail = activeId ? buildAreaDetail(activeId) : null;

  return (
    <Surface
      title="Areas"
      controls={
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'review', label: 'Needs review' },
          ]}
        />
      }
    >
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
                    <span aria-hidden>·</span>
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

        {detail ? <AreaInspector detail={detail} /> : null}
      </div>
    </Surface>
  );
}

function AreaInspector({ detail }: { detail: AreaDetail }) {
  const { verified, candidate, rejected } = detail.facts;
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
            {detail.area.priority} · {priorityWord(detail.area.priority)}
          </Prop>
          <Prop label="Facts">
            {verified.length} verified · {candidate.length} candidate · {rejected.length} rejected
          </Prop>
          <Prop label="Linked">{detail.links.length} artifacts</Prop>
          {detail.projects.length ? (
            <Prop label="Projects">
              {detail.projects.map((project) => project.title ?? titleCase(project.status)).join(', ')}
            </Prop>
          ) : null}
        </dl>
      </div>

      <Tabs defaultValue="facts" className="gap-0">
        <div className="border-b border-[var(--color-border)] px-3 py-2">
          <TabsList className="h-8">
            <TabsTrigger value="facts" className="text-[12.5px]">
              Facts
            </TabsTrigger>
            <TabsTrigger value="linked" className="text-[12.5px]">
              Linked items
            </TabsTrigger>
            <TabsTrigger value="changes" className="text-[12.5px]">
              Changes
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="facts" className="px-4 py-3">
          <FactsTab detail={detail} />
        </TabsContent>
        <TabsContent value="linked" className="px-4 py-3">
          <LinkedTab detail={detail} />
        </TabsContent>
        <TabsContent value="changes" className="px-4 py-3">
          <ChangesTab detail={detail} />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}

function FactsTab({ detail }: { detail: AreaDetail }) {
  const [filter, setFilter] = useState<'all' | FactStatus>('all');
  // Local, optimistic verify/reject so the human-control loop is real in the
  // prototype without pretending to persist anything.
  const [decided, setDecided] = useState<Record<string, FactStatus>>({});
  const total = detail.facts.verified.length + detail.facts.candidate.length + detail.facts.rejected.length;
  if (total === 0) return <Note>No facts recorded for this area yet.</Note>;

  const statuses: FactStatus[] = filter === 'all' ? ['verified', 'candidate', 'rejected'] : [filter];

  return (
    <div className="flex flex-col gap-3">
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
              {FACT_META[status].label} <span className="text-[var(--color-text-faint)]">{facts.length}</span>
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
            {decision === 'verified' ? 'Verified by you' : 'Rejected by you'} ·{' '}
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

function LinkedTab({ detail }: { detail: AreaDetail }) {
  if (!detail.links.length) return <Note>No artifacts linked to this area yet.</Note>;
  return (
    <div className="divide-y divide-[var(--color-border)]">
      {detail.links.map(({ link, title, detail: sub }) => {
        const Icon = ARTIFACT_ICON[link.artifactKind] ?? Sparkles;
        return (
          <div key={link.id} className="py-2.5">
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-[var(--color-text-faint)]" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">
                {title}
              </span>
              <Tag tone={FACT_META[link.status].tone}>{FACT_META[link.status].label}</Tag>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-6 text-[11.5px] text-[var(--color-text-faint)]">
              <span>{sub}</span>
              <span aria-hidden>·</span>
              <span>{titleCase(link.role)}</span>
              <span aria-hidden>·</span>
              <span>{confidenceLabel(link.confidence)}</span>
            </div>
            <p className="mt-0.5 pl-6 text-[12px] text-[var(--color-text-muted)]">{link.reason}</p>
          </div>
        );
      })}
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
/* Intents — capture → questions → plan → approval                     */
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

function IntentsSurface() {
  const all = intents;
  const [filter, setFilter] = useState<'all' | 'needs_you' | 'ready'>('all');
  const [selectedId, setSelectedId] = useState(all[0]?.id ?? '');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const visible = all.filter((intent) => {
    if (filter === 'needs_you')
      return intent.status === 'needs_questions' || intent.status === 'needs_confirmation';
    if (filter === 'ready') return intent.status === 'draft_plan_ready';
    return true;
  });
  const activeId = visible.some((intent) => intent.id === selectedId) ? selectedId : (visible[0]?.id ?? '');
  const bench = activeId ? buildIntentWorkbench(activeId) : null;

  return (
    <Surface
      title="Intents"
      controls={
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'needs_you', label: 'Needs you' },
            { value: 'ready', label: 'Plan ready' },
          ]}
        />
      }
    >
      <div className="grid gap-4 @[900px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)] @[900px]:items-start">
        <Panel className="@[900px]:max-h-[calc(100vh-9.5rem)]">
          <PanelHeader title="Captured" count={visible.length} />
          <div className="min-h-0 overflow-y-auto">
            {visible.map((intent) => (
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
                  <span className="ml-auto">{intentStatusTag(intent.status)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-[var(--color-text)]">
                  {intent.rawInput}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--color-text-faint)]">
                  <span className="min-w-0 truncate">{areaName(intent.likelyAreaId)}</span>
                  {intent.questions.length ? (
                    <span className="ml-auto shrink-0 text-[var(--color-warning)]">
                      {intent.questions.length} question{intent.questions.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </Panel>

        {bench ? <IntentWorkbenchPanel bench={bench} answers={answers} setAnswers={setAnswers} /> : null}
      </div>
    </Surface>
  );
}

function IntentWorkbenchPanel({
  bench,
  answers,
  setAnswers,
}: {
  bench: IntentWorkbench;
  answers: Record<string, string>;
  setAnswers: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
}) {
  const { intent, plan, approvals } = bench;
  const blocked =
    plan?.status === 'blocked_on_questions' ||
    intent.status === 'needs_questions' ||
    intent.status === 'needs_confirmation';

  const questionsNode = intent.questions.length ? (
    <QuestionsSection questions={intent.questions} answers={answers} setAnswers={setAnswers} />
  ) : null;
  const planNode = plan ? <PlanSection plan={plan} /> : null;

  return (
    <Panel>
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-text-faint)]">
          <span>{intent.source === 'voice' ? 'Voice capture' : 'Typed capture'}</span>
          <span aria-hidden>·</span>
          <span>{areaName(intent.likelyAreaId)}</span>
          <span aria-hidden>·</span>
          <span>{fmtDateTime(intent.capturedAt)}</span>
          <span className="ml-auto">{intentStatusTag(intent.status)}</span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-text)]">{intent.rawInput}</p>
        {intent.assumptions.length ? (
          <div className="mt-3">
            <h3 className="text-[12px] font-medium text-[var(--color-text-muted)]">Understood</h3>
            <ul className="mt-1 flex flex-col gap-0.5">
              {intent.assumptions.map((assumption) => (
                <li key={assumption} className="flex gap-2 text-[12px] text-[var(--color-text-muted)]">
                  <span className="text-[var(--color-text-faint)]">—</span>
                  <span className="min-w-0 flex-1">{assumption}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* When something is blocked, the question the assistant needs answered
          comes before the plan; otherwise the plan leads. */}
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

      {approvals.length ? <ApprovalsSection approvals={approvals} /> : null}

      {!planNode && !questionsNode && !approvals.length ? (
        <div className="px-4 py-3">
          <Note>No plan drafted yet — this capture is being held as context.</Note>
        </div>
      ) : null}
    </Panel>
  );
}

function QuestionsSection({
  questions,
  answers,
  setAnswers,
}: {
  questions: IntentQuestion[];
  answers: Record<string, string>;
  setAnswers: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
}) {
  const answered = questions.filter((question) => answers[question.id]).length;
  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Needs your answer</h3>
        <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
          {answered}/{questions.length}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {questions.map((question) => (
          <QuestionRow
            key={question.id}
            question={question}
            value={answers[question.id]}
            onAnswer={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
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

function PlanSection({ plan }: { plan: IntentPlan }) {
  const blocked = plan.status === 'blocked_on_questions';
  return (
    <div className="border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-[var(--color-text)]">Proposed plan</h3>
        <span className="ml-auto">
          <Tag tone={blocked ? 'warning' : 'neutral'}>{blocked ? 'Blocked' : titleCase(plan.status)}</Tag>
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-[var(--color-text)]">{plan.outcome}</p>
      {blocked ? (
        <p className="mt-1 text-[12px] text-[var(--color-warning)]">
          Blocked until the questions above are answered.
        </p>
      ) : null}

      {plan.digitalActions.length ? (
        <div className="mt-3">
          <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Digital actions</h4>
          <div className="mt-1 divide-y divide-[var(--color-border)]">
            {plan.digitalActions.map((action) => {
              const Icon = action.kind === 'calendar_event' ? CalendarPlus : ListChecks;
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
                <span className="text-[var(--color-text-faint)]">—</span>
                <span className="min-w-0 flex-1">{step}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan.sourceRefs.length ? (
        <div className="mt-3">
          <h4 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">Evidence</h4>
          <Evidence refs={plan.sourceRefs} />
        </div>
      ) : null}
    </div>
  );
}

function ApprovalsSection({ approvals }: { approvals: Approval[] }) {
  // undefined = still awaiting a decision; the human gate is right next to the
  // action it controls (HAX: explicit control + correction).
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
                  Requires your approval · {approval.undoWindowSeconds}s undo after it runs.
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
                  Approved — will run with a {approval.undoWindowSeconds}s undo window.{' '}
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
                  Rejected — nothing was sent.{' '}
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
/* Unassigned — an inbox-style triage queue                            */
/* ------------------------------------------------------------------ */

const REVIEW_ACTION: Record<string, { label: string; danger?: boolean }> = {
  assign_area: { label: 'Assign to area' },
  create_area: { label: 'Create new area' },
  mark_noise: { label: 'Mark as noise' },
  ignore_sender: { label: 'Ignore sender' },
  ask_later: { label: 'Ask later' },
  verify_fact: { label: 'Verify fact' },
  reject_fact: { label: 'Reject fact', danger: true },
};

function UnassignedSurface() {
  const queue = buildReviewQueue();
  const noiseRules = buildNoiseRules();
  const corrections = buildRecentCorrections();
  const [selectedId, setSelectedId] = useState(queue[0]?.item.id ?? '');
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const detail = buildReviewDetail(selectedId) ?? buildReviewDetail(queue[0]?.item.id ?? '');

  return (
    <Surface title="Unassigned" count={queue.length}>
      <div className="grid gap-4 @[1080px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)] @[1080px]:items-start">
        <Panel className="@[1080px]:max-h-[calc(100vh-9.5rem)]">
          <PanelHeader title="Review queue" count={queue.length} />
          <div className="min-h-0 overflow-y-auto">
            {queue.map(({ item, artifact, thread, candidateAreas }) => {
              const Icon = ARTIFACT_ICON[item.artifactKind] ?? Sparkles;
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
                  {resolved[item.id] ? (
                    <p className="mt-1 pl-6 text-[11.5px] text-[var(--color-success)]">{resolved[item.id]}</p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 @[1320px]:grid-cols-[minmax(0,1fr)_minmax(0,250px)] @[1320px]:items-start">
          {detail ? (
            <TriageDetail
              detail={detail}
              resolved={resolved[detail.item.id]}
              onResolve={(label) => setResolved((prev) => ({ ...prev, [detail.item.id]: label }))}
              onUndo={() => setResolved((prev) => withoutKey(prev, detail.item.id))}
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
              <PanelHeader title="Recent corrections" count={corrections.length} />
              <div className="divide-y divide-[var(--color-border)] px-3">
                {corrections.length ? (
                  corrections.map((event) => (
                    <div key={event.id} className="py-2">
                      <p className="text-[12px] leading-snug text-[var(--color-text)]">{event.summary}</p>
                      <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">
                        {areaName(event.areaId)} · {fmtDate(event.completedAt)}
                      </span>
                    </div>
                  ))
                ) : (
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

function TriageDetail({
  detail,
  resolved,
  onResolve,
  onUndo,
}: {
  detail: ReviewDetail;
  resolved?: string;
  onResolve: (label: string) => void;
  onUndo: () => void;
}) {
  const { item, artifact, thread, candidateAreas, candidateFacts } = detail;
  const Icon = ARTIFACT_ICON[item.artifactKind] ?? Sparkles;
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
            {thread ? ` · ${fmtDateTime(thread.lastDate)}` : ''}
          </p>
        </div>

        <dl>
          <Prop label="Why here">{item.reason}</Prop>
          {thread ? <Prop label="Preview">{thread.snippet}</Prop> : null}
          <Prop label="Suggested">
            {candidateAreas.length ? candidateAreas.map((area) => area.name).join(', ') : 'No area yet'}
          </Prop>
        </dl>

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

        {resolved ? (
          <p className="text-[12.5px] text-[var(--color-success)]">
            {resolved} ·{' '}
            <button type="button" onClick={onUndo} className="text-[var(--color-accent)] hover:underline">
              Undo
            </button>
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {item.suggestedActions.map((action, index) => {
              const meta = REVIEW_ACTION[action] ?? { label: titleCase(action) };
              return (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={index === 0 ? 'default' : 'outline'}
                  className={cn(
                    meta.danger &&
                      index !== 0 &&
                      'text-[var(--color-danger)] hover:text-[var(--color-danger)]',
                  )}
                  onClick={() => onResolve(metaResolveLabel(meta.label))}
                >
                  {meta.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

function metaResolveLabel(label: string): string {
  return `${label} · done`;
}
