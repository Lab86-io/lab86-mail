'use client';

import { BRIEF_LETTER_MEASURE_PX } from '@/lib/brief/letter';
import { cn } from '@/lib/utils';

const SKELETON_ROW_KEYS = ['answer-1', 'answer-2', 'today-1', 'today-2', 'know-1', 'know-2', 'know-3'];

/* The loading shape of the letter: one lede block and a few rows in the same
 * measure the letter uses, so nothing moves when the text lands. Standalone,
 * a masthead plate sits above it. */
export function BriefSkeleton({ rows = 3, masthead = false }: { rows?: number; masthead?: boolean }) {
  return (
    <div
      data-brief-skeleton
      className={cn('w-full', masthead ? 'h-full overflow-hidden bg-[var(--color-bg)]' : '')}
    >
      {masthead ? (
        <div className="relative h-[min(36vh,300px)] min-h-[220px] overflow-hidden bg-[var(--color-bg-subtle)]">
          <div className="absolute inset-0 shimmer" />
          <div className="absolute inset-0 grid place-items-center px-8">
            <div className="h-12 w-[min(60vw,420px)] rounded-md bg-white/28" />
          </div>
        </div>
      ) : null}
      <div
        className={cn('mx-auto w-full', masthead ? 'px-5 py-10' : 'py-2')}
        style={{ maxWidth: BRIEF_LETTER_MEASURE_PX }}
      >
        <div className="space-y-3">
          <div className="h-6 w-full rounded shimmer" />
          <div className="h-6 w-11/12 rounded shimmer" />
          <div className="h-6 w-3/4 rounded shimmer" />
        </div>
        <div aria-hidden className="flex justify-center py-5">
          <span className="h-px w-10 bg-[var(--color-border)]" />
        </div>
        <div className="h-3 w-14 rounded shimmer" />
        <div className="mt-2 divide-y divide-[var(--color-border)]">
          {SKELETON_ROW_KEYS.slice(0, Math.max(1, rows)).map((key) => (
            <div key={key} className="flex gap-3 py-3">
              <div className="size-7 shrink-0 rounded-full shimmer" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-1/3 rounded shimmer" />
                <div className="h-4 w-2/3 rounded shimmer" />
                <div className="h-3 w-5/6 rounded shimmer" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
