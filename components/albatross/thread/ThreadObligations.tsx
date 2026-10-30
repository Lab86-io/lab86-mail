'use client';

// Needs you items inside a Work thread (docs/needs-you.md, screen 5; phase 3
// W4). An obligation with this thread's `workId` is a message from its
// source: an accent-bordered card with the kicker, the source, the time, the
// sentence, the evidence line, the quoted source message, and the same
// actions as the page. The thread's own verb is "Handle it": it starts a run
// with the item as its input. Items come in time order, the oldest first.

import { useState } from 'react';
import { ObligationLead } from '@/components/needs-you/NeedsYouRow';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ObligationAction, ObligationView } from '@/lib/obligations/contract';
import { isClosedObligation, laterOptions, threadObligations } from '@/lib/obligations/groups';
import {
  closeReasonLabel,
  obligationSentence,
  openInLabel,
  safeSourceUrl,
  sourceWords,
  whenLabel,
} from '@/lib/obligations/labels';
import { cn } from '@/lib/utils';

export const THREAD_OBLIGATION_COPY = {
  kicker: 'Needs you',
  handle: 'Handle it',
  done: 'Done',
  later: 'Later',
  notMine: 'Not mine',
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
} as const;

export interface ThreadObligationsProps {
  items: readonly ObligationView[];
  now: number;
  timeZone?: string;
  /** The item with an action in flight, and the line of the last failed action. */
  busyId: string | null;
  error: { id: string; text: string } | null;
  onAction: (obligation: ObligationView, action: ObligationAction) => void;
  /** "Handle it": a run starts in this thread with the item as its input. */
  onHandle: (obligation: ObligationView) => void;
  className?: string;
}

export function ThreadObligations({
  items,
  now,
  timeZone,
  busyId,
  error,
  onAction,
  onHandle,
  className,
}: ThreadObligationsProps) {
  const ordered = threadObligations(items, now);
  if (!ordered.length) return null;
  const later = laterOptions(now, timeZone ?? 'UTC');
  return (
    <section
      data-slot="thread-obligations"
      aria-label={THREAD_OBLIGATION_COPY.kicker}
      className={cn('flex flex-col gap-3', className)}
    >
      {ordered.map((obligation) => (
        <ThreadObligationCard
          key={obligation.id}
          obligation={obligation}
          now={now}
          timeZone={timeZone}
          busy={busyId === obligation.id}
          error={error?.id === obligation.id ? error.text : null}
          laterOptions={later}
          onAction={(action) => onAction(obligation, action)}
          onHandle={() => onHandle(obligation)}
        />
      ))}
    </section>
  );
}

export function ThreadObligationCard({
  obligation,
  now,
  timeZone,
  busy,
  error,
  laterOptions: options,
  onAction,
  onHandle,
}: {
  obligation: ObligationView;
  now: number;
  timeZone?: string;
  busy: boolean;
  error: string | null;
  laterOptions: ReturnType<typeof laterOptions>;
  onAction: (action: ObligationAction) => void;
  onHandle: () => void;
}) {
  const [laterOpen, setLaterOpen] = useState(false);
  const closed = isClosedObligation(obligation);
  const url = safeSourceUrl(obligation);
  const label = obligation.sourceLabel?.trim();
  const quoteMeta = [
    label && label !== obligation.asker ? label : null,
    whenLabel(obligation.createdAt, now, timeZone),
  ]
    .filter(Boolean)
    .join(' · ');
  const button = 'h-9 px-3.5';
  return (
    <article
      data-thread-obligation={obligation.id}
      data-obligation-state={obligation.state}
      className={cn(
        'corner-smooth rounded-ui border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
        closed
          ? 'border-[var(--color-border)] opacity-[0.82]'
          : 'surface-accent border-[var(--surface-border)]',
      )}
    >
      <header
        className={cn(
          'flex items-center gap-2.5 border-b px-3.5 py-2.5',
          closed ? 'border-[var(--color-border)]' : 'border-[var(--surface-border)]',
        )}
      >
        <span
          className={cn(
            'text-[11px] font-semibold',
            closed ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]',
          )}
        >
          {THREAD_OBLIGATION_COPY.kicker}
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-muted)]">
          {sourceWords(obligation)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
          {whenLabel(obligation.createdAt, now, timeZone)}
        </span>
      </header>
      <div className="px-3.5 pb-3.5 pt-3">
        <p className="text-pretty text-[15px] font-medium leading-snug text-[var(--color-text)]">
          {obligationSentence(obligation)}
        </p>
        {obligation.why ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-text-muted)]">{obligation.why}</p>
        ) : null}
        {obligation.excerpt ? (
          <blockquote
            data-thread-obligation-quote
            className="mt-3 rounded-r-ui border-l-2 border-[color-mix(in_oklab,var(--color-accent)_45%,var(--color-border))] bg-[var(--color-accent-soft)]/50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <ObligationLead obligation={obligation} size={20} />
              <span className="font-display text-[13.5px] font-medium text-[var(--color-text)]">
                {obligation.asker}
              </span>
              <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{quoteMeta}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--color-text)]">
              {obligation.excerpt}
            </p>
          </blockquote>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[12px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
        {closed ? (
          <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-success)]">
              {closeReasonLabel(obligation.closeReason)}
            </span>
            {' · '}
            {whenLabel(obligation.closedAt ?? obligation.updatedAt, now, timeZone)}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {obligation.kind === 'rsvp' ? (
              <>
                <Button
                  size="sm"
                  className={cn(button, 'min-w-16')}
                  disabled={busy}
                  onClick={() => onAction({ action: 'rsvp', response: 'yes' })}
                >
                  {THREAD_OBLIGATION_COPY.yes}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={button}
                  disabled={busy}
                  onClick={() => onAction({ action: 'rsvp', response: 'no' })}
                >
                  {THREAD_OBLIGATION_COPY.no}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={button}
                  disabled={busy}
                  onClick={() => onAction({ action: 'rsvp', response: 'maybe' })}
                >
                  {THREAD_OBLIGATION_COPY.maybe}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" className={button} disabled={busy} onClick={onHandle}>
                  {THREAD_OBLIGATION_COPY.handle}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={button}
                  disabled={busy}
                  onClick={() => onAction({ action: 'done' })}
                >
                  {THREAD_OBLIGATION_COPY.done}
                </Button>
              </>
            )}
            <DropdownMenu open={laterOpen} onOpenChange={setLaterOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={button} disabled={busy}>
                  {THREAD_OBLIGATION_COPY.later}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {options.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() => onAction({ action: 'later', until: option.until })}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="ghost"
              className={button}
              disabled={busy}
              onClick={() => onAction({ action: 'not_mine' })}
            >
              {THREAD_OBLIGATION_COPY.notMine}
            </Button>
            {url ? (
              <a
                data-needs-you-open-in={obligation.source}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto pl-2 text-[13px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
              >
                {openInLabel(obligation)}
              </a>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
