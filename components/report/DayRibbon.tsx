'use client';

import { useMemo } from 'react';
import {
  nowMarker,
  openAirLine,
  ribbonBlocks,
  ribbonGaps,
  ribbonTicks,
  ribbonWindow,
} from '@/lib/albatross/day-ribbon';
import type { TodayEvent } from '@/lib/albatross/today';
import { cn } from '@/lib/utils';

/**
 * The day, drawn to scale.
 *
 * Fixed blocks are solid and sit against an hour rail. Open air is dashed and
 * labelled with what it is worth, because "two hours free after three" is the
 * fact that decides whether anything can move today — and no agenda list has
 * ever said it out loud.
 *
 * The now-line is the one live element on the page: a hairline in the accent
 * with a filled cap, so the eye finds the present before it reads anything.
 */
export function DayRibbon({
  events,
  nowMs,
  height = 300,
}: {
  events: TodayEvent[];
  nowMs: number;
  height?: number;
}) {
  const window = useMemo(() => ribbonWindow(events, nowMs), [events, nowMs]);
  const blocks = useMemo(() => ribbonBlocks(events, window), [events, window]);
  const gaps = useMemo(() => ribbonGaps(blocks, window, nowMs), [blocks, window, nowMs]);
  const ticks = useMemo(() => ribbonTicks(window), [window]);
  const marker = nowMarker(nowMs, window);
  const allDay = events.filter((event) => event.allDay && event.status !== 'cancelled');

  return (
    <div>
      {allDay.length ? (
        <ul className="mb-2 space-y-1">
          {allDay.map((event) => (
            <li
              key={event._id}
              className="rounded-md border-l-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-accent)]"
            >
              {event.title}
              <span className="ml-1.5 font-normal opacity-70">all day</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative flex" style={{ height }}>
        {/* Hour rail. Small, quiet, and the only numerals on the surface. */}
        <div className="relative w-9 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick.hour}
              className="absolute -translate-y-1/2 font-mono text-[10px] tabular-nums text-[var(--color-text-faint)]"
              style={{ top: `${tick.top * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1 border-l border-[var(--color-border)]">
          {ticks.map((tick) => (
            <span
              key={tick.hour}
              aria-hidden
              className="absolute inset-x-0 h-px bg-[var(--color-border)]/50"
              style={{ top: `${tick.top * 100}%` }}
            />
          ))}

          {/* Open air, dashed — never a promise, only room. */}
          {gaps.map((gap) => (
            <div
              key={`gap-${gap.top}`}
              className="absolute inset-x-1 flex items-center justify-center rounded-lg border border-dashed border-[var(--color-border-strong)]/70"
              style={{ top: `${gap.top * 100}%`, height: `${gap.height * 100}%` }}
            >
              <span className="text-[11px] text-[var(--color-text-faint)]">{gap.label}</span>
            </div>
          ))}

          {/* Fixed blocks, solid — somebody is expecting these. */}
          {blocks.map((block) => (
            <div
              key={block.id}
              className="absolute inset-x-1 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 shadow-[var(--shadow-soft)]"
              style={{ top: `${block.top * 100}%`, height: `${block.height * 100}%` }}
            >
              <p className="truncate text-[12.5px] font-medium leading-tight">{block.title}</p>
              <p className="truncate text-[11px] text-[var(--color-text-muted)]">
                {block.label}
                {block.location ? ` · ${block.location}` : ''}
              </p>
            </div>
          ))}

          {marker !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
              style={{ top: `${marker * 100}%` }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
              <span className="h-px flex-1 bg-[var(--color-accent)]/70" />
            </div>
          ) : null}
        </div>
      </div>

      <p
        className={cn(
          'mt-2 text-[12px]',
          gaps.length ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-faint)]',
        )}
      >
        {openAirLine(gaps)}
      </p>
    </div>
  );
}
