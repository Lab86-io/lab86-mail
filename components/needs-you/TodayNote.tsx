'use client';

import type { NoteSentence } from '@/lib/obligations/today-page';

/**
 * The note under the painting. The names and the times carry the full ink, so
 * the eye can read only them and still get the day. Null while the calendar
 * loads: the space stays, so the list does not jump when the words arrive.
 */
export function TodayNote({ sentences }: { sentences: readonly NoteSentence[] | null }) {
  return (
    <p
      data-today-note
      aria-live="polite"
      className="min-h-[2.6em] max-w-[36em] text-pretty font-display text-[clamp(1.25rem,2.5cqi,1.75rem)] font-normal leading-[1.3] tracking-[-0.01em] text-[var(--color-text-muted)]"
    >
      {sentences?.map((sentence, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentences have no identity; the order is the note.
        <span key={index}>
          {index ? ' ' : ''}
          {sentence.map((run, runIndex) =>
            run.strong ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              <strong key={runIndex} className="font-normal text-[var(--color-text)]">
                {run.text}
              </strong>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              <span key={runIndex}>{run.text}</span>
            ),
          )}
        </span>
      ))}
    </p>
  );
}
