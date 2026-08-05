'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AlbatrossMark } from '@/components/albatross/AlbatrossMark';
import { AlbatrossRow } from '@/components/albatross/primitives';
import { api } from '@/convex/_generated/api';
import {
  needsYou,
  WORK_STATE_HINT,
  WORK_STATE_LABEL,
  WORK_STATE_ORDER,
  type WorkStateKey,
  workStateKey,
} from '@/lib/albatross/work-state';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

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

export function AlbatrossesSurface() {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const [showClosed, setShowClosed] = useState(false);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [areaId, setAreaId] = useState<string | null>(null);
  const rows = useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? {} : 'skip') as
    | WorkListItem[]
    | undefined;

  const areas = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows || []) {
      if (row.primaryAreaId && row.areaName) seen.set(row.primaryAreaId, row.areaName);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const groups = useMemo(() => groupWork(filterWork(rows || [], filter, areaId)), [rows, filter, areaId]);
  const unhomedCount = useMemo(() => (rows || []).filter((row) => !row.primaryAreaId).length, [rows]);

  // 'unresolved' stays in the open half on purpose: those questions are the
  // whole reason this surface exists, and hiding them behind "Show finished"
  // would repeat the bug this round set out to fix.
  const CLOSED: WorkStateKey[] = ['done', 'released', 'archived'];
  const openGroups = groups.filter((group) => !CLOSED.includes(group.key));
  const closedGroups = groups.filter((group) => CLOSED.includes(group.key));
  const visibleGroups = showClosed ? [...openGroups, ...closedGroups] : openGroups;
  const closedCount = closedGroups.reduce((total, group) => total + group.items.length, 0);

  if (rows === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
        <LoaderCircle className="size-4 animate-spin" /> Loading
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header shares the measure of the list below it. A title that starts
          somewhere the content does not is a page that looks assembled. */}
      <header className="border-b border-[var(--color-border)] px-5 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-serif text-[17px] font-semibold tracking-tight">Albatrosses</h1>
            {closedCount ? (
              <button
                type="button"
                onClick={() => setShowClosed((value) => !value)}
                className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                {showClosed ? 'Hide finished' : 'Show finished'}
              </button>
            ) : null}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>
              Everything
            </FilterPill>
            <FilterPill active={filter === 'needs_you'} onClick={() => setFilter('needs_you')}>
              Needs you
            </FilterPill>
            {/* The old Unassigned review queue. It was a route nobody could reach;
              as a filter it is one click from the list it belongs to. */}
            {unhomedCount ? (
              <FilterPill active={filter === 'unhomed'} onClick={() => setFilter('unhomed')}>
                No area yet
              </FilterPill>
            ) : null}

            {areas.length > 1 ? (
              <>
                <span aria-hidden className="mx-1 h-4 w-px bg-[var(--color-border)]" />
                <FilterPill active={areaId === null} onClick={() => setAreaId(null)}>
                  All areas
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-5">
        <div className="mx-auto max-w-3xl">
          {visibleGroups.length === 0 ? <EmptyState filter={filter} /> : null}
          {visibleGroups.map((group) => (
            <div key={group.key} className="mb-8">
              {/* A section rule, weighted by whether the group is asking for
                  anything. Needs-you carries the accent; the rest are hairlines. */}
              <div className="mb-2 flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'h-px w-5 shrink-0',
                    group.key === 'needs_you' || group.key === 'unresolved'
                      ? 'bg-[var(--color-accent)]'
                      : 'bg-[var(--color-border-strong)]',
                  )}
                />
                <h2 className="font-serif text-[15px] font-semibold">{WORK_STATE_LABEL[group.key]}</h2>
                <p className="text-[12px] text-[var(--color-text-faint)]">{WORK_STATE_HINT[group.key]}</p>
                <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
              </div>
              <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                {group.items.map((item) => (
                  <li key={item._id}>
                    <AlbatrossRow item={item} onOpen={() => setSelectedWorkId(item._id)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-[12.5px] transition-colors',
        active
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({ filter }: { filter: ListFilter }) {
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
  if (filter === 'unhomed') {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h2 className="font-serif text-[20px] font-semibold">Everything has a home</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
          Every Albatross belongs to an area of your life.
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
        className="mt-5 rounded-full bg-[var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-hover)]"
      >
        Get this off my mind
      </button>
    </div>
  );
}
