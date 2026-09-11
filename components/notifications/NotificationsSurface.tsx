'use client';

import { useAuth } from '@clerk/nextjs';
import { useMutation } from 'convex/react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Component, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { DailyCheckin } from '@/components/albatross/DailyCheckin';
import { Button } from '@/components/ui/button';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import {
  filterNotificationItems,
  INITIAL_NOTIFICATION_VIEW,
  NOTIFICATION_FILTERS,
  type NotificationAction,
  type NotificationFilter,
  type NotificationItem,
  type NotificationProjection,
  type NotificationViewState,
  notificationFilterCounts,
  parseNotificationViewState,
} from './model';
import { type CurrentMove, useNotifications } from './useNotifications';

const glyphs = { question: CircleHelp, approval: ShieldCheck, checkin: Clock3, update: Bell };

function timeLabel(timestamp?: number) {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

export interface NotificationsViewProps {
  projection: NotificationProjection;
  currentMove?: CurrentMove | null;
  isLoading?: boolean;
  recentLimitReached?: boolean;
  storageKey?: string;
  onRead: (item: NotificationItem) => Promise<void>;
  onDismiss: (item: NotificationItem) => Promise<void>;
  onAction: (action: NotificationAction) => Promise<void> | void;
  onOpenActivity?: () => void;
}

/** Pure presentation is shared with synthetic browser verification. */
export function NotificationsView({
  projection,
  currentMove,
  isLoading = false,
  recentLimitReached,
  storageKey,
  onRead,
  onDismiss,
  onAction,
  onOpenActivity,
}: NotificationsViewProps) {
  const [view, setView] = useState<NotificationViewState>(INITIAL_NOTIFICATION_VIEW);
  const [hydrated, setHydrated] = useState(false);
  const viewRef = useRef(view);
  const scrollTopRef = useRef(0);
  const pendingScrollRestore = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const actionEpoch = useRef(0);
  const allItems = [...projection.attention, ...projection.updates];
  const selected = allItems.find((item) => item.id === view.selectedId) || null;
  viewRef.current = { ...view, scrollTop: scrollTopRef.current };

  useEffect(() => {
    let restored = INITIAL_NOTIFICATION_VIEW;
    if (storageKey) {
      try {
        restored = parseNotificationViewState(sessionStorage.getItem(storageKey));
      } catch {
        /* Private mode may deny view-state storage. */
      }
    }
    setView(restored);
    scrollTopRef.current = restored.scrollTop;
    pendingScrollRestore.current = restored.scrollTop;
    viewRef.current = restored;
    setHydrated(true);
    return () => {
      if (storageKey) {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(viewRef.current));
        } catch {
          /* View-state persistence is optional; no user content is stored. */
        }
      }
    };
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated || isLoading || pendingScrollRestore.current === null) return;
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const observer = new ResizeObserver(() => scheduleRestore());
    const restore = () => {
      // The list may be hidden behind phone detail. Restore once it is visible
      // and actual rows have loaded, not against the shorter loading skeleton.
      if (list.clientHeight > 0 && pendingScrollRestore.current !== null) {
        list.scrollTop = pendingScrollRestore.current;
        scrollTopRef.current = list.scrollTop;
        viewRef.current = { ...viewRef.current, scrollTop: list.scrollTop };
        pendingScrollRestore.current = null;
        observer.disconnect();
      }
    };
    function scheduleRestore() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    }
    // A phone detail can become a split view without a selection change.
    // Observe visibility/size so widening the window also restores the list.
    observer.observe(list);
    scheduleRestore();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [hydrated, isLoading]);

  useEffect(() => {
    if (hydrated && storageKey) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({ ...view, scrollTop: scrollTopRef.current }));
      } catch {
        /* Keep navigation usable without browser storage. */
      }
    }
  }, [hydrated, storageKey, view]);

  // Reading an update may remove it from an unread filter. Keep the selected
  // detail visible until the user goes back, without retaining stale contents.
  const attention = filterNotificationItems(projection.attention, view.filter);
  const updates = filterNotificationItems(projection.updates, view.filter);
  const visibleItems = [...attention, ...updates];
  const counts = notificationFilterCounts(projection);
  const unreadUpdates = updates.filter((item) => item.unreadNotificationIds.length > 0);

  const applyFilter = (filter: NotificationFilter) => {
    scrollTopRef.current = 0;
    pendingScrollRestore.current = null;
    setView((current) => ({ ...current, filter, selectedId: null, scrollTop: 0 }));
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const perform = async (operation: () => Promise<void>, failure: string) => {
    if (busyRef.current) return;
    const epoch = ++actionEpoch.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    retryRef.current = operation;
    try {
      await operation();
      if (epoch === actionEpoch.current) retryRef.current = null;
    } catch {
      if (epoch === actionEpoch.current) setError(failure);
    } finally {
      if (epoch === actionEpoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const openItem = (item: NotificationItem) => {
    // Selection itself never resolves or dismisses an outstanding action.
    setView((current) => ({ ...current, selectedId: item.id, scrollTop: listRef.current?.scrollTop || 0 }));
    setError(null);
    // Reading is independent of explicit actions. A previous read in flight
    // must not prevent marking a newly opened item read.
    const epoch = ++actionEpoch.current;
    busyRef.current = false;
    setBusy(false);
    retryRef.current = null;
    if (item.unreadNotificationIds.length) {
      const operation = () => onRead(item);
      void operation().catch(() => {
        if (epoch === actionEpoch.current) {
          retryRef.current = operation;
          setError('Could not mark this notification read. Nothing has been resolved or dismissed.');
        }
      });
    }
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) detailRef.current?.focus();
    });
  };

  const goBack = () => {
    const previous = view.selectedId;
    setView((current) => ({ ...current, selectedId: null }));
    setError(null);
    actionEpoch.current++;
    busyRef.current = false;
    setBusy(false);
    retryRef.current = null;
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = viewRef.current.scrollTop;
      ((previous && rowRefs.current.get(previous)) || rowRefs.current.get(visibleItems[0]?.id))?.focus({
        preventScroll: true,
      });
    });
  };

  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === 'Escape' && selected) {
      event.preventDefault();
      goBack();
      return;
    }
    const index = visibleItems.findIndex((row) => row.id === id);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, visibleItems.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visibleItems.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      rowRefs.current.get(visibleItems[next].id)?.focus();
    }
  };

  const section = (title: string, items: NotificationItem[], empty: string, action?: ReactNode) => (
    <section aria-label={title}>
      <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] px-5 pb-2 pt-6">
        <h2 className="text-[12px] font-semibold text-[var(--color-text-muted)]">
          {title}
          <span className="ml-2 font-normal tabular-nums text-[var(--color-text-faint)]">{items.length}</span>
        </h2>
        {action}
      </div>
      {items.length ? (
        <ul>
          {items.map((item) => {
            const Glyph = glyphs[item.kind];
            return (
              <li key={item.id} className="border-b border-[var(--color-list-divider,var(--color-border))]">
                <button
                  type="button"
                  ref={(node) => {
                    if (node) rowRefs.current.set(item.id, node);
                    else rowRefs.current.delete(item.id);
                  }}
                  aria-current={selected?.id === item.id ? 'true' : undefined}
                  onClick={() => openItem(item)}
                  onKeyDown={(event) => onRowKey(event, item.id)}
                  className={cn(
                    'group flex min-h-20 w-full items-start gap-3 border-l-2 border-transparent px-[18px] py-4 text-left transition-colors hover:bg-[var(--color-hover-soft)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-ring)]',
                    selected?.id === item.id &&
                      'border-l-[var(--color-text-muted)] bg-[var(--color-control)]',
                  )}
                >
                  <Glyph className="mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-[13px] leading-[1.45]',
                        item.attention || item.unread
                          ? 'font-medium text-[var(--color-text)]'
                          : 'text-[var(--color-text-muted)]',
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="mt-1 block truncate text-[11.5px] text-[var(--color-text-faint)]">
                      {item.context}
                    </span>
                    <span className="mt-2 block text-[10.5px] text-[var(--color-text-faint)]">
                      {item.source}
                      {item.createdAt ? (
                        <>
                          {' '}
                          ·{' '}
                          <time dateTime={new Date(item.createdAt).toISOString()}>
                            {timeLabel(item.createdAt)}
                          </time>
                        </>
                      ) : null}
                    </span>
                  </span>
                  {item.unread ? (
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-text)]">
                      <span className="sr-only">Unread</span>
                    </span>
                  ) : (
                    <ChevronRight
                      className="mt-0.5 size-3.5 shrink-0 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-7 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{empty}</p>
      )}
    </section>
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-bg-elevated)]"
      data-notifications-workspace
    >
      <header className="shrink-0 border-b border-[var(--color-border)] px-5 pb-3 pt-5 sm:px-7">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h1 className="font-serif text-[25px] tracking-tight text-[var(--color-text)]">Notifications</h1>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]" aria-live="polite">
              {isLoading
                ? 'Finding what needs you…'
                : `${projection.attention.length} waiting on you · ${projection.unreadUpdates} unread updates`}
            </p>
          </div>
          {onOpenActivity && (
            <Button variant="ghost" size="sm" onClick={onOpenActivity} className="-mr-2 h-9 shrink-0">
              Activity history <ArrowUpRight className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
        {/* The filter is a row of pressed buttons with live counts, so the
            shape of the inbox reads before a single row does. */}
        <fieldset className="-mx-1 mt-3 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Filter notifications</legend>
          {NOTIFICATION_FILTERS.map((filter) => {
            const active = view.filter === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={active}
                onClick={() => applyFilter(filter.value)}
                className={cn(
                  'flex h-9 items-center gap-1.5 rounded-ui px-3 text-[12px] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-ring)]',
                  active
                    ? 'bg-[var(--color-control)] font-medium text-[var(--color-text)] shadow-[var(--shadow-control)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-soft)] hover:text-[var(--color-text)]',
                )}
              >
                {filter.label}
                <span
                  className={cn(
                    'tabular-nums',
                    active ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-faint)]',
                  )}
                >
                  {isLoading ? '–' : counts[filter.value]}
                </span>
              </button>
            );
          })}
        </fieldset>
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          ref={listRef}
          data-notifications-list
          onScroll={(event) => {
            if (pendingScrollRestore.current !== null) return;
            const scrollTop = event.currentTarget.scrollTop;
            scrollTopRef.current = scrollTop;
            // Preserve position without rendering on every scroll event.
            viewRef.current = { ...viewRef.current, scrollTop };
          }}
          className={cn(
            'min-h-0 w-full shrink-0 overflow-y-auto overscroll-contain lg:block lg:w-[min(42%,440px)] lg:border-r lg:border-[var(--color-border)]',
            selected && 'hidden',
          )}
        >
          {isLoading ? (
            <div role="status" className="space-y-6 px-5 py-8">
              <span className="sr-only">Loading notifications</span>
              {[0, 1, 2, 3, 4].map((key) => (
                <div key={key} className="space-y-2">
                  <div className="h-3 w-4/5 rounded bg-[var(--color-control)]" />
                  <div className="h-2.5 w-1/2 rounded bg-[var(--color-control)]" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {section(
                'Needs your attention',
                attention,
                view.filter === 'all'
                  ? 'Nothing needs you right now.'
                  : 'No waiting items match this filter.',
              )}
              {section(
                'Updates',
                updates,
                view.filter === 'all'
                  ? 'No new updates. Your history lives in Activity.'
                  : 'No updates match this filter.',
                unreadUpdates.length > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        for (const item of unreadUpdates) await onRead(item);
                      }, 'Could not mark these updates read. They are still unread.')
                    }
                    className="text-[11.5px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline disabled:opacity-60"
                  >
                    Mark all read
                  </button>
                ) : null,
              )}
              <div className="space-y-3 px-5 py-6 text-[11px] text-[var(--color-text-faint)]">
                {recentLimitReached && (
                  <p>Showing your 100 most recent deliveries, plus pending decisions.</p>
                )}
                {onOpenActivity && (
                  <Button variant="ghost" size="sm" onClick={onOpenActivity} className="-ml-2 h-11">
                    View Activity history <ArrowUpRight className="size-3.5" aria-hidden />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
        <section
          ref={detailRef}
          tabIndex={-1}
          aria-label="Notification details"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              goBack();
            }
          }}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none lg:block',
            !selected && 'hidden',
          )}
        >
          {selected ? (
            <div className="mx-auto flex min-h-full max-w-[720px] flex-col px-5 py-5 sm:px-8 sm:py-7">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mb-6 h-11 self-start lg:hidden"
                onClick={goBack}
              >
                <ArrowLeft className="size-4" aria-hidden /> Back to notifications
              </Button>
              <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--color-text-muted)]">
                {selected.source}
                {selected.attention && (
                  <span className="border-l border-[var(--color-border)] pl-2 normal-case tracking-normal">
                    Waiting on you
                  </span>
                )}
              </div>
              <h2 className="mt-3 text-[22px] font-medium leading-snug tracking-tight text-[var(--color-text)]">
                {selected.title}
              </h2>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                {selected.context}
              </p>
              {selected.createdAt && (
                <time
                  className="mt-1 text-[11px] text-[var(--color-text-faint)]"
                  dateTime={new Date(selected.createdAt).toISOString()}
                >
                  {timeLabel(selected.createdAt)}
                </time>
              )}
              <p className="my-7 whitespace-pre-wrap break-words text-[14px] leading-[1.75] text-[var(--color-text)]">
                {selected.body}
              </p>
              {selected.attention && (
                <p className="mb-5 border-l-2 border-[var(--color-border-strong)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                  Opening this does not resolve it. It stays here until you handle it.
                </p>
              )}
              <div className="mt-auto border-t border-[var(--color-border)] pt-5">
                {error && (
                  <div role="alert" className="mb-4 text-[12px] text-[var(--color-danger)]">
                    {error}{' '}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11"
                      disabled={busy}
                      onClick={() => {
                        if (retryRef.current)
                          void perform(
                            retryRef.current,
                            'Still could not save this change. Please try again.',
                          );
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {selected.action && (
                    <Button
                      className="h-11"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          if (selected.action) await onAction(selected.action);
                        }, 'Could not open this action. Please try again.')
                      }
                    >
                      {selected.actionLabel}
                      <ArrowUpRight className="size-4" aria-hidden />
                    </Button>
                  )}
                  {!selected.attention && selected.notificationIds.length > 0 && (
                    <Button
                      variant="ghost"
                      className="h-11"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await onDismiss(selected);
                          // A slow dismissal must not close a different item
                          // the user opened while the request was in flight.
                          if (viewRef.current.selectedId === selected.id) goBack();
                        }, 'Could not dismiss this update. It is still here.')
                      }
                    >
                      <X className="size-4" aria-hidden />
                      Dismiss update
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-full flex-col items-center justify-center px-8 py-12 text-center">
              <Check className="mb-5 size-6 text-[var(--color-text-faint)]" aria-hidden />
              <p className="font-serif text-[22px] text-[var(--color-text)]">
                {projection.count ? 'A little attention goes a long way.' : 'You’re caught up.'}
              </p>
              <p className="mt-2 max-w-xs text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                Select a notification to see its context and next step.
              </p>
              {currentMove && (
                <button
                  type="button"
                  className="mt-8 max-w-sm border-t border-[var(--color-border)] pt-5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]"
                  onClick={() =>
                    void perform(async () => {
                      await onAction({ kind: 'work', workId: currentMove.workId });
                    }, 'Could not open your next step.')
                  }
                >
                  <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                    When you’re ready
                  </span>
                  <span className="mt-2 block text-[13px] font-medium">
                    {currentMove.stepTitle} <ArrowUpRight className="inline size-3.5" aria-hidden />
                  </span>
                  <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                    {currentMove.workTitle}
                  </span>
                </button>
              )}
              {error && (
                <p role="alert" className="mt-4 text-[12px] text-[var(--color-danger)]">
                  {error}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ConnectedNotifications({ onOpenActivity }: { onOpenActivity?: () => void }) {
  const data = useNotifications();
  const { userId } = useAuth();
  const router = useRouter();
  const mark = useMutation(api.albatrossNotifications.markNotification);
  const openCheckin = useMutation(api.albatrossNotifications.openCheckin);
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const setSelectedWorkId = useClientStore((state) => state.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((state) => state.setSelectedAreaId);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const onAction = async (action: NotificationAction) => {
    if (action.kind === 'work') {
      setSelectedWorkId(action.workId);
      if (action.areaId) setSelectedAreaId(action.areaId);
      setPrimaryView('albatrosses');
    } else if (action.kind === 'area') {
      setSelectedAreaId(action.areaId);
      setPrimaryView('areas');
    } else if (action.kind === 'checkin') {
      await openCheckin({ checkinId: action.checkinId as Id<'albatrossDailyCheckins'> });
      setCheckinOpen(true);
    } else if (action.kind === 'url') {
      router.push(action.url);
    } else if (action.kind === 'view') {
      setPrimaryView(action.view);
    } else {
      setPrimaryView(action.kind);
    }
  };
  return (
    <>
      <NotificationsView
        {...data}
        storageKey={userId ? `albatross.notifications.v1:${userId}` : undefined}
        onRead={async (item) => {
          await Promise.all(
            item.unreadNotificationIds.map((id) =>
              mark({ notificationId: id as Id<'albatrossNotifications'>, status: 'read' }),
            ),
          );
        }}
        onDismiss={async (item) => {
          await Promise.all(
            item.notificationIds.map((id) =>
              mark({ notificationId: id as Id<'albatrossNotifications'>, status: 'dismissed' }),
            ),
          );
        }}
        onAction={onAction}
        onOpenActivity={onOpenActivity || (() => setPrimaryView('activity'))}
      />
      <DailyCheckin checkin={data.checkin} open={checkinOpen} onOpenChange={setCheckinOpen} />
    </>
  );
}

class NotificationsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div role="alert" className="p-7">
          <h1 className="font-serif text-2xl">Notifications</h1>
          <p className="my-4 text-sm text-[var(--color-text-muted)]">
            Could not load notifications. Your pending decisions have not changed.
          </p>
          <Button variant="outline" className="h-11" onClick={() => this.setState({ failed: false })}>
            Retry
          </Button>
        </div>
      );
    return this.props.children;
  }
}

export function NotificationsSurface({ onOpenActivity }: { onOpenActivity?: () => void } = {}) {
  return (
    <NotificationsBoundary>
      <ConnectedNotifications onOpenActivity={onOpenActivity} />
    </NotificationsBoundary>
  );
}
