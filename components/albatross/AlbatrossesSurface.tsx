'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
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

function workTitle(item: WorkListItem): string {
  const title = (item.title || '').trim();
  if (title) return title;
  const raw = item.rawText.trim().replace(/\s+/g, ' ');
  return raw.length > 96 ? `${raw.slice(0, 95)}…` : raw || 'Untitled';
}

/**
 * What the user should do next, in words. This is deliberately short and never
 * says "0 items" or shows a score.
 */
export function nextMoveLine(item: WorkListItem): string {
  if (item.openQuestions === 1) return 'One question waiting for you';
  if (item.openQuestions > 1) return `${item.openQuestions} questions waiting for you`;
  if (item.workState === 'archived') return 'You put this down';
  if (item.agentState === 'error') return 'Something went wrong — take a look';
  if (item.agentState === 'researching') return 'Albatross is looking into it';
  if (item.agentState === 'applying') return 'Albatross is making the changes';
  if (item.workState === 'waiting' || item.workState === 'blocked') return 'Waiting on somebody else';
  if (item.workState === 'paused') return 'Paused by you';
  if (item.workState === 'done') return 'Finished';
  return 'Albatross is carrying this';
}

/** Shape and weight carry the state. Colour never does the work alone. */
export function StateChip({ state }: { state: WorkStateKey }) {
  return (
    <span
      data-state={state}
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-none',
        state === 'needs_you'
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)] shadow-[var(--shadow-soft)]'
          : state === 'waiting' || state === 'unresolved'
            ? 'border border-dashed border-[var(--color-border-strong)] text-[var(--color-text-muted)]'
            : state === 'done' || state === 'archived'
              ? 'text-[var(--color-text-faint)]'
              : 'border border-[var(--color-border)] text-[var(--color-text-muted)]',
      )}
    >
      {WORK_STATE_LABEL[state]}
    </span>
  );
}

export function AlbatrossesSurface() {
  const { isAuthenticated } = useConvexAuth();
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const [showClosed, setShowClosed] = useState(false);
  const rows = useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? {} : 'skip') as
    | WorkListItem[]
    | undefined;

  const groups = useMemo(() => {
    const byState = new Map<WorkStateKey, WorkListItem[]>();
    for (const item of rows || []) {
      const key = workStateKey(item);
      const bucket = byState.get(key);
      if (bucket) bucket.push(item);
      else byState.set(key, [item]);
    }
    return WORK_STATE_ORDER.map((key) => ({ key, items: byState.get(key) || [] })).filter(
      (group) => group.items.length > 0,
    );
  }, [rows]);

  // 'unresolved' stays in the open half on purpose: those questions are the
  // whole reason this surface exists, and hiding them behind "Show finished"
  // would repeat the bug this round set out to fix.
  const openGroups = groups.filter((group) => group.key !== 'done' && group.key !== 'archived');
  const closedGroups = groups.filter((group) => group.key === 'done' || group.key === 'archived');
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
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3">
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-5">
        <div className="mx-auto max-w-3xl">
          {visibleGroups.length === 0 ? <EmptyState /> : null}
          {visibleGroups.map((group) => (
            <div key={group.key} className="mb-8">
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="font-serif text-[15px] font-semibold">{WORK_STATE_LABEL[group.key]}</h2>
                <p className="text-[12px] text-[var(--color-text-faint)]">{WORK_STATE_HINT[group.key]}</p>
              </div>
              <ul className="divide-y divide-[var(--color-border)]/60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                {group.items.map((item) => (
                  <li key={item._id}>
                    <button
                      type="button"
                      onClick={() => setSelectedWorkId(item._id)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 text-left transition-colors hover:bg-[var(--color-bg-subtle)]',
                        needsYou(item) || workStateKey(item) === 'unresolved' ? 'py-4' : 'py-3',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate',
                            needsYou(item) || workStateKey(item) === 'unresolved'
                              ? 'font-serif text-[16px] font-semibold'
                              : 'text-[13.5px] font-medium',
                          )}
                        >
                          {workTitle(item)}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">
                          {nextMoveLine(item)}
                          {item.areaName ? ` · ${item.areaName}` : ''}
                        </span>
                      </span>
                      <StateChip state={workStateKey(item)} />
                    </button>
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

function EmptyState() {
  const setCaptureOpen = useClientStore((state) => state.setCaptureOpen);
  return (
    <div className="mx-auto max-w-md py-20 text-center">
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
