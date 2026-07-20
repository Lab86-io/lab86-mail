'use client';

// The area home page: everything one area of life currently touches — its
// mail, events, tasks, and verified context — sorted by the 30-minute
// classifier. Areas are becoming the primary sort of the app, so this surface
// reads like an operational inbox view, not a dashboard of cards.
//
// Research (Albatross contract - research before code, Opus 2026-07-09; full
// notes in docs/albatross-area-brief-research.md):
// - Mobbin/Jira project summary (7dc713a9-dd2e-4a47-8145-2386cb0194e8): an area
//   home opens with a greeting + a quiet pulse of what moved, then meaning-first
//   sections (status, recent activity) — not a wall of source rows.
// - Mobbin/ClickUp Home (7823aa2f-ea79-4f53-98ef-8d0d75a83c4e): My Work / Agenda
//   / Assigned — the home groups by what it means to you, each group dense rows.
// - Mobbin/Asana Home (2bb60927): "My Priorities" leads, with an inline capture
//   row ("Click here to add a task…") right in the brief.
// - Mobbin/Notion Home (8d3114c7): one calm prompt bar heads the space; capture
//   and ask share a single line, no chatbot chrome.
// - Mobbin/Linear project overview (9c8e3907): plan-as-document — quiet property
//   badges, outcome text, progress; density from typography, not boxes.
// Plans, projects, and places are now components of the area, not separate pages.

import { useConvexAuth, useQuery_experimental as useConvexQuery, useMutation, useQuery } from 'convex/react';
import { AlertCircle, ArrowRight, CalendarDays, Inbox, RefreshCw, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import {
  type AreaOverviewCountsLike,
  type AreaPlaceRow,
  type AreaPlanRow,
  type AreaProjectRow,
  areaBriefHeadline,
  areaHasNoLinks,
  areaHomeSections,
  areaIndexStatusSummary,
  areaNeedsYouRows,
  areaOverviewBadges,
  areaOverviewPriority,
  areaOverviewStatus,
  areaPulse,
  formatEventTime,
  type NeedsYouRow,
  resolveAreaSelection,
  splitBriefRows,
  taskRowMeta,
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
    mail: number;
    events: number;
    tasks: number;
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

const BRIEF_LIMITS = {
  plans: 4,
  mail: 6,
  events: 4,
  projects: 4,
  places: 4,
  tasks: 5,
  candidateFacts: 4,
  verifiedFacts: 5,
};

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

function AreaHomeBody({ areaId }: { areaId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  const setAiBarOpen = useClientStore((s) => s.setAiBarOpen);
  const setChatScope = useClientStore((s) => s.setChatScope);
  // Error-tolerant read: the persisted area id can outlive the area (deleted
  // in Settings) — that must degrade to the chooser, not a crashed surface.
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
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-[13.5px] font-medium">This area is unavailable.</p>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
            It may have been archived or removed in Settings.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setSelectedAreaId(null)}
          >
            Show all areas
          </Button>
        </div>
      </div>
    );
  }
  if (result.status === 'pending') {
    return <p className="px-4 py-6 text-[12.5px] text-[var(--color-text-muted)]">Loading area…</p>;
  }

  const home = result.data as AreaHomeData;
  const sections = areaHomeSections(home.counts);
  const sectionCount = (id: string) => sections.find((section) => section.id === id)?.count ?? 0;
  const noLinks = areaHasNoLinks(home.counts);

  const now = Date.now();
  const upcoming = home.events.filter((event) => event.endAt >= now);
  const needsYou = areaNeedsYouRows(
    { plans: home.plans, tasks: home.tasks, candidateFacts: home.facts.candidate },
    now,
  );
  const pulse = areaPulse({
    needsYou: needsYou.length,
    plans: home.counts.plans,
    projects: home.counts.projects,
    places: home.counts.places,
    upcoming: upcoming.length,
  });
  const headline = areaBriefHeadline({
    areaName: home.area.name,
    needsYou: needsYou.length,
    upcoming: upcoming.length,
    plans: home.counts.plans,
    projects: home.counts.projects,
    mail: home.counts.mail,
    tasks: home.counts.tasks,
    candidateFacts: home.counts.facts.candidate,
  });
  // The brief is empty only when the area has nothing the classifier or the
  // user has put here yet — then we explain rather than render empty sections.
  const briefEmpty =
    noLinks &&
    home.counts.plans === 0 &&
    home.counts.projects === 0 &&
    home.counts.places === 0 &&
    home.counts.facts.verified + home.counts.facts.candidate === 0;

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
        <span className="hidden text-[11px] tabular-nums text-[var(--color-text-faint)] sm:inline">
          {home.counts.facts.verified} verified · {home.counts.facts.candidate} suggested
        </span>
        <AreaIndexStatusPill status={indexStatus} />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setChatScope({ kind: 'area', areaId: home.area._id });
            setAiBarOpen(true);
          }}
        >
          Discuss
        </Button>
        <RefreshBriefButton areaId={home.area._id} />
        <ManageLink />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        <BriefLead
          home={home}
          headline={headline}
          pulse={pulse}
          upcoming={upcoming.length}
          needsYou={needsYou.length}
          indexStatus={indexStatus}
        />
        {briefEmpty ? (
          <>
            <div className="mt-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
              <p className="text-[13px] font-medium">Nothing here yet.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
                The classifier runs every 30 minutes and files this area&apos;s mail, events, and tasks as it
                learns your context. Add facts in Settings to sharpen it.
              </p>
            </div>
            <ContextSection home={home} count={sectionCount('context')} />
          </>
        ) : (
          <>
            <NeedsYouSection rows={needsYou} />
            <ProjectsSection projects={home.projects} count={home.counts.projects} />
            <WorkSections rows={workRows || []} />
            <div className="grid gap-x-9 min-[1180px]:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                <EventsSection events={home.events} count={home.counts.events} />
                <MailSection mail={home.mail} count={sectionCount('mail')} />
                <TasksSection tasks={home.tasks} count={sectionCount('tasks')} />
              </div>
              <aside className="min-w-0 min-[1180px]:sticky min-[1180px]:top-0 min-[1180px]:self-start">
                <PlacesSection places={home.places} count={home.counts.places} />
                <ContextSection home={home} count={sectionCount('context')} />
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BriefLead({
  home,
  headline,
  pulse,
  upcoming,
  needsYou,
  indexStatus,
}: {
  home: AreaHomeData;
  headline: string;
  pulse: ReturnType<typeof areaPulse>;
  upcoming: number;
  needsYou: number;
  indexStatus?: AreaIndexStatusData;
}) {
  const indexSummary = areaIndexStatusSummary(indexStatus);
  return (
    <section className="px-3 pb-2 pt-4">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
        <div className="flex flex-col gap-2 min-[760px]:flex-row min-[760px]:items-start min-[760px]:justify-between">
          <div className="flex min-w-0 gap-3">
            <AreaMark area={home.area} size="lg" />
            <div className="min-w-0">
              <p className="text-[14px] font-medium leading-snug text-[var(--color-text)]">
                {home.livingBrief?.status === 'ready' ? home.livingBrief.lede : headline}
              </p>
              {home.livingBrief?.status === 'ready' && home.livingBrief.summary ? (
                <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  {home.livingBrief.summary}
                </p>
              ) : null}
              {home.area.description ? (
                <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--color-text-muted)]">
                  {home.area.description}
                </p>
              ) : null}
              {home.area.primaryDomain ? (
                <p className="mt-1 truncate text-[11.5px] text-[var(--color-text-faint)]">
                  {home.area.primaryDomain}
                </p>
              ) : null}
              {indexSummary ? (
                <p className="mt-1 truncate text-[11.5px] text-[var(--color-text-faint)]">
                  {indexSummary.label}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <BriefProperty
              icon={<AlertCircle className="size-3" aria-hidden />}
              label="Needs"
              value={needsYou}
              active={needsYou > 0}
            />
            <BriefProperty
              icon={<CalendarDays className="size-3" aria-hidden />}
              label="Upcoming"
              value={upcoming}
              active={upcoming > 0}
            />
            <BriefProperty
              icon={<Inbox className="size-3" aria-hidden />}
              label="Plans"
              value={home.counts.plans}
              active={home.counts.plans > 0}
            />
            <BriefProperty
              icon={<Sparkles className="size-3" aria-hidden />}
              label="Context"
              value={home.counts.facts.candidate}
              active={home.counts.facts.candidate > 0}
            />
          </div>
        </div>
        {pulse.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-text-muted)]">
            {pulse.map((segment, index) => (
              <span key={segment.id} className="flex items-center gap-2">
                {index > 0 ? <span className="text-[var(--color-text-faint)]">·</span> : null}
                <span className={cn(segment.id === 'needsYou' && 'font-medium text-[var(--color-text)]')}>
                  {segment.label}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BriefProperty({
  icon,
  label,
  value,
  active,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  active: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]',
        active
          ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-medium tabular-nums text-[var(--color-text)]">{value}</span>
    </span>
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

// The "needs you" queue: the few things in this area actually waiting on the
// user. Each row carries an honest affordance — plan answers open the plan,
// context suggestions point at Settings. Overdue tasks stay informational
// (they are already shown, with their date, in the Tasks section).
function NeedsYouSection({ rows }: { rows: NeedsYouRow[] }) {
  const setPendingOpenIntentId = useClientStore((s) => s.setPendingOpenIntentId);
  if (rows.length === 0) return null;
  return (
    <section>
      <SectionHeader label="Needs you" count={rows.length} />
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
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
          {row.kind === 'plan_answers' && row.intentId ? (
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
    </section>
  );
}

function WorkSections({ rows }: { rows: AreaWorkRow[] }) {
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const active = rows.filter(
    (row) =>
      !['waiting', 'blocked', 'done', 'archived'].includes(row.workState || 'active') &&
      row.agentState !== 'needs_input',
  );
  const waiting = rows.filter((row) => ['waiting', 'blocked'].includes(row.workState || ''));
  const done = rows.filter((row) => row.workState === 'done').slice(0, 6);
  const needs = rows.filter((row) => row.agentState === 'needs_input');

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

  if (!rows.length) {
    return (
      <section>
        <SectionHeader label="Work" count={0} />
        <p className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
          Nothing active here yet. Unload something above and Albatross will start working it through.
        </p>
      </section>
    );
  }

  return (
    <>
      {renderGroup('Needs you', needs)}
      {renderGroup('Active Work', active)}
      {renderGroup('Waiting / blocked', waiting, true)}
      {renderGroup('Recently done', done, true)}
    </>
  );
}

// Projects the area owns. A project born from a plan links back to that plan
// (honest: the source intent exists); a standalone project stays informational
// rather than pointing at a surface it has no page on.
function ProjectsSection({ projects, count }: { projects: AreaProjectRow[]; count: number }) {
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const rows = splitBriefRows(projects, BRIEF_LIMITS.projects);
  if (count === 0) return null;
  return (
    <section>
      <SectionHeader label="Projects" count={count} />
      {rows.visible.map((project) => (
        <div
          key={project.projectId}
          className="flex items-center gap-2.5 border-b border-[var(--color-border)]/45 px-3 py-2 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-display text-[13px] font-medium">{project.title}</span>
              {project.status === 'paused' ? (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">
                  Paused
                </Badge>
              ) : null}
            </div>
            {project.outcome ? (
              <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">{project.outcome}</span>
            ) : null}
            {typeof project.taskCount === 'number' ? (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1 min-w-20 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent)]"
                    style={{
                      width: `${project.taskCount ? ((project.completedTaskCount || 0) / project.taskCount) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="text-[10.5px] tabular-nums text-[var(--color-text-faint)]">
                  {project.completedTaskCount || 0}/{project.taskCount}
                </span>
              </div>
            ) : null}
            {project.activeSprint ? (
              <span className="mt-1 truncate text-[10.5px] text-[var(--color-text-faint)]">
                Current sprint · {project.activeSprint.title}
              </span>
            ) : null}
          </div>
          {project.sourceIntentId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setSelectedWorkId(project.sourceIntentId!)}
            >
              Open Work
            </Button>
          ) : null}
        </div>
      ))}
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

function TasksSection({ tasks, count }: { tasks: AreaTaskRow[]; count: number }) {
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
          const meta = taskRowMeta(task);
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

function RefreshBriefButton({ areaId }: { areaId: string }) {
  const reindex = useMutation(api.albatross.reindexMyAreas);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await reindex({ areaId: areaId as Id<'areas'> });
      setQueued(true);
      window.setTimeout(() => setQueued(false), 2800);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={busy}
      onClick={() => void run()}
      title="Refresh this area brief"
      className="ml-auto inline-flex gap-1.5 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
    >
      <RefreshCw className={cn('size-3', busy && 'animate-spin')} aria-hidden />
      {queued ? 'Queued' : 'Refresh brief'}
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
