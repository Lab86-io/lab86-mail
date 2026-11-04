'use client';

import type { TodayNoteLines } from '@/lib/obligations/today-page';

/**
 * The note under the painting: what needs the person in full ink, what the day
 * does next one step back. Null while the calendar loads: the space stays, so
 * the list does not jump when the words arrive.
 */
export function TodayNote({ note }: { note: TodayNoteLines | null }) {
  return (
    <p
      data-today-note
      aria-live="polite"
      className="min-h-[2.6em] max-w-[38em] text-pretty font-display text-[clamp(1.25rem,2.3cqi,1.5rem)] font-normal leading-[1.33] tracking-[-0.008em] text-[var(--color-text)]"
    >
      {note ? (
        <>
          {note.lead}
          <span className="block text-[var(--color-text-muted)]">{note.day}</span>
        </>
      ) : null}
    </p>
  );
}
