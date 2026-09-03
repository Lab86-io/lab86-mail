'use client';

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HORIZON_SAVE_ERROR, HorizonControl } from '@/components/albatross/HorizonControl';
import { useEntered } from '@/components/albatross/LaterCard';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import type { WorkHorizon } from '@/lib/albatross/horizon';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';

export interface WakeNotification {
  _id: string;
  type: string;
  title: string;
  body?: string;
  status: string;
  entityKind?: string;
  entityId?: string;
  createdAt: number;
}

export const WAKE_NUDGE_MAX = 3;

/** The wakes that still wait for the user: newest first, at most three. */
export function wakeNudges<T extends WakeNotification>(rows: T[], max = WAKE_NUDGE_MAX): T[] {
  return rows
    .filter(
      (row) =>
        row.type === 'work_wake' &&
        row.entityKind === 'work' &&
        Boolean(row.entityId) &&
        (row.status === 'queued' || row.status === 'delivered'),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, max);
}

/** The exit takes this long, then the row leaves the stack. */
export const WAKE_NUDGE_EXIT_MS = 200;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * One nudge panel. It slides in 24 px from the right edge on mount and slides
 * out the same way when it leaves.
 */
function WakeNudgePanel({
  row,
  leaving,
  children,
}: {
  row: WakeNotification;
  leaving: boolean;
  children: React.ReactNode;
}) {
  const entered = useEntered();
  const shown = entered && !leaving;
  return (
    <section
      data-wake-nudge={row.entityId}
      aria-hidden={leaving || undefined}
      className={cn(
        'pointer-events-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--shadow-soft)]',
        'transition-[transform,opacity] motion-reduce:transition-none',
        leaving
          ? 'duration-[var(--duration-normal)] ease-[var(--ease-exit)]'
          : 'duration-[var(--duration-moderate)] ease-[var(--ease-enter)]',
        shown ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
        'motion-reduce:translate-x-0',
        leaving ? 'motion-reduce:opacity-0' : 'motion-reduce:opacity-100',
      )}
    >
      {children}
    </section>
  );
}

/**
 * The wake nudge. A dormant Work came back. One line, two text buttons. It
 * slides in from the right edge and stays until the user answers. Wakes stack,
 * newest on top. This is the only surface that shows a wake.
 */
export function WakeNudge({
  notifications,
  nowMs,
  onOpen,
  onLater,
  onDismiss,
  laterError = null,
  saving = null,
}: {
  notifications: WakeNotification[];
  nowMs: number;
  onOpen: (row: WakeNotification) => void;
  onLater: (row: WakeNotification, horizon: WorkHorizon | null) => void;
  onDismiss: (row: WakeNotification) => void;
  laterError?: string | null;
  saving?: string | null;
}) {
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef<number[]>([]);
  const rows = wakeNudges(notifications);
  const top = rows.find((row) => !leaving.has(row._id)) ?? null;

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  // The panel slides out first. The handler runs when the slide is done.
  const leave = useCallback((row: WakeNotification, then: () => void) => {
    if (typeof window === 'undefined' || prefersReducedMotion()) {
      then();
      return;
    }
    setLeaving((current) => new Set([...current, row._id]));
    timers.current.push(window.setTimeout(then, WAKE_NUDGE_EXIT_MS));
  }, []);

  useEffect(() => {
    if (!top || typeof window === 'undefined') return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      const idle = !active || active === document.body;
      if (event.key === 'Escape') {
        if (laterFor) return;
        event.preventDefault();
        leave(top, () => onDismiss(top));
      } else if (event.key === 'Enter' && idle && !laterFor) {
        event.preventDefault();
        leave(top, () => onOpen(top));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [top, laterFor, onDismiss, onOpen, leave]);

  if (!rows.length) return null;

  return (
    <section
      aria-label="Work that came back"
      className="pointer-events-none absolute right-4 top-4 z-40 flex w-[min(360px,calc(100%-2rem))] flex-col gap-2"
    >
      {rows.map((row) => {
        const laterOpen = laterFor === row._id;
        return (
          <WakeNudgePanel key={row._id} row={row} leaving={leaving.has(row._id)}>
            <div className="flex items-start gap-3">
              <p className="min-w-0 flex-1 font-serif text-[15px] font-semibold leading-snug">{row.title}</p>
              <button
                type="button"
                aria-label="Close"
                onClick={() => leave(row, () => onDismiss(row))}
                className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
              >
                <X className="size-3.5" />
              </button>
            </div>
            {laterOpen ? (
              <div className="mt-3">
                <HorizonControl
                  value={{ kind: 'later' }}
                  nowMs={nowMs}
                  autoFocus
                  saving={saving === row._id}
                  error={laterError}
                  onCancel={() => setLaterFor(null)}
                  // No slide-out here: the row leaves when the save lands, and
                  // a failed save must keep the panel and show its error.
                  onChange={(horizon) => onLater(row, horizon)}
                  className="items-start"
                />
              </div>
            ) : (
              <div className="mt-2.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => leave(row, () => onOpen(row))}
                  className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => setLaterFor(row._id)}
                  className="text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
                >
                  Later
                </button>
              </div>
            )}
          </WakeNudgePanel>
        );
      })}
    </section>
  );
}

/**
 * The shell host. It reads the live notification rows and turns the wake
 * rows into nudges. "Open" goes to the Work. "Later" sets a new horizon
 * through the same mutation the Work page uses.
 */
export function WakeNudgeHost() {
  const { isAuthenticated } = useConvexAuth();
  const center = useQuery(api.albatrossNotifications.liveCenter, isAuthenticated ? { limit: 50 } : 'skip') as
    | { notifications: WakeNotification[] }
    | undefined;
  const mark = useMutation(api.albatrossNotifications.markNotification);
  const setHorizon = useMutation(api.albatrossWorkV2.setHorizon);
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [saving, setSaving] = useState<string | null>(null);
  const [laterError, setLaterError] = useState<string | null>(null);
  // A row the user already answered must leave at once, before the server
  // row catches up.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const settle = useCallback((id: string) => setSettled((current) => new Set([...current, id])), []);

  const onOpen = useCallback(
    (row: WakeNotification) => {
      settle(row._id);
      void mark({ notificationId: row._id as Id<'albatrossNotifications'>, status: 'acted' }).catch(
        () => undefined,
      );
      if (row.entityId) {
        setSelectedWorkId(row.entityId);
        setPrimaryView('albatrosses');
      }
    },
    [mark, setPrimaryView, setSelectedWorkId, settle],
  );

  const onDismiss = useCallback(
    (row: WakeNotification) => {
      settle(row._id);
      void mark({ notificationId: row._id as Id<'albatrossNotifications'>, status: 'dismissed' }).catch(
        () => undefined,
      );
    },
    [mark, settle],
  );

  const onLater = useCallback(
    async (row: WakeNotification, horizon: WorkHorizon | null) => {
      if (!row.entityId) return;
      setSaving(row._id);
      setLaterError(null);
      try {
        await setHorizon({ workId: row.entityId as Id<'albatrossIntents'>, horizon });
        await mark({ notificationId: row._id as Id<'albatrossNotifications'>, status: 'acted' }).catch(
          () => undefined,
        );
        settle(row._id);
      } catch {
        setLaterError(HORIZON_SAVE_ERROR);
      } finally {
        setSaving(null);
      }
    },
    [mark, setHorizon, settle],
  );

  const rows = (center?.notifications || []).filter((row) => !settled.has(row._id));
  return (
    <WakeNudge
      notifications={rows}
      nowMs={nowMs}
      onOpen={onOpen}
      onLater={(row, horizon) => void onLater(row, horizon)}
      onDismiss={onDismiss}
      laterError={laterError}
      saving={saving}
    />
  );
}
