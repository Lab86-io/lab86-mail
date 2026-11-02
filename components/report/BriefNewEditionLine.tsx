'use client';

import { BRIEF_NEW_EDITION_NOTE, BRIEF_PLAIN_LETTER_NOTE } from '@/lib/brief/generation';
import type { BriefPendingEdition } from '@/lib/brief/web-view';
import { cn } from '@/lib/utils';

/* The quiet line while the writer works on a new edition. It sits with the
 * edition's own source line, in the same small type, because the page below it
 * is still the thing to read. News products say this in their date line, not
 * in a banner or a card. */
export function BriefNewEditionLine({
  pending,
  reportId,
  className,
}: {
  pending: BriefPendingEdition | null;
  /** The edition on the page. When the writer works on it, the page shows its plain letter. */
  reportId: string;
  className?: string;
}) {
  if (!pending) return null;
  return (
    <p
      role="status"
      data-brief-new-edition={pending.reportId === reportId ? 'plain-letter' : 'on-the-way'}
      className={cn('flex items-baseline gap-2 text-[12px] text-[var(--color-text-muted)]', className)}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 -translate-y-px animate-pulse rounded-full bg-[var(--color-accent)] motion-reduce:animate-none"
      />
      <span>{pending.reportId === reportId ? BRIEF_PLAIN_LETTER_NOTE : BRIEF_NEW_EDITION_NOTE}</span>
    </p>
  );
}
