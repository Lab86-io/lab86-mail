'use client';

// The thread rail beside an open thread (docs/albatross-threads.md, T1–T3,
// T10, T12; lead decisions 1–4, 10). It is the same list as the full page,
// narrow: three groups, the filter pills, the hover actions, one polite live
// region, and a roving tab stop. The order holds while the pointer is in the
// rail, so a row never moves under the hand.

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ANNOUNCE_EVERY_MS,
  announcementText,
  countThreads,
  holdThreadOrder,
  RAIL_EMPTY_COPY,
  railThreadGroups,
  THREAD_FILTER_LABEL,
  THREAD_FILTERS,
  THREAD_GROUP_LABEL,
  THREAD_ROW_COPY,
  type ThreadRowActionKind,
  threadEvents,
} from '@/lib/albatross/thread-list-view';
import { railScrollTop, setRailScrollTop } from '@/lib/albatross/thread-memory';
import {
  filterThreadRows,
  type ThreadFilter,
  type ThreadRow as ThreadRowData,
} from '@/lib/albatross/threads';
import { cn } from '@/lib/utils';
import { ThreadRow } from './ThreadRow';

export interface ThreadRailProps {
  /** Every awake row, closed ones included (they count at the foot). Undefined while it loads. */
  rows: readonly ThreadRowData[] | undefined;
  laterCount?: number;
  openWorkId: string | null;
  filter: ThreadFilter;
  onFilterChange: (filter: ThreadFilter) => void;
  nowMs: number;
  timeZone?: string;
  locale?: string;
  /** The area, when the rail shows inside an Area. */
  areaName?: string | null;
  draftWorkIds?: ReadonlySet<string>;
  onOpen: (workId: string) => void;
  onAction?: (kind: ThreadRowActionKind, row: ThreadRowData) => void;
  onSteer?: (row: ThreadRowData, text: string) => Promise<boolean>;
  onMarkUnread?: (row: ThreadRowData) => void;
  /** The in-place answer panel of the row being answered. */
  answeringWorkId?: string | null;
  renderAnswer?: (row: ThreadRowData) => ReactNode;
  /** The foot links: the full list with its finished and later groups. */
  onShowFinished?: () => void;
  onShowLater?: () => void;
  /** 300 px on desktops, 272 px on laptops. */
  width?: 300 | 272;
  className?: string;
}

export const THREAD_RAIL_COPY = {
  title: 'Albatrosses',
  filterGroup: 'Filter the threads',
  list: 'Threads',
  loading: 'Loading…',
  capture: 'Get this off my mind',
} as const;

export function ThreadRail({
  rows,
  laterCount = 0,
  openWorkId,
  filter,
  onFilterChange,
  nowMs,
  timeZone,
  locale,
  areaName,
  draftWorkIds,
  onOpen,
  onAction,
  onSteer,
  onMarkUnread,
  answeringWorkId,
  renderAnswer,
  onShowFinished,
  onShowLater,
  width = 300,
  className,
}: ThreadRailProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const shownRef = useRef<ThreadRowData[]>([]);
  const counts = useMemo(() => countThreads(rows ?? []), [rows]);

  const visible = useMemo(() => {
    const filtered = filterThreadRows(rows ?? [], filter).filter((row) => !row.closed);
    return holdThreadOrder(shownRef.current, filtered, held);
  }, [rows, filter, held]);
  useEffect(() => {
    shownRef.current = visible;
  }, [visible]);
  const groups = useMemo(() => railThreadGroups(visible), [visible]);

  // The rail mounts again with each thread: put it back where it was, then
  // bring the open row into view only if a hop moved it out of view.
  const placedRef = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || placedRef.current || rows === undefined) return;
    placedRef.current = true;
    list.scrollTop = railScrollTop();
    const open = [...list.querySelectorAll<HTMLElement>('[data-thread-row]')].find(
      (item) => item.dataset.threadRow === openWorkId,
    );
    open?.scrollIntoView?.({ block: 'nearest' });
  }, [rows, openWorkId]);

  const announcement = useAnnouncements(rows, openWorkId);

  // Roving tab stop: the open row, else the first row, is the one tab stop.
  const focusTargetId = visible.some((row) => row.workId === openWorkId)
    ? openWorkId
    : (visible[0]?.workId ?? null);

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const list = listRef.current;
    if (!list) return;
    const mains = [...list.querySelectorAll<HTMLButtonElement>('[data-thread-row-main]')];
    const current = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-thread-row]');
    const index = mains.findIndex((main) => main.closest('[data-thread-row]') === current);
    const move = (target: HTMLElement | undefined) => {
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        if (!event.metaKey && !event.ctrlKey) move(mains[index + 1]);
        break;
      case 'ArrowUp':
        if (!event.metaKey && !event.ctrlKey) move(mains[index - 1]);
        break;
      case 'Home':
        move(mains[0]);
        break;
      case 'End':
        move(mains[mains.length - 1]);
        break;
      case 'ArrowRight':
        move(current?.querySelector<HTMLButtonElement>('[data-thread-row-action]') ?? undefined);
        break;
      default:
        break;
    }
  };

  return (
    <nav
      aria-label={THREAD_RAIL_COPY.title}
      data-thread-rail
      style={{ width }}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]',
        className,
      )}
    >
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <h2 className="min-w-0 truncate font-serif text-[15px] font-semibold tracking-tight">
          {THREAD_RAIL_COPY.title}
          {areaName ? (
            <span className="font-sans text-[12px] font-normal text-[var(--color-text-muted)]">
              {' '}
              · {areaName}
            </span>
          ) : null}
        </h2>
        <span aria-hidden className="ml-auto font-mono text-[11px] text-[var(--color-text-faint)]">
          {THREAD_ROW_COPY.hopHint}
        </span>
      </div>

      <fieldset className="m-0 min-w-0 border-0 p-0 flex gap-0.5 px-2.5 pb-1.5 pt-2">
        <legend className="sr-only">{THREAD_RAIL_COPY.filterGroup}</legend>
        {THREAD_FILTERS.map((key) => {
          const count = key === 'all' ? counts.all : key === 'needs_you' ? counts.needsYou : counts.working;
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(key)}
              className={cn(
                'inline-flex h-[26px] items-center gap-1.5 rounded-ui px-2.5 text-[12.5px] transition-colors',
                active
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
              )}
            >
              {THREAD_FILTER_LABEL[key]}
              <span
                className={cn(
                  'text-[11.5px] tabular-nums',
                  active ? 'opacity-70' : 'text-[var(--color-text-faint)]',
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </fieldset>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={(event) => setRailScrollTop(event.currentTarget.scrollTop)}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocusCapture={() => setHeld(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
        }}
      >
        {rows === undefined ? (
          <p className="px-2 pt-4 text-[12.5px] text-[var(--color-text-muted)]">{THREAD_RAIL_COPY.loading}</p>
        ) : visible.length === 0 ? (
          <RailEmpty filter={filter} />
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={THREAD_GROUP_LABEL[group.key]} className="pt-2">
              <div className="flex items-baseline gap-2 px-2 pb-1 text-[11.5px] text-[var(--color-text-faint)]">
                <span>{THREAD_GROUP_LABEL[group.key]}</span>
                <span className="tabular-nums">{group.rows.length}</span>
                <span aria-hidden className="h-px flex-1 self-center bg-[var(--color-border)]" />
              </div>
              <ul className="flex flex-col">
                {group.rows.map((row) => (
                  <li key={row.workId}>
                    <ThreadRow
                      row={row}
                      variant="rail"
                      open={row.workId === openWorkId}
                      nowMs={nowMs}
                      timeZone={timeZone}
                      locale={locale}
                      hasDraft={draftWorkIds?.has(row.workId)}
                      tabIndex={row.workId === focusTargetId ? 0 : -1}
                      onKeyDown={onRowKeyDown}
                      onOpen={(target) => onOpen(target.workId)}
                      onAction={onAction}
                      onSteer={onSteer}
                      onMarkUnread={onMarkUnread}
                      inPlace={answeringWorkId === row.workId && renderAnswer ? renderAnswer(row) : null}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {counts.finished || laterCount ? (
        <div className="flex shrink-0 gap-4 px-4 pb-3 pt-1.5 text-[12px] text-[var(--color-text-faint)]">
          {counts.finished ? (
            <button type="button" onClick={onShowFinished} className="hover:text-[var(--color-text)]">
              {THREAD_ROW_COPY.finishedFoot} · {counts.finished}
            </button>
          ) : null}
          {laterCount ? (
            <button type="button" onClick={onShowLater} className="hover:text-[var(--color-text)]">
              {THREAD_ROW_COPY.laterFoot} · {laterCount}
            </button>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite" aria-atomic="true" className="sr-only" data-thread-announcer>
        {announcement}
      </div>
    </nav>
  );
}

function RailEmpty({ filter }: { filter: ThreadFilter }) {
  const copy = RAIL_EMPTY_COPY[filter];
  return (
    <div data-thread-rail-empty={filter} className="px-3 pt-8 text-center">
      <p className="font-serif text-[15px] font-semibold">{copy.title}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{copy.detail}</p>
    </div>
  );
}

/**
 * One merged announcement at most every five seconds (lead decision 10): rows
 * that enter "needs you", finished runs and replies, and runs that did not
 * finish. The open thread announces through its own run block.
 */
function useAnnouncements(rows: readonly ThreadRowData[] | undefined, openWorkId: string | null) {
  const [announcement, setAnnouncement] = useState('');
  const previousRef = useRef<readonly ThreadRowData[] | undefined>(undefined);
  const pendingRef = useRef<string[]>([]);
  const lastAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = rows;
    if (!rows || !previous) return;
    const text = announcementText(threadEvents(previous, rows, openWorkId));
    if (!text) return;
    pendingRef.current.push(text);
    const flush = () => {
      timerRef.current = null;
      const merged = pendingRef.current.join(' ');
      pendingRef.current = [];
      if (!merged) return;
      lastAtRef.current = Date.now();
      setAnnouncement(merged);
    };
    const wait = Math.max(0, ANNOUNCE_EVERY_MS - (Date.now() - lastAtRef.current));
    if (timerRef.current === null) timerRef.current = window.setTimeout(flush, wait);
  }, [rows, openWorkId]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return announcement;
}
