'use client';

// The full list of Albatrosses (docs/albatross-threads.md, T1, T2, T10, T12).
// Each row is live: a status dot, the title, the time, and "Status word ·
// preview" from `buildThreadRows`. The groups follow the lead's words: Needs
// you, In progress, Open, Waiting, Paused, then the finished ones behind
// "Show finished". The filter is the rail's filter; the Later shelf and the
// staleness review stay as they were.

import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { ReviewBatch } from '@/components/albatross/Forgiveness';
import { LaterShelf } from '@/components/albatross/LaterShelf';
import { reviewBatch, type WorkShape } from '@/lib/albatross/forgiveness';
import { isDormant, laterShelf, type WorkHorizon } from '@/lib/albatross/horizon';
import {
  listThreadGroups,
  THREAD_FILTER_LABEL,
  THREAD_FILTERS,
  THREAD_GROUP_HINT,
  THREAD_GROUP_LABEL,
  type ThreadGroupKey,
} from '@/lib/albatross/thread-list-view';
import { filterThreadRows, type ThreadFilter } from '@/lib/albatross/threads';
import { needsYou, WORK_STATE_ORDER, type WorkStateKey, workStateKey } from '@/lib/albatross/work-state';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import { ThreadAnswerInPlace } from './ThreadAnswerInPlace';
import { ThreadRow } from './ThreadRow';
import { useThreadActions, useThreadDraftIds } from './use-thread-actions';
import { useAllWork, useThreadRows } from './use-thread-rows';

export interface WorkListItem {
  _id: string;
  title: string | null;
  rawText: string;
  status: string;
  workState: string | null;
  agentState: string | null;
  primaryAreaId: string | null;
  areaName: string | null;
  openQuestions: number;
  updatedAt: number;
  createdAt: number;
  horizon?: WorkHorizon | null;
  lastUserTouchAt?: number | null;
  shape?: WorkShape | null;
  reviewAt?: number | null;
}

/** `all` is every Albatross; `needs_you` is the short list; `unhomed` is what
 *  the old Unassigned review queue used to be — a filter, not a destination. */
export type ListFilter = 'all' | 'needs_you' | 'unhomed';

export function filterWork(rows: WorkListItem[], filter: ListFilter, areaId: string | null) {
  return rows.filter((row) => {
    if (areaId && row.primaryAreaId !== areaId) return false;
    if (filter === 'needs_you') return needsYou(row);
    if (filter === 'unhomed') return !row.primaryAreaId;
    return true;
  });
}

/** The rows that are awake. Dormant Work belongs to the Later shelf, not to a group. */
export function awakeWork<T extends Pick<WorkListItem, 'horizon'>>(rows: T[], nowMs: number): T[] {
  return rows.filter((row) => !isDormant(row, nowMs));
}

/** Dormant Work for the shelf. The "Needs you" filter never shows it: nothing dormant needs anyone. */
export function shelfWork(rows: WorkListItem[], filter: ListFilter, areaId: string | null, nowMs: number) {
  if (filter === 'needs_you') return [];
  return laterShelf(filterWork(rows, filter, areaId), nowMs);
}

export function groupWork(rows: WorkListItem[]) {
  const byState = new Map<WorkStateKey, WorkListItem[]>();
  for (const item of rows) {
    const key = workStateKey(item);
    const bucket = byState.get(key);
    if (bucket) bucket.push(item);
    else byState.set(key, [item]);
  }
  return WORK_STATE_ORDER.map((key) => ({ key, items: byState.get(key) || [] })).filter(
    (group) => group.items.length > 0,
  );
}

export const LIST_COPY = {
  title: 'Albatrosses',
  showFinished: 'Show finished',
  hideFinished: 'Hide finished',
  noArea: 'No area yet',
  allAreas: 'All areas',
  later: 'Later',
  laterHint: 'Kept, not carried. Each comes back on its date.',
} as const;

/** The Work the list shows for an area and the "No area yet" pill. */
export function scopeWork(rows: WorkListItem[], areaId: string | null, unhomed: boolean) {
  return rows.filter(
    (row) => (areaId ? row.primaryAreaId === areaId : true) && (unhomed ? !row.primaryAreaId : true),
  );
}

export function AlbatrossesSurface() {
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const filter = useClientStore((state) => state.threadListFilter);
  const setFilter = useClientStore((state) => state.setThreadListFilter);
  const [showClosed, setShowClosed] = useState(false);
  const [unhomed, setUnhomed] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [answeringWorkId, setAnsweringWorkId] = useState<string | null>(null);
  const works = useAllWork();
  // One clock for the page, so a Work that wakes moves from the shelf to its
  // group without a reload, and the time labels keep up.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const areas = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of works || []) {
      if (row.primaryAreaId && row.areaName) seen.set(row.primaryAreaId, row.areaName);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [works]);

  const scoped = useMemo(() => scopeWork(works || [], areaId, unhomed), [works, areaId, unhomed]);
  const awake = useMemo(() => awakeWork(scoped, nowMs), [scoped, nowMs]);
  const rows = useThreadRows(works ? awake : undefined);
  const visibleRows = useMemo(() => (rows ? filterThreadRows(rows, filter) : []), [rows, filter]);
  const groups = useMemo(() => listThreadGroups(visibleRows), [visibleRows]);
  const openGroups = groups.filter((group) => group.key !== 'finished');
  const closedGroups = groups.filter((group) => group.key === 'finished');
  const visibleGroups = showClosed ? [...openGroups, ...closedGroups] : openGroups;
  const closedCount = closedGroups.reduce((total, group) => total + group.rows.length, 0);
  const counts = useMemo(
    () => ({
      needsYou: (rows ?? []).filter((row) => row.needsYou).length,
      working: (rows ?? []).filter((row) => row.working).length,
    }),
    [rows],
  );
  const later = useMemo(
    () => (filter === 'needs_you' ? [] : laterShelf(scoped, nowMs)),
    [scoped, filter, nowMs],
  );
  // The staleness review lives here, with the Work it asks about. Today does
  // not carry it.
  const stale = useMemo(() => reviewBatch(works || [], nowMs), [works, nowMs]);
  const unhomedCount = useMemo(() => (works || []).filter((row) => !row.primaryAreaId).length, [works]);

  const openThread = useCallback((workId: string) => setSelectedWorkId(workId), [setSelectedWorkId]);
  const actions = useThreadActions(openThread);
  const draftIds = useThreadDraftIds();

  if (works === undefined || rows === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
        <LoaderCircle className="size-4 animate-spin" /> Loading
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      {/* The header shares the measure of the list below it. A title that starts
          somewhere the content does not is a page that looks assembled. */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-content)] px-5 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-serif text-[17px] font-semibold tracking-tight">{LIST_COPY.title}</h1>
            {closedCount ? (
              <button
                type="button"
                onClick={() => setShowClosed((value) => !value)}
                className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                {showClosed ? LIST_COPY.hideFinished : LIST_COPY.showFinished}
              </button>
            ) : null}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {THREAD_FILTERS.map((key) => (
              <FilterPill
                key={key}
                active={filter === key}
                count={key === 'needs_you' ? counts.needsYou : key === 'working' ? counts.working : null}
                onClick={() => setFilter(key)}
              >
                {THREAD_FILTER_LABEL[key]}
              </FilterPill>
            ))}
            {/* The old Unassigned review queue. It was a route nobody could reach;
              as a filter it is one click from the list it belongs to. */}
            {unhomedCount ? (
              <FilterPill active={unhomed} onClick={() => setUnhomed((value) => !value)}>
                {LIST_COPY.noArea}
              </FilterPill>
            ) : null}

            {areas.length > 1 ? (
              <>
                <span aria-hidden className="mx-1 h-4 w-px bg-[var(--color-border)]" />
                <FilterPill active={areaId === null} onClick={() => setAreaId(null)}>
                  {LIST_COPY.allAreas}
                </FilterPill>
                {areas.map((area) => (
                  <FilterPill key={area.id} active={areaId === area.id} onClick={() => setAreaId(area.id)}>
                    {area.name}
                  </FilterPill>
                ))}
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="assistant-launcher-clearance min-h-0 flex-1 overflow-y-auto px-5 pt-5">
        <div className="mx-auto max-w-3xl">
          {stale.length ? (
            <div className="mb-8">
              <ReviewBatch items={stale} />
            </div>
          ) : null}
          {visibleGroups.length === 0 && later.length === 0 ? <EmptyState filter={filter} /> : null}
          {visibleGroups.map((group) => (
            <ThreadGroupSection key={group.key} groupKey={group.key}>
              {group.rows.map((row) => (
                <li key={row.workId}>
                  <ThreadRow
                    row={row}
                    variant="list"
                    prominent={group.key === 'needs_you'}
                    nowMs={nowMs}
                    hasDraft={draftIds.has(row.workId)}
                    onOpen={(target) => openThread(target.workId)}
                    onAction={(kind, target) => {
                      if (kind === 'answer') setAnsweringWorkId(target.workId);
                      else actions.act(kind, target);
                    }}
                    onSteer={actions.steer}
                    onMarkUnread={(target) => void actions.markUnread(target)}
                    inPlace={
                      answeringWorkId === row.workId ? (
                        <ThreadAnswerInPlace
                          row={row}
                          onDone={() => setAnsweringWorkId(null)}
                          onCancel={() => setAnsweringWorkId(null)}
                          onOpenThread={() => {
                            setAnsweringWorkId(null);
                            openThread(row.workId);
                          }}
                        />
                      ) : null
                    }
                  />
                </li>
              ))}
            </ThreadGroupSection>
          ))}

          {later.length ? (
            <div className="mb-8">
              <div className="mb-3 flex items-baseline gap-2">
                <span aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border-strong)]" />
                <h2 className="font-serif text-[15px] font-semibold">{LIST_COPY.later}</h2>
                <p className="text-[12px] text-[var(--color-text-faint)]">{LIST_COPY.laterHint}</p>
                <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
              </div>
              <LaterShelf items={later} nowMs={nowMs} onOpen={setSelectedWorkId} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** A group: the serif heading, its hint, and the card of rows. */
export function ThreadGroupSection({
  groupKey,
  children,
}: {
  groupKey: ThreadGroupKey;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={THREAD_GROUP_LABEL[groupKey]} data-thread-group={groupKey} className="mb-8">
      {/* A section rule, weighted by whether the group is asking for
          anything. Needs-you carries the accent; the rest are hairlines. */}
      <div className="mb-2 flex items-baseline gap-2">
        <span
          aria-hidden
          className={cn(
            'h-px w-5 shrink-0',
            groupKey === 'needs_you' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-strong)]',
          )}
        />
        <h2 className="font-serif text-[15px] font-semibold">{THREAD_GROUP_LABEL[groupKey]}</h2>
        <p className="text-[12px] text-[var(--color-text-faint)]">{THREAD_GROUP_HINT[groupKey]}</p>
        <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <ul className="surface-card rounded-card p-1 [&>li+li]:relative [&>li+li]:before:pointer-events-none [&>li+li]:before:absolute [&>li+li]:before:inset-x-4 [&>li+li]:before:top-0 [&>li+li]:before:h-px [&>li+li]:before:bg-[var(--color-list-divider)]">
        {children}
      </ul>
    </section>
  );
}

function FilterPill({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count?: number | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-ui px-3 py-1 text-[12.5px] transition-colors',
        active
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
      )}
    >
      {children}
      {count ? (
        <span
          className={cn(
            'text-[11.5px] tabular-nums',
            active ? 'opacity-70' : 'text-[var(--color-text-faint)]',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function EmptyState({ filter }: { filter: ThreadFilter }) {
  const setCaptureOpen = useClientStore((state) => state.setCaptureOpen);
  if (filter === 'needs_you') {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h2 className="font-serif text-[20px] font-semibold">Nothing needs you</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Albatross is carrying everything that is open. It will ask when it cannot go further on its own.
        </p>
      </div>
    );
  }
  if (filter === 'working') {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h2 className="font-serif text-[20px] font-semibold">No run is in progress</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Press Handle it in a thread to start one.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <AlbatrossMark className="mx-auto mb-4 size-10 text-[var(--color-text-faint)]" />
      <h2 className="font-serif text-[20px] font-semibold">Nothing on your shoulders yet</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
        Tell Albatross what you keep meaning to handle. It works out what you want, finds the context, and
        carries the parts it can.
      </p>
      <button
        type="button"
        onClick={() => setCaptureOpen(true)}
        className="mt-5 rounded-ui bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]"
      >
        Get this off my mind
      </button>
    </div>
  );
}
