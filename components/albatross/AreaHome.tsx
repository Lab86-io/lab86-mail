'use client';

// Area home is an Area Brief: an editorial, continuously-updated lead on one
// area of life, followed by the operational work it owns, then supporting
// evidence. The brief (generated lede/summary) is the page's thesis — not a
// card among controls. It answers, in order: what matters now, what needs you,
// what is moving, which Project/Epic owns the multi-week work, and what evidence
// supports that understanding. Artifacts (mail/events/tasks/context) are
// evidence, deliberately capped so a noisy mailbox can't become the center of
// gravity.
//
// Research (Albatross contract — research before code, Opus 2026-07-11; full
// notes in docs/albatross-area-brief-v2-research.md):
// - Mobbin/Asana project overview (0f8c5ba7, 140afee3, 91b6ac7f): a generated
//   AI summary is the page thesis and coexists with a live state pill + a
//   freshness signal; the absent state offers "Generate summary", never faked.
// - Mobbin/Linear project Updates (ed6163fd): latest update + progress lead the
//   main column; properties/milestones sit in a compact rail. Density from type.
// - Mobbin/Contra project (1968548c, 4785e339): one "Next step" callout with a
//   single action leads; the activity timeline is a quieter supporting band.
// - Mobbin/ClickUp+Asana grouped lists (8b2419a3, 8935ad31): work grouped by
//   momentum with per-group counts.
// - Mobbin/Obvious+Linear (0ff79563, 37054da5): one calm capture line, not a
//   heavy form. Browser: Linear project-overview + agent-updates docs, Notion
//   projects guide (summary-coexists-with-live-work, progressive disclosure).
// Plans have no standalone destination; projects/places are area components.

import { useConvexAuth, useQuery_experimental as useConvexQuery, useMutation, useQuery } from 'convex/react';
import { ArrowRight, MessageSquareText, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import {
  type AreaBriefState,
  type AreaOverviewCountsLike,
  type AreaPlaceRow,
  type AreaPlanRow,
  type AreaProjectRow,
  areaBriefHeadline,
  areaBriefState,
  areaFreshness,
  areaHasNoLinks,
  areaHomeSections,
  areaIndexStatusSummary,
  areaNeedsYouRows,
  areaOverviewBadges,
  areaOverviewPriority,
  areaOverviewStatus,
  evidenceRollup,
  formatEventTime,
  mergeNeedsYouRows,
  type NeedsYouRow,
  projectProgress,
  projectStateMeta,
  resolveAreaSelection,
  shouldShowEvidenceBand,
  splitBriefRows,
  taskRowMeta,
  workNeedsYouRows,
} from '@/lib/albatross/area-home';
import { useClientStore } from '@/lib/client-state';
import { categoricalColor, formatDate, shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';

interface AreaMailRow {
  providerThreadId: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet: string;
  unread: boolean;
  linkStatus: string;
  confidence: number | null;
  reason: string | null;
}

interface AreaEventRow {
  providerEventId: string;
  accountId: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location: string | null;
  linkStatus: string;
  reason: string | null;
}

interface AreaTaskRow {
  cardId: string;
  boardId: string;
  title: string;
  completedAt: number | null;
  dueAt: number | null;
  updatedAt: number;
  linkStatus: string;
  reason: string | null;
}

interface AreaFactRow {
  _id: string;
  kind: string;
  value: string;
  status: string;
}

interface AreaIdentityLike {
  _id: string;
  name: string;
  primaryDomain?: string | null;
  faviconUrl?: string | null;
  imageUrl?: string | null;
}

interface AreaHomeData {
  area: AreaIdentityLike & { kind: string; description?: string };
  livingBrief?: null | {
    status: 'generating' | 'ready' | 'error';
    lede: string;
    summary: string;
    generatedAt?: number;
    error?: string;
  };
  facts: { verified: AreaFactRow[]; candidate: AreaFactRow[] };
  mail: AreaMailRow[];
  events: AreaEventRow[];
  tasks: AreaTaskRow[];
  plans: AreaPlanRow[];
  projects: AreaProjectRow[];
  places: AreaPlaceRow[];
  counts: {
    facts: { verified: number; candidate: number };
    // Mail/events/tasks are bounded previews, not exact totals: `shown` is how
    // many rows came back, `hasMore` whether the area owns more than the cap.
    evidence: {
      mail: { shown: number; hasMore: boolean };
      events: { shown: number; hasMore: boolean };
      tasks: { shown: number; hasMore: boolean };
    };
    links: {
      mailThread: { shown: number; bounded: boolean };
      calendarEvent: { shown: number; bounded: boolean };
      task: { shown: number; bounded: boolean };
      other: { shown: number; bounded: boolean };
    };
    needsYouBounded: boolean;
    plans: number;
    projects: number;
    places: number;
  };
}

interface AreaWorkRow {
  _id: string;
  title?: string;
  rawText: string;
  status: string;
  workState?: 'active' | 'waiting' | 'blocked' | 'done' | 'archived';
  agentState?: 'idle' | 'researching' | 'needs_input' | 'applying' | 'error';
  primaryProjectId?: string;
  updatedAt: number;
}

interface AreaIndexStatusData {
  latestRun: {
    runId: string;
    areaId: string | null;
    status: string;
    reason: string | null;
    scanned: number;
    inserted: number;
    matched: number;
    personal: number;
    skipped: number;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  mail: {
    total: number;
    ready: number;
    indexing: number;
    errored: number;
    messagesSynced: number;
    mailboxes: Array<{
      accountId: string;
      provider: string;
      status: string;
      corpusReady: boolean;
      messagesSynced: number;
      updatedAt: number;
      error?: string;
    }>;
  };
}

interface AreaOverviewRow {
  _id: string;
  name: string;
  kind: string;
  description?: string;
  externalId?: string | null;
  primaryDomain?: string | null;
  faviconUrl?: string | null;
  imageUrl?: string | null;
  factCounts: { verified: number; candidate: number };
  workCounts?: AreaOverviewCountsLike;
  lastSignalAt?: number | null;
}

const emptyOverviewCounts: AreaOverviewCountsLike = {
  facts: { verified: 0, candidate: 0 },
  mail: 0,
  events: 0,
  tasks: 0,
  plans: 0,
  projects: 0,
  needsYou: 0,
  overdueTasks: 0,
  unreadMail: 0,
  suggestedLinks: 0,
};

// Evidence caps are deliberately low: supporting rows must summarize, never
// become the page's center of gravity (a 17-thread mailbox can't dominate).
const BRIEF_LIMITS = {
  plans: 4,
  mail: 4,
  events: 3,
  projects: 4,
  places: 4,
  tasks: 4,
  candidateFacts: 4,
  verifiedFacts: 4,
};

function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function AreaHome() {
  const selectedAreaId = useClientStore((s) => s.selectedAreaId);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const { isAuthenticated } = useConvexAuth();
  const areas = useQuery(api.albatross.listAreasOverview, isAuthenticated ? { status: 'active' } : 'skip') as
    | AreaOverviewRow[]
    | undefined;
  const selection = resolveAreaSelection(selectedAreaId, areas);

  useEffect(() => {
    if (selection.state === 'replaced') {
      setSelectedAreaId(selection.areaId);
    } else if (selection.state === 'missing') {
      setSelectedAreaId(null);
    }
  }, [selection.areaId, selection.state, setSelectedAreaId]);

  if (selection.state === 'loading') {
    return <p className="px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">Loading area…</p>;
  }

  // Keyed remount per area: section scroll state and fact busy-state must not
  // leak between areas.
  return selection.areaId ? (
    <AreaHomeBody key={selection.areaId} areaId={selection.areaId} />
  ) : (
    <AreaChooser />
  );
}

// No area selected: the overview grid doubles as the chooser.
function AreaChooser() {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const areas = useQuery(api.albatross.listAreasOverview, isAuthenticated ? { status: 'active' } : 'skip') as
    | AreaOverviewRow[]
    | undefined;
  const ranked = areas
    ? [...areas].sort((a, b) => {
        const score =
          areaOverviewPriority(b.workCounts ?? emptyOverviewCounts) -
          areaOverviewPriority(a.workCounts ?? emptyOverviewCounts);
        return score || a.name.localeCompare(b.name);
      })
    : undefined;
  const totals =
    areas?.reduce(
      (acc, area) => {
        const counts = area.workCounts ?? emptyOverviewCounts;
        acc.needsYou += counts.needsYou;
        acc.plans += counts.plans;
        acc.events += counts.events;
        acc.tasks += counts.tasks;
        return acc;
      },
      { needsYou: 0, plans: 0, events: 0, tasks: 0 },
    ) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Areas</h2>
        {areas ? (
          <span className="text-[11.5px] text-[var(--color-text-faint)]">{areas.length} active</span>
        ) : null}
        <ManageLink className="ml-auto" />
      </header>
      {areas === undefined ? (
        <p className="px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">Loading areas…</p>
      ) : areas.length === 0 ? (
        <div className="px-4 py-8">
          <p className="max-w-md text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            No areas yet. Set up the parts of your life you are responsible for and the classifier starts
            sorting mail, events, and tasks against them.
          </p>
          <Button asChild size="sm" className="mt-4">
            <a href="/settings?tab=areas">Set up areas</a>
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-[var(--color-border)]/55 px-4 py-3">
            <p className="max-w-3xl text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {totals && totals.needsYou > 0
                ? `${totals.needsYou} ${totals.needsYou === 1 ? 'item needs' : 'items need'} you across your areas.`
                : totals && totals.plans + totals.events + totals.tasks > 0
                  ? `${totals.plans} active ${totals.plans === 1 ? 'plan' : 'plans'} · ${totals.events} ${totals.events === 1 ? 'event' : 'events'} · ${totals.tasks} ${totals.tasks === 1 ? 'task' : 'tasks'} filed by area.`
                  : 'Your areas are quiet right now.'}
            </p>
          </div>
          <div className="grid auto-rows-min grid-cols-1 gap-3 p-4 sm:grid-cols-2 min-[1200px]:grid-cols-3">
            {(ranked ?? areas).map((area) => (
              <AreaChooserCard key={area._id} area={area} onOpen={() => setSelectedAreaId(area._id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AreaChooserCard({ area, onOpen }: { area: AreaOverviewRow; onOpen: () => void }) {
  const counts = area.workCounts ?? {
    ...emptyOverviewCounts,
    facts: area.factCounts,
  };
  const badges = areaOverviewBadges(counts);
  const score = areaOverviewPriority(counts);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex min-h-[142px] flex-col rounded-lg border bg-[var(--color-bg-elevated)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-muted)]',
        score > 0 ? 'border-[var(--color-border-strong)]' : 'border-[var(--color-border)]',
      )}
    >
      <div className="flex items-center gap-2">
        <AreaMark area={area} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{area.name}</span>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
          {area.kind}
        </Badge>
      </div>
      <p className="mt-1 text-[12px] font-medium text-[var(--color-text)]">{areaOverviewStatus(counts)}</p>
      {area.description ? (
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--color-text-muted)]">
          {area.description}
        </p>
      ) : (
        <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--color-text-muted)]">
          {area.factCounts.verified} verified context facts · {area.factCounts.candidate} waiting.
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
        {badges.length ? (
          badges.map((badge) => <OverviewBadge key={badge.id} label={badge.label} tone={badge.tone} />)
        ) : (
          <OverviewBadge label={`${area.factCounts.verified} verified`} tone="quiet" />
        )}
      </div>
      <span className="mt-3 flex items-center gap-1 text-[11.5px] font-medium text-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100">
        Open brief <ArrowRight className="size-3" aria-hidden />
      </span>
    </button>
  );
}

function OverviewBadge({ label, tone }: { label: string; tone: 'attention' | 'active' | 'quiet' }) {
  const toneClass =
    tone === 'attention'
      ? 'border-[var(--color-warning)]/35 bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
      : tone === 'active'
        ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)]';
  return <span className={cn('rounded border px-1.5 py-0.5 text-[10.5px]', toneClass)}>{label}</span>;
}

// Thin wrapper so "Try again" can force a fresh mount of the querying content
// (re-running the Convex read) without smuggling a bogus arg into the validated
// areaHome query.
function AreaHomeBody({ areaId }: { areaId: string }) {
  const [retryKey, setRetryKey] = useState(0);
  return <AreaHomeContent key={retryKey} areaId={areaId} onRetry={() => setRetryKey((n) => n + 1)} />;
}

function AreaHomeContent({ areaId, onRetry }: { areaId: string; onRetry: () => void }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const setChatScope = useClientStore((s) => s.setChatScope);
  const now = useMinuteNow();
  // Error-tolerant read: the persisted area id can outlive the area (deleted
  // in Settings) — that must degrade honestly, not crash the surface.
  const result = useConvexQuery({
    query: (api as any).albatross.areaHome,
    args: isAuthenticated ? { areaId: areaId as Id<'areas'> } : 'skip',
  });
  const indexStatus = useQuery(api.albatross.areaIndexStatus, isAuthenticated ? {} : 'skip') as
    | AreaIndexStatusData
    | undefined;
  const workRows = useQuery(
    api.albatrossWorkV2.areaWork,
    isAuthenticated ? { areaId: areaId as Id<'areas'>, includeDone: true } : 'skip',
  ) as AreaWorkRow[] | undefined;

  if (result.status === 'error') {
    // Truthful: the query failed to load. We do not know the area was archived,
    // so we never claim it — retry remounts and re-runs, "All areas" escapes.
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
          <button
            type="button"
            onClick={() => setSelectedAreaId(null)}
            className="text-[12px] text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:underline"
          >
            Areas
          </button>
        </header>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <p className="text-[13.5px] font-medium">This area couldn’t be loaded.</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
              Something went wrong fetching it. Your data is safe — try again, or go back to all areas.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedAreaId(null)}>
                All areas
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (result.status === 'pending') {
    return <AreaHomeSkeleton />;
  }

  const home = result.data as AreaHomeData;
  // The backend returns bounded evidence previews (shown/hasMore), not exact
  // mail/events/tasks totals. Derive the flat display-count shape the section
  // and no-links helpers expect from those previews' `shown` counts.
  const displayCounts = {
    mail: home.counts.evidence.mail.shown,
    events: home.counts.evidence.events.shown,
    tasks: home.counts.evidence.tasks.shown,
    facts: home.counts.facts,
  };
  const sections = areaHomeSections(displayCounts);
  const sectionCount = (id: string) => sections.find((section) => section.id === id)?.count ?? 0;
  const noLinks = areaHasNoLinks(displayCounts, home.counts.links.other.shown);
  const evidenceBounded =
    home.counts.evidence.mail.hasMore ||
    home.counts.evidence.events.hasMore ||
    home.counts.evidence.tasks.hasMore;

  const upcoming = home.events.filter((event) => event.endAt >= now);
  // One authoritative "Needs you" queue: Work waiting on an answer leads, then
  // plans awaiting answers, overdue tasks, and suggested context to confirm.
  // A Work item and its plan share an intent id, so the same intent can arrive
  // from both sources — merge by identity, keeping the actionable work_input row.
  const needsYou = mergeNeedsYouRows(
    workNeedsYouRows(workRows),
    areaNeedsYouRows({ plans: home.plans, tasks: home.tasks, candidateFacts: home.facts.candidate }, now),
  );
  const needsYouBounded = home.counts.needsYouBounded || (workRows?.length ?? 0) >= 100;
  const headline = areaBriefHeadline({
    areaName: home.area.name,
    needsYou: needsYou.length,
    needsYouBounded,
    upcoming: upcoming.length,
    plans: home.counts.plans,
    projects: home.counts.projects,
    mail: displayCounts.mail,
    tasks: displayCounts.tasks,
    candidateFacts: home.counts.facts.candidate,
    evidenceBounded,
    upcomingBounded: home.counts.evidence.events.hasMore,
  });
  const brief = areaBriefState(home.livingBrief, headline);
  const evidence = evidenceRollup({
    mail: home.counts.evidence.mail,
    events: home.counts.evidence.events,
    tasks: home.counts.evidence.tasks,
    facts: home.counts.facts,
  });
  // Work loads from an independent query. `undefined` is still loading; only a
  // resolved array tells us whether the area truly has no work.
  const workLoaded = workRows !== undefined;
  const hasWork = (workRows?.length ?? 0) > 0;
  // The brief is empty only when the area has nothing the classifier or the
  // user has put here yet — then we explain rather than render empty sections.
  // Gate on the Work query resolving so the empty-Area panel never flashes while
  // Work is still loading and could yet fill the page.
  const briefEmpty =
    workLoaded &&
    !hasWork &&
    noLinks &&
    home.counts.plans === 0 &&
    home.counts.projects === 0 &&
    home.counts.places === 0 &&
    home.counts.facts.verified + home.counts.facts.candidate === 0;

  const discuss = () => {
    setChatScope({ kind: 'area', areaId: home.area._id });
    setAiBarOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
        <button
          type="button"
          onClick={() => setSelectedAreaId(null)}
          className="text-[12px] text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:underline"
        >
          Areas
        </button>
        <span className="text-[12px] text-[var(--color-text-faint)]">/</span>
        <AreaMark area={home.area} />
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{home.area.name}</h2>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
          {home.area.kind}
        </Badge>
        <AreaIndexStatusPill status={indexStatus} />
        <span className="ml-auto" />
        <RefreshBriefButton areaId={home.area._id} canGenerate={brief.canGenerate} />
        <ManageLink />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-12">
        <BriefLead home={home} brief={brief} indexStatus={indexStatus} now={now} onDiscuss={discuss} />
        {/* One capture line, in the brief's voice — a real intent, not a form. */}
        <CaptureBar areaId={home.area._id} areaName={home.area.name} />

        {briefEmpty ? (
          <>
            <div className="mx-3 mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
              <p className="text-[13px] font-medium">Nothing filed here yet.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                Get something out of your head above, or teach this area in Settings. As mail, events, and
                tasks arrive, Albatross files them here and keeps this brief current.
              </p>
            </div>
            <ContextSection home={home} count={sectionCount('context')} />
          </>
        ) : (
          <>
            <NeedsYouSection rows={needsYou} bounded={needsYouBounded} />
            <ProjectsSection projects={home.projects} count={home.counts.projects} />
            <WorkSections rows={workRows} />
            {shouldShowEvidenceBand(evidence.length, home.counts.places) ? (
              <>
                <EvidenceHeader segments={evidence} />
                <div className="grid gap-x-9 min-[1180px]:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="min-w-0">
                    <EventsSection events={home.events} count={sectionCount('events')} />
                    <MailSection mail={home.mail} count={sectionCount('mail')} />
                    <TasksSection tasks={home.tasks} count={sectionCount('tasks')} now={now} />
                  </div>
                  <aside className="min-w-0 min-[1180px]:sticky min-[1180px]:top-0 min-[1180px]:self-start">
                    <PlacesSection places={home.places} count={home.counts.places} />
                    <ContextSection home={home} count={sectionCount('context')} />
                  </aside>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// The living brief is the page's thesis: an editorial serif lead using the
// cached AI lede/summary when ready, and an honest generating/error/absent
// state otherwise (never fabricated progress). Discuss is contextual here,
// attached to the brief rather than competing in the header.
function BriefLead({
  home,
  brief,
  indexStatus,
  now,
  onDiscuss,
}: {
  home: AreaHomeData;
  brief: AreaBriefState;
  indexStatus?: AreaIndexStatusData;
  now: number;
  onDiscuss: () => void;
}) {
  const indexSummary = areaIndexStatusSummary(indexStatus);
  const freshness = brief.mode === 'ready' ? areaFreshness(brief.generatedAt, now) : null;
  return (
    <section className="px-3 pb-1 pt-5">
      <div className="flex min-w-0 items-start gap-3.5">
        <AreaMark area={home.area} size="lg" />
        <div className="min-w-0 flex-1">
          {/* Edition line: what kind of brief this is + its freshness/state. */}
          <div className="flex items-center gap-2">
            <span className="font-display text-[11px] italic leading-none text-[var(--color-text-muted)]">
              Area brief
            </span>
            {brief.mode === 'generating' ? (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--color-accent)]">
                <RefreshCw className="size-2.5 motion-safe:animate-spin" aria-hidden />
                Updating
              </span>
            ) : brief.mode === 'error' ? (
              <span className="text-[10.5px] text-[var(--color-danger)]">Needs refresh</span>
            ) : freshness ? (
              <span className="text-[10.5px] tabular-nums text-[var(--color-text-faint)]">
                Updated {freshness}
              </span>
            ) : null}
            <span className="h-px flex-1 self-center bg-[var(--color-border)]/60" />
          </div>
          <p
            className={cn(
              'mt-2 font-display text-[19px] leading-[1.28] tracking-[-0.01em] text-[var(--color-text)] min-[760px]:text-[21px]',
              brief.stale && 'opacity-60 transition-opacity',
            )}
          >
            {brief.lede}
          </p>
          {brief.summary ? (
            <p
              className={cn(
                'mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--color-text-muted)]',
                brief.stale && 'opacity-60 transition-opacity',
              )}
            >
              {brief.summary}
            </p>
          ) : null}
          {brief.note ? (
            <p className="mt-1.5 text-[11.5px] text-[var(--color-text-faint)]">{brief.note}</p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={onDiscuss}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              <MessageSquareText className="size-3.5" aria-hidden />
              Ask about this area
            </button>
            {home.area.primaryDomain ? (
              <span className="truncate text-[11.5px] text-[var(--color-text-faint)]">
                {home.area.primaryDomain}
              </span>
            ) : null}
            {indexSummary ? (
              <span className="truncate text-[11.5px] text-[var(--color-text-faint)]">
                {indexSummary.label}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

// The header that opens the quieter supporting-evidence band, so mail/events/
// tasks/context read as source material beneath the brief and work, not as
// peers of them. The rollup summarizes volume in one line.
function EvidenceHeader({ segments }: { segments: ReturnType<typeof evidenceRollup> }) {
  return (
    <div className="flex items-baseline gap-2.5 px-3 pb-1 pt-7">
      <span className="font-display text-[13px] italic leading-none text-[var(--color-text)]">Evidence</span>
      <span className="text-[11px] leading-none text-[var(--color-text-faint)]">
        {segments.map((s) => s.label).join(' · ')}
      </span>
      <span className="h-px flex-1 self-center bg-[var(--color-border)]/70" />
    </div>
  );
}

function AreaHomeSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <span className="h-4 w-4 rounded-sm bg-[var(--color-bg-muted)] motion-safe:animate-pulse" />
        <span className="h-4 w-28 rounded bg-[var(--color-bg-muted)] motion-safe:animate-pulse" />
      </div>
      <div className="space-y-3 px-6 pt-6">
        <span className="block h-3 w-24 rounded bg-[var(--color-bg-muted)] motion-safe:animate-pulse" />
        <span className="block h-5 w-3/4 rounded bg-[var(--color-bg-muted)] motion-safe:animate-pulse" />
        <span className="block h-4 w-1/2 rounded bg-[var(--color-bg-muted)] motion-safe:animate-pulse" />
      </div>
    </div>
  );
}

function OverflowRow({ overflow, noun, action }: { overflow: number; noun: string; action?: ReactNode }) {
  if (overflow <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]">
      <span>
        {overflow} more {noun}
      </span>
      {action}
    </div>
  );
}

// The area-scoped capture bar. It is a capture input, not a chatbot: on submit
// it creates a real albatross intent (source=chat, areaId) and hands off to the
// existing Plans surface — no fake conversational chrome.
function CaptureBar({ areaId, areaName }: { areaId: string; areaName: string }) {
  const setPendingOpenWorkId = useClientStore((s) => s.setPendingOpenWorkId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/albatross/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawText: trimmed,
          source: 'chat',
          areaId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Capture failed.');
      const workIds = Array.isArray(body.workIds) ? body.workIds.map(String) : [];
      setText('');
      if (workIds[0]) setPendingOpenWorkId(workIds[0]);
      for (const workId of workIds) {
        void fetch(`/api/albatross/work/${encodeURIComponent(workId)}/advance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        }).catch(() => undefined);
      }
    } catch {
      setError("Couldn't capture that — it's still here, try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 pb-1 pt-3">
      <div className="flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 transition-colors focus-within:border-[var(--color-border-strong)]">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          aria-label={`Get something out of your head in ${areaName}`}
          placeholder={`Get something in ${areaName} out of your head…`}
          className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-[var(--color-text-faint)]"
        />
        <Button type="button" size="sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
          {busy ? 'Working…' : 'Capture'}
        </Button>
      </div>
      {error ? <p className="mt-1 px-1 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

// The primary action queue: the few things in this area actually waiting on the
// user. When non-empty it leads the brief in a lightly-emphasized panel so it
// reads as "do this" rather than one row group among many. Each row carries an
// honest affordance — Work/plans open their surface, context points at Settings,
// overdue tasks stay informational (they also appear, dated, under Tasks).
function NeedsYouSection({ rows, bounded }: { rows: NeedsYouRow[]; bounded: boolean }) {
  const setPendingOpenIntentId = useClientStore((s) => s.setPendingOpenIntentId);
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0 && !bounded) return null;
  const collapsed = splitBriefRows(rows, 6);
  const visibleRows = expanded ? rows : collapsed.visible;
  return (
    <section className="mx-3 mt-3 overflow-hidden rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)]/45">
      <div className="flex items-baseline gap-2.5 px-3 pb-1.5 pt-2.5">
        <span className="font-display text-[12.5px] italic leading-none text-[var(--color-text)]">
          Needs you
        </span>
        <span className="text-[11px] tabular-nums leading-none text-[var(--color-text-faint)]">
          {rows.length > 0 ? `${rows.length}${bounded ? '+' : ''}` : 'More'}
        </span>
        <span className="h-px flex-1 self-center bg-[var(--color-warning)]/25" />
      </div>
      {visibleRows.map((row) => (
        <div
          key={row.id}
          className="flex items-center gap-2.5 border-t border-[var(--color-warning)]/15 px-3 py-2"
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor: row.kind === 'overdue_task' ? 'var(--color-danger)' : 'var(--color-warning)',
            }}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium">{row.title}</span>
            {row.detail ? (
              <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">{row.detail}</span>
            ) : null}
          </div>
          {row.kind === 'work_input' && row.workId ? (
            <Button type="button" variant="outline" size="xs" onClick={() => setSelectedWorkId(row.workId!)}>
              Answer
            </Button>
          ) : row.kind === 'plan_answers' && row.intentId ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setPendingOpenIntentId(row.intentId!)}
            >
              Answer
            </Button>
          ) : row.kind === 'suggested_context' ? (
            <a
              href="/settings?tab=areas"
              className="shrink-0 text-[11.5px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              Review
            </a>
          ) : null}
        </div>
      ))}
      {collapsed.overflow > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-[var(--color-warning)]/15 px-3 py-2 text-left text-[11.5px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {expanded ? 'Show fewer' : `Show ${collapsed.overflow} more from this brief`}
        </button>
      ) : null}
      {bounded ? (
        <div className="flex items-center gap-2 border-t border-[var(--color-warning)]/15 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          <span className="min-w-0 flex-1">This is a bounded preview; more may be waiting.</span>
          <ViewLink view="intents">Open work</ViewLink>
          <ViewLink view="tasks">Open tasks</ViewLink>
        </div>
      ) : null}
    </section>
  );
}

// Work: the smaller outcomes Albatross is moving through, grouped by momentum.
// Items awaiting the user's answer are NOT duplicated here — they lead the page
// in the single "Needs you" queue. This keeps Work about what is in motion.
function WorkSections({ rows }: { rows: AreaWorkRow[] | undefined }) {
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  // Work is an independent query. While it loads (undefined), hold a quiet
  // placeholder rather than flashing "Nothing in motion" — the empty state is
  // only honest once the query has resolved to an empty array.
  if (rows === undefined) {
    return (
      <section>
        <SectionHeader label="Work" count={0} />
        <p className="px-3 py-3 text-[12px] text-[var(--color-text-faint)]">Loading work…</p>
      </section>
    );
  }
  const active = rows.filter(
    (row) =>
      !['waiting', 'blocked', 'done', 'archived'].includes(row.workState || 'active') &&
      row.agentState !== 'needs_input',
  );
  const waiting = rows.filter(
    (row) => ['waiting', 'blocked'].includes(row.workState || '') && row.agentState !== 'needs_input',
  );
  const done = rows.filter((row) => row.workState === 'done').slice(0, 6);

  const renderGroup = (label: string, group: AreaWorkRow[], quiet = false) => {
    if (!group.length) return null;
    return (
      <section>
        <SectionHeader label={label} count={group.length} />
        <div className="divide-y divide-[var(--color-border)]/55">
          {group.map((work) => (
            <button
              key={work._id}
              type="button"
              onClick={() => setSelectedWorkId(work._id)}
              className="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-hover-soft)]"
            >
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  work.agentState === 'needs_input'
                    ? 'bg-[var(--color-warning)]'
                    : work.agentState === 'error'
                      ? 'bg-[var(--color-danger)]'
                      : work.workState === 'done'
                        ? 'bg-[var(--color-success)]'
                        : 'bg-[var(--color-accent)]',
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-[13px] font-medium',
                    quiet && 'text-[var(--color-text-muted)]',
                  )}
                >
                  {work.title || work.rawText}
                </span>
                <span className="mt-0.5 block truncate text-[11px] capitalize text-[var(--color-text-faint)]">
                  {work.agentState === 'needs_input'
                    ? 'Needs your answer'
                    : work.primaryProjectId
                      ? 'Part of a Project / Epic'
                      : (work.workState || work.agentState || work.status).replaceAll('_', ' ')}
                </span>
              </span>
              <ArrowRight className="size-3.5 text-[var(--color-text-faint)] opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      </section>
    );
  };

  if (!active.length && !waiting.length && !done.length) {
    return (
      <section>
        <SectionHeader label="Work" count={0} />
        <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
          Nothing in motion here yet. Get something out of your head above and Albatross will start working it
          through.
        </p>
      </section>
    );
  }

  return (
    <>
      {renderGroup('Active work', active)}
      {renderGroup('Waiting / blocked', waiting, true)}
      {renderGroup('Recently done', done, true)}
    </>
  );
}

// Projects / Epics: the durable multi-week structures the area owns. Rendered
// heavier than Work rows — bordered cards with a real completion bar (from task
// counts only), active sprint, and a state chip — so the multi-week work is
// visibly a different primitive. A project born from Work links back to it;
// a standalone project stays informational rather than faking a destination.
function ProjectsSection({ projects, count }: { projects: AreaProjectRow[]; count: number }) {
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const rows = splitBriefRows(projects, BRIEF_LIMITS.projects);
  if (count === 0) return null;
  return (
    <section>
      <SectionHeader label="Projects & Epics" count={count} />
      <div className="grid grid-cols-1 gap-2 px-3 py-1 min-[880px]:grid-cols-2">
        {rows.visible.map((project) => {
          const progress = projectProgress(project.completedTaskCount, project.taskCount);
          const state = projectStateMeta(project.status);
          return (
            <div
              key={project.projectId}
              className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 py-3"
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 truncate font-display text-[14px] font-medium leading-snug">
                  {project.title}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none',
                    state.tone === 'active'
                      ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : state.tone === 'paused'
                        ? 'border-[var(--color-warning)]/35 bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
                        : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
                  )}
                >
                  {state.label}
                </span>
              </div>
              {project.outcome ? (
                <span className="line-clamp-2 text-[12px] leading-snug text-[var(--color-text-muted)]">
                  {project.outcome}
                </span>
              ) : null}
              {progress.hasBar ? (
                <div className="mt-0.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500 motion-reduce:transition-none"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--color-text-faint)]">
                    {progress.completed}/{progress.total}
                  </span>
                </div>
              ) : null}
              <div className="mt-0.5 flex items-center gap-2">
                {project.activeSprint ? (
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-text-faint)]">
                    Current sprint · {project.activeSprint.title}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {project.sourceIntentId ? (
                  <button
                    type="button"
                    onClick={() => setSelectedWorkId(project.sourceIntentId!)}
                    className="shrink-0 text-[11px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
                  >
                    Open work
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <OverflowRow overflow={rows.overflow} noun="projects" />
    </section>
  );
}

// Grounded places the area's plans touch — compact cards with an external map
// link. Every row is a real string the plan/search produced; the link is a
// plain Google Maps search, never a fabricated deep link.
function PlacesSection({ places, count }: { places: AreaPlaceRow[]; count: number }) {
  const rows = splitBriefRows(places, BRIEF_LIMITS.places);
  if (count === 0) return null;
  return (
    <section>
      <SectionHeader label="Places" count={count} />
      <div className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-2">
        {rows.visible.map((place) => (
          <a
            key={`${place.name}:${place.address ?? ''}`}
            href={place.mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] px-3 py-2 transition-colors hover:bg-[var(--color-hover-soft)]"
          >
            <span className="truncate text-[12.5px] font-medium">{place.name}</span>
            {place.detail ? (
              <span className="truncate text-[11px] text-[var(--color-text-muted)]">{place.detail}</span>
            ) : null}
            {place.address ? (
              <span className="truncate text-[11px] text-[var(--color-text-faint)]">{place.address}</span>
            ) : null}
            <span className="mt-0.5 text-[11px] font-medium text-[var(--color-accent)]">Open map →</span>
          </a>
        ))}
      </div>
      <OverflowRow
        overflow={rows.overflow}
        noun="places"
        action={<ViewLink view="intents">Open plans</ViewLink>}
      />
    </section>
  );
}

function MailSection({ mail, count }: { mail: AreaMailRow[]; count: number }) {
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const setThreadAccount = useClientStore((s) => s.setThreadAccount);
  const rows = splitBriefRows(mail, BRIEF_LIMITS.mail);

  return (
    <section>
      <SectionHeader
        label="Mail"
        count={count}
        action={count > 0 ? <ViewLink view="mail">Inbox</ViewLink> : undefined}
      />
      {mail.length === 0 ? (
        <SectionEmpty />
      ) : (
        rows.visible.map((row) => {
          const sender = shortFrom(row.fromAddress) || row.fromAddress;
          return (
            <button
              key={`${row.accountId}:${row.providerThreadId}`}
              type="button"
              // Quiet provenance: the classifier's reason surfaces on hover only.
              title={row.reason ?? undefined}
              onClick={() => {
                // Same contract as the inbox: remember the owning mailbox so the
                // reader can load/reply; the reader pane slides in beside this
                // surface ('areas' is mail-ish in AppShell).
                setThreadAccount(row.accountId);
                setSelectedThread(row.providerThreadId);
              }}
              className="group grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 text-left last:border-b-0 hover:bg-[var(--color-hover-soft)]"
            >
              <Avatar name={sender} size={28} />
              <div className={cn('flex min-w-0 flex-col gap-0.5', !row.unread && 'opacity-90')}>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'truncate font-display text-[13.5px]',
                      row.unread ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]/90',
                    )}
                  >
                    {sender}
                  </span>
                  {/* One indicator per row: an unverified classification outranks
                      the unread dot — trust before urgency. */}
                  {row.linkStatus === 'candidate' ? (
                    <SuggestedTag />
                  ) : row.unread ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
                  ) : null}
                </div>
                <span className="truncate text-[12.5px] leading-tight">
                  <span
                    className={
                      row.unread ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text)]'
                    }
                  >
                    {row.subject || '(no subject)'}
                  </span>
                  {row.snippet ? (
                    <span className="text-[var(--color-text-muted)]"> — {row.snippet}</span>
                  ) : null}
                </span>
              </div>
              <span className="self-center text-[11px] font-medium tabular-nums text-[var(--color-text-muted)]">
                {formatDate(row.lastDate)}
              </span>
            </button>
          );
        })
      )}
      <OverflowRow
        overflow={rows.overflow}
        noun="threads"
        action={<ViewLink view="mail">Open inbox</ViewLink>}
      />
    </section>
  );
}

function EventsSection({ events, count }: { events: AreaEventRow[]; count: number }) {
  const now = Date.now();
  const rows = splitBriefRows(events, BRIEF_LIMITS.events);
  return (
    <section>
      <SectionHeader
        label="Events"
        count={count}
        action={count > 0 ? <ViewLink view="calendar">Calendar</ViewLink> : undefined}
      />
      {events.length === 0 ? (
        <SectionEmpty />
      ) : (
        rows.visible.map((event) => (
          <div
            key={`${event.accountId}:${event.providerEventId}`}
            title={event.reason ?? undefined}
            className={cn(
              'flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0',
              event.endAt < now && 'opacity-70',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-display text-[13px] font-medium">{event.title}</span>
                {event.linkStatus === 'candidate' ? <SuggestedTag /> : null}
              </div>
              <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">
                {formatEventTime(event.startAt, event.endAt, event.allDay)}
                {event.location ? ` · ${event.location}` : ''}
              </span>
            </div>
          </div>
        ))
      )}
      <OverflowRow
        overflow={rows.overflow}
        noun="events"
        action={<ViewLink view="calendar">Open calendar</ViewLink>}
      />
    </section>
  );
}

function TasksSection({ tasks, count, now }: { tasks: AreaTaskRow[]; count: number; now: number }) {
  const rows = splitBriefRows(tasks, BRIEF_LIMITS.tasks);
  return (
    <section>
      <SectionHeader
        label="Tasks"
        count={count}
        action={count > 0 ? <ViewLink view="tasks">Board</ViewLink> : undefined}
      />
      {tasks.length === 0 ? (
        <SectionEmpty />
      ) : (
        rows.visible.map((task) => {
          const meta = taskRowMeta(task, now);
          const done = meta.state === 'done';
          return (
            <div
              key={task.cardId}
              title={task.reason ?? undefined}
              className="flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
            >
              <span
                className={cn(
                  'size-3.5 shrink-0 rounded-full border',
                  done
                    ? 'border-[var(--color-transparent)] bg-emerald-500/85'
                    : 'border-[var(--color-border)]',
                )}
                aria-hidden
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  done && 'text-[var(--color-text-muted)] line-through',
                )}
              >
                {task.title}
              </span>
              {task.linkStatus === 'candidate' ? <SuggestedTag /> : null}
              <span
                className={cn(
                  'shrink-0 text-[11px] tabular-nums',
                  meta.state === 'overdue' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
                )}
              >
                {meta.label}
              </span>
            </div>
          );
        })
      )}
      <OverflowRow
        overflow={rows.overflow}
        noun="tasks"
        action={<ViewLink view="tasks">Open board</ViewLink>}
      />
    </section>
  );
}

function ContextSection({ home, count }: { home: AreaHomeData; count: number }) {
  const verifyFact = useMutation(api.albatross.verifyAreaFact);
  const rejectFact = useMutation(api.albatross.rejectAreaFact);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const candidateRows = splitBriefRows(home.facts.candidate, BRIEF_LIMITS.candidateFacts);
  const verifiedRows = splitBriefRows(home.facts.verified, BRIEF_LIMITS.verifiedFacts);

  const verify = async (fact: AreaFactRow) => {
    setBusyFactId(fact._id);
    try {
      // The click is the explicit user confirmation the trust model requires.
      await verifyFact({
        factId: fact._id as Id<'areaFacts'>,
        confirmationRefs: [
          { kind: 'userConfirmation', id: `area-home:${fact._id}:${Date.now()}`, confirmedAt: Date.now() },
        ],
      });
    } finally {
      setBusyFactId(null);
    }
  };

  const reject = async (fact: AreaFactRow) => {
    setBusyFactId(fact._id);
    try {
      await rejectFact({ factId: fact._id as Id<'areaFacts'>, reason: 'Rejected from area home' });
    } finally {
      setBusyFactId(null);
    }
  };

  return (
    <section>
      <SectionHeader
        label="Context"
        count={count}
        action={
          count > 0 ? (
            <a
              href="/settings?tab=areas"
              className="shrink-0 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              Settings
            </a>
          ) : undefined
        }
      />
      {candidateRows.visible.map((fact) => (
        <div
          key={fact._id}
          className={cn(
            'flex items-center gap-2 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0',
            busyFactId === fact._id && 'opacity-60',
          )}
        >
          <span className="w-16 shrink-0 truncate text-[10.5px] capitalize text-[var(--color-text-faint)]">
            {fact.kind}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{fact.value}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busyFactId === fact._id}
            onClick={() => verify(fact)}
          >
            Verify
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busyFactId === fact._id}
            onClick={() => reject(fact)}
          >
            Reject
          </Button>
        </div>
      ))}
      {verifiedRows.visible.map((fact) => (
        <div
          key={fact._id}
          className="flex items-baseline gap-2 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
        >
          <span className="w-16 shrink-0 truncate text-[10.5px] capitalize text-[var(--color-text-faint)]">
            {fact.kind}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{fact.value}</span>
        </div>
      ))}
      <OverflowRow
        overflow={candidateRows.overflow + verifiedRows.overflow}
        noun="context facts"
        action={
          <a
            href="/settings?tab=areas"
            className="shrink-0 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
          >
            Open settings
          </a>
        }
      />
      {count === 0 ? (
        <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
          No facts yet —{' '}
          <a href="/settings?tab=areas" className="underline-offset-2 hover:underline">
            teach this area in Settings
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}

// Editorial section rule matching the inbox's date group headers, so the area
// home reads as the same publication as the rest of the app.
function SectionHeader({ label, count, action }: { label: string; count: number; action?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 px-3 pb-1 pt-5">
      <span className="font-display text-[12.5px] italic leading-none text-[var(--color-text-muted)]">
        {label}
      </span>
      {count > 0 ? (
        <span className="text-[11px] tabular-nums leading-none text-[var(--color-text-faint)]">{count}</span>
      ) : null}
      <span className="h-px flex-1 self-center bg-[var(--color-border)]/70" />
      {action}
    </div>
  );
}

// A quiet "open the deeper surface" link for a section header. Switches the
// primary view — honest: every target is a real routed surface.
function ViewLink({
  view,
  children,
}: {
  view: 'mail' | 'calendar' | 'tasks' | 'intents';
  children: ReactNode;
}) {
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  return (
    <button
      type="button"
      onClick={() => setPrimaryView(view)}
      className="shrink-0 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
    >
      {children}
    </button>
  );
}

function SectionEmpty() {
  return (
    <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
      Nothing classified here yet — the classifier runs every 30 minutes.
    </p>
  );
}

// The quiet per-row provenance tag for AI-suggested (unverified) links.
function SuggestedTag() {
  return (
    <span className="shrink-0 rounded border border-[var(--color-border)] px-1 text-[10px] leading-[1.5] text-[var(--color-text-faint)]">
      Suggested
    </span>
  );
}

function AreaMark({ area, size = 'sm' }: { area: AreaIdentityLike; size?: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? area.imageUrl || area.faviconUrl || null : null;
  const box = size === 'lg' ? 'size-10 rounded-lg' : 'size-4 rounded-sm';
  const dot = size === 'lg' ? 'size-5 rounded-md' : 'size-2 rounded-full';
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden',
        size === 'lg' && 'border border-[var(--color-border)] bg-[var(--color-bg-muted)]',
        box,
      )}
      aria-hidden
    >
      {src ? (
        // biome-ignore lint/performance/noImgElement: arbitrary user/domain favicon URLs are tiny unoptimized identity marks.
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={dot} style={{ backgroundColor: categoricalColor(area._id) }} />
      )}
    </span>
  );
}

// The one honest brief affordance. It hits POST /api/albatross/area/[id]/brief,
// which both regenerates the living brief and refiles the area — so "Generate"
// / "Refresh" does exactly what it says. The reactive areaHome query then shows
// the generating → ready/error transition on its own; we only reflect the
// in-flight request here.
function RefreshBriefButton({ areaId, canGenerate }: { areaId: string; canGenerate: boolean }) {
  const [busy, setBusy] = useState(false);
  // Whether the *request itself* failed to reach/complete. This is separate from
  // the brief's reactive server-side error state (generating → error), which the
  // BriefLead already shows: this only tells the user their click didn't land, so
  // retrying is worthwhile. No toast — the label carries it.
  const [requestFailed, setRequestFailed] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setRequestFailed(false);
    setServerError(null);
    try {
      const response = await fetch(`/api/albatross/area/${encodeURIComponent(areaId)}/brief`, {
        method: 'POST',
      });
      // A non-OK response landed successfully; keep it distinct from a network
      // delivery failure and surface the route's controlled message.
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setServerError(payload?.error || 'Brief refresh was not accepted.');
      }
    } catch {
      // Network error — the request never completed.
      setRequestFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const label = busy
    ? 'Working…'
    : requestFailed || serverError
      ? 'Retry'
      : canGenerate
        ? 'Generate brief'
        : 'Refresh brief';
  const title = requestFailed
    ? 'That request didn’t go through — try again'
    : serverError
      ? `${serverError} Try again.`
      : canGenerate
        ? 'Generate this area brief'
        : 'Refresh this area brief';
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={busy}
      onClick={() => void run()}
      title={title}
      className={cn(
        'inline-flex gap-1.5 text-[11.5px] hover:text-[var(--color-text)]',
        requestFailed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
      )}
    >
      <RefreshCw className={cn('size-3', busy && 'motion-safe:animate-spin')} aria-hidden />
      {label}
    </Button>
  );
}

function AreaIndexStatusPill({ status }: { status?: AreaIndexStatusData }) {
  const summary = areaIndexStatusSummary(status);
  if (!summary) return null;
  const toneClass =
    summary.tone === 'warning'
      ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
      : summary.tone === 'active'
        ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
        : summary.tone === 'done'
          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)]';
  const latestRun = status?.latestRun;
  const title = latestRun
    ? `${latestRun.reason || 'Area filing'} · ${latestRun.status} · ${latestRun.scanned.toLocaleString()} scanned, ${latestRun.inserted.toLocaleString()} filed`
    : summary.label;
  return (
    <span
      title={title}
      className={cn(
        'hidden max-w-[230px] shrink truncate rounded-full border px-2 py-0.5 text-[11px] leading-5 min-[900px]:inline-flex',
        toneClass,
      )}
    >
      {summary.tone === 'active' ? <RefreshCw className="mr-1.5 size-3 animate-spin" aria-hidden /> : null}
      {summary.label}
    </span>
  );
}

function ManageLink({ className }: { className?: string }) {
  return (
    <a
      href="/settings?tab=areas"
      className={cn(
        'text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline',
        className,
      )}
    >
      Manage
    </a>
  );
}
