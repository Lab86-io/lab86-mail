'use client';

import type { TodayNoteLines } from '@/lib/obligations/today-page';

/**
 * The note under the painting. The first line is the one to read, in the
 * display face. The day is a plain line under it, one step back. Null while the
 * calendar loads: the space stays, so the list does not jump when the words arrive.
 */
export function TodayNote({ note }: { note: TodayNoteLines | null }) {
  return (
    <div data-today-note aria-live="polite" className="min-h-[3.75rem] max-w-[46rem]">
      {note ? (
        <>
          <p className="text-pretty font-display text-[clamp(1.375rem,2.5cqi,1.75rem)] font-normal leading-[1.25] tracking-[-0.012em] text-[var(--color-text)]">
            {note.lead}
          </p>
          <p className="mt-1.5 text-pretty text-[15px] leading-[22px] text-[var(--color-text-muted)] @[860px]/today:text-[16px]">
            {note.day}
          </p>
        </>
      ) : null}
    </div>
  );
}
