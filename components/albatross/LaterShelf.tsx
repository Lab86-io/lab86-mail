'use client';

import { type KeyboardEvent, useRef } from 'react';
import { LaterCard, type LaterCardWork } from '@/components/albatross/LaterCard';
import { laterShelf } from '@/lib/albatross/horizon';
import { cn } from '@/lib/utils';

export interface LaterShelfItem extends LaterCardWork {
  updatedAt: number;
}

export interface LaterStop<T extends LaterShelfItem = LaterShelfItem> {
  work: T;
  /** A mono month label above the hairline. Set on the first card of each month. */
  monthLabel: string | null;
  /** True for Work without a wake date. Those sit after a gap under "Someday". */
  someday: boolean;
  /** True for the first card without a wake date. It carries the "Someday" word. */
  firstSomeday: boolean;
}

function monthLabel(ms: number, nowMs: number, locale: string): string {
  const date = new Date(ms);
  if (date.getFullYear() === new Date(nowMs).getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short' });
  }
  return date.toLocaleDateString(locale, { month: 'short', year: 'numeric' });
}

/**
 * The stops on the rail, in wake order. Dated Work first, sorted by date, with
 * one month label where the month changes. Undated Work follows under one
 * "Someday" word.
 */
export function laterShelfStops<T extends LaterShelfItem>(
  items: T[],
  nowMs: number,
  locale = 'en-US',
): Array<LaterStop<T>> {
  const rows = laterShelf(items, nowMs);
  const stops: Array<LaterStop<T>> = [];
  let lastMonth: string | null = null;
  let somedaySeen = false;
  for (const work of rows) {
    const notBefore = work.horizon?.notBefore;
    if (typeof notBefore === 'number' && notBefore > nowMs) {
      const date = new Date(notBefore);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const label = key === lastMonth ? null : monthLabel(notBefore, nowMs, locale);
      lastMonth = key;
      stops.push({ work, monthLabel: label, someday: false, firstSomeday: false });
      continue;
    }
    stops.push({ work, monthLabel: null, someday: true, firstSomeday: !somedaySeen });
    somedaySeen = true;
  }
  return stops;
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/**
 * The Later rail. One hairline, cards on it at their wake date, month labels
 * above. Below 640 px the rail becomes a list with the date on the right.
 * When nothing sleeps, the shelf does not render.
 */
export function LaterShelf({
  items,
  nowMs,
  onOpen,
  activeId = null,
}: {
  items: LaterShelfItem[];
  nowMs: number;
  onOpen: (workId: string) => void;
  activeId?: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const stops = laterShelfStops(items, nowMs);
  if (!stops.length) return null;

  const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
    const forward = NEXT_KEYS.has(event.key);
    const backward = PREVIOUS_KEYS.has(event.key);
    if (!forward && !backward) return;
    const cards = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-later-card]') || [])];
    if (!cards.length) return;
    const index = cards.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? 0 : Math.min(Math.max(index + (forward ? 1 : -1), 0), cards.length - 1);
    event.preventDefault();
    cards[next]?.focus();
    cards[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 hidden h-px bg-[var(--color-border)] sm:block"
      />
      <ul
        ref={listRef}
        aria-label="Later"
        onKeyDown={moveFocus}
        className={cn(
          'no-scrollbar flex list-none flex-col gap-2 p-0',
          'sm:h-[120px] sm:snap-x sm:snap-mandatory sm:flex-row sm:items-stretch sm:gap-3 sm:overflow-x-auto sm:pr-6',
        )}
      >
        {stops.map((stop) => (
          <li
            key={stop.work._id}
            className={cn(
              'relative flex flex-col justify-center sm:snap-start',
              stop.firstSomeday && 'sm:ml-10',
            )}
          >
            {stop.monthLabel ? (
              <span
                aria-hidden
                className="absolute left-1 top-1 hidden font-mono text-[10.5px] tracking-wide text-[var(--color-text-faint)] sm:block"
              >
                {stop.monthLabel}
              </span>
            ) : null}
            {stop.firstSomeday ? (
              <span className="absolute left-1 top-1 hidden text-[11px] text-[var(--color-text-faint)] sm:block">
                Someday
              </span>
            ) : null}
            <LaterCard
              work={stop.work}
              nowMs={nowMs}
              active={activeId === stop.work._id}
              onOpen={() => onOpen(stop.work._id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
