'use client';

// What a run shows while it works, and the thread before its detail loads.
//
// The text uses the type of a run message, so nothing moves when the message
// takes its place. The rows are the newest log lines; older rows fold under
// "What Albatross did". Only the newest row moves: a shimmer, and after five
// seconds a clock, so a slow tool reads as work and not as a silence. The clock
// runs in the browser and writes nothing.

import { useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { TaskItem } from '@/components/ai-elements/task';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { Markdown } from '@/components/ui/markdown';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { runRowElapsed } from '@/lib/albatross/run-live';
import { formatLogTime } from '@/lib/albatross/step-run-client';
import { cn } from '@/lib/utils';
import { PLACEHOLDER_CLASS } from '../AlbatrossesSurface';
import { MESSAGE_CLASS } from './RunMessages';

/** The newest log rows that stay open while a run works. */
export const LIVE_ROWS_OPEN = 3;

export function RunLiveText({ text }: { text: string }) {
  return (
    <div data-slot="run-live-text" className="min-w-0">
      <Markdown className={MESSAGE_CLASS} streaming>
        {text}
      </Markdown>
    </div>
  );
}

/** This node holds the subscription, so a new part of the text draws only this node. */
export function RunLiveTextConnected({ runId }: { runId: string }) {
  const live = useQuery(api.albatrossStepRuns.liveText, { id: runId as Id<'albatrossStepRuns'> });
  return live?.text ? <RunLiveText text={live.text} /> : null;
}

function RowClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const label = runRowElapsed(now - since);
  return label ? (
    <span data-slot="run-row-clock" className="shrink-0 tabular-nums text-[var(--color-text-faint)]">
      {label}
    </span>
  ) : null;
}

export function LiveRunRows({
  rows,
  shimmerNewest,
  timeZone,
}: {
  rows: ReadonlyArray<{ at: number; text: string }>;
  /** False when a live line above already moves: one thing moves at a time. */
  shimmerNewest: boolean;
  timeZone?: string;
}) {
  return (
    <div data-slot="run-live-rows" className="flex min-w-0 flex-col">
      {rows.map((row, index) => {
        const newest = index === rows.length - 1;
        return (
          <TaskItem
            key={`${row.at}:${row.text}`}
            data-slot={newest ? 'run-live-row-newest' : 'run-live-row'}
            aria-live={newest ? 'polite' : undefined}
            className="flex min-w-0 gap-2 py-0.5 text-[12.5px]"
          >
            <time className="shrink-0 tabular-nums text-[var(--color-text-faint)]">
              {formatLogTime(row.at, undefined, timeZone)}
            </time>
            <span className="min-w-0 flex-1">
              {newest && shimmerNewest ? (
                <ShimmerText text={row.text} duration={1.6} startOnView={false} />
              ) : (
                row.text
              )}
            </span>
            {newest ? <RowClock key={row.at} since={row.at} /> : null}
          </TaskItem>
        );
      })}
    </div>
  );
}

/** The thread column while its detail loads: the title from the list, then quiet lines. */
export function ThreadLoading({ title, label }: { title?: string | null; label: string }) {
  return (
    <section data-slot="thread-loading" aria-busy aria-label={label} className="flex h-full min-w-0 flex-col">
      {/* The header bar and the column of the thread, so the title does not move when the detail comes. */}
      <div className="h-[50px] shrink-0 border-b border-[var(--color-border)]" />
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-3 px-4 pt-[26px]">
        {title ? (
          <p className="font-display text-[28px] font-normal leading-[1.15] tracking-[-0.015em] text-balance">
            {title}
          </p>
        ) : (
          <Skeleton className={cn(PLACEHOLDER_CLASS, 'h-7 w-2/3')} />
        )}
        <Skeleton className={cn(PLACEHOLDER_CLASS, 'h-3 w-5/6 opacity-70')} />
        <Skeleton className={cn(PLACEHOLDER_CLASS, 'h-3 w-3/5 opacity-70')} />
      </div>
    </section>
  );
}
