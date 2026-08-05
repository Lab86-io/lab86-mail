'use client';

import { useMemo } from 'react';
import {
  nowMarker,
  openAirLine,
  ribbonBlocks,
  ribbonGaps,
  ribbonTicks,
  ribbonWindow,
  stackBlocks,
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
  // One line of text needs about 26 pixels and two lines need about 42. A block
  // with room for neither cannot carry a title, so the drawing gives it the room
  // rather than cut the words in half.
  const minHeight = 26 / height;
  const twoLineHeight = 42 / height;
  const blocks = useMemo(
    () => stackBlocks(ribbonBlocks(events, window, nowMs), minHeight, twoLineHeight),
    [events, window, nowMs, minHeight, twoLineHeight],
  );
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

          {/* Fixed blocks, solid — somebody is expecting these. A short one puts
              its title and time on one line rather than cutting the words. */}
          {blocks.map((block) => (
            <div
              key={block.id}
              className={cn(
                // The leading bar reads as a spine down the day: it separates
                // what somebody expects of you from open air before any word is
                // read.
                'absolute inset-x-1 z-[1] overflow-hidden rounded-lg border border-l-2 border-[var(--color-border)] border-l-[var(--color-accent)] bg-[var(--color-bg-elevated)] px-2.5 shadow-[var(--shadow-soft)]',
                block.compact ? 'flex items-center gap-2 py-0' : 'py-1.5',
              )}
              style={{ top: `${block.top * 100}%`, height: `${block.height * 100}%` }}
            >
              <p className="truncate text-[12.5px] font-medium leading-tight">{block.title}</p>
              <p
                className={cn(
                  'truncate text-[11px] text-[var(--color-text-muted)]',
                  block.compact && 'shrink-0',
                )}
              >
                {block.label}
                {block.location && !block.compact ? ` · ${block.location}` : ''}
              </p>
            </div>
          ))}

          {/* The now-line runs behind the blocks. Over them it reads as a rule
              struck through the title of whatever meeting you are in. Only the
              cap sits on top, so the present is still the first thing found. */}
          {marker !== null ? (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 h-px bg-[var(--color-accent)]/70"
                style={{ top: `${marker * 100}%` }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-0 z-10 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)]"
                style={{ top: `${marker * 100}%` }}
              />
            </>
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
