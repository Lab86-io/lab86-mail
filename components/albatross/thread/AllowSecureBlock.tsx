'use client';

// The allow_secure handoff inside a run block (docs/albatross-secure-store.md,
// V6; lead decision 10). The question names the site, the reason names the
// host and the fields, and three buttons answer: "Allow once" (primary),
// "Always on {site}", and "Do not allow" (quiet). The two allows need the
// identity check; one quiet line says so before Clerk's modal opens. After
// an answer, from any device, the buttons become one receipt line.

import { Button } from '@/components/ui/button';
import {
  ALLOW_COPY,
  type AllowScope,
  allowAlwaysLabel,
  allowQuestion,
  allowReason,
  allowReceipt,
} from '@/lib/albatross/secure-view';
import type { SecureAllowRequest } from '@/lib/secure/contract';
import { cn } from '@/lib/utils';

export interface AllowSecureNote {
  text: string;
  tone: 'quiet' | 'danger';
}

export interface AllowSecureBlockProps {
  allow: SecureAllowRequest;
  /** The state word above the question ("Needs your answer", "Answered"). */
  headline: string;
  /** The stored or optimistic answer. Null while the question is open. */
  answer: { scope: AllowScope } | null;
  /** The scope the user pressed while the check runs. */
  busyScope?: AllowScope | null;
  /** The line after a cancelled or failed check. */
  note?: AllowSecureNote | null;
  /** The run ended another way: the question is no longer open. */
  closed?: boolean;
  onAnswer: (scope: AllowScope) => void;
  onOpenSettings?: () => void;
}

export function AllowSecureBlock({
  allow,
  headline,
  answer,
  busyScope = null,
  note = null,
  closed = false,
  onAnswer,
  onOpenSettings,
}: AllowSecureBlockProps) {
  const question = allowQuestion(allow);
  const busy = Boolean(busyScope);
  const open = !answer && !closed;
  return (
    <section
      data-slot="allow-secure"
      data-allow-state={answer ? answer.scope : closed ? 'closed' : busy ? 'checking' : 'open'}
      aria-label={question}
      className="flex flex-col gap-1"
    >
      <span
        className={cn(
          'text-[11.5px] font-medium',
          open ? 'text-[var(--color-accent-3)]' : 'text-[var(--color-text-faint)]',
        )}
      >
        {headline}
      </span>
      <p className={cn('text-[14px] font-medium leading-snug', !open && 'text-[var(--color-text-muted)]')}>
        {question}
      </p>
      {open ? (
        <p className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">{allowReason(allow)}</p>
      ) : null}
      {answer ? (
        <p aria-live="polite" className="pt-1 text-[12.5px] font-medium text-[var(--color-accent-3)]">
          {allowReceipt(answer.scope, allow.site)}
          {answer.scope === 'always' && onOpenSettings ? (
            <>
              {' '}
              <button
                type="button"
                onClick={onOpenSettings}
                className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
              >
                {ALLOW_COPY.settings}
              </button>
            </>
          ) : null}
        </p>
      ) : closed ? (
        <p className="pt-1 text-[12px] text-[var(--color-text-faint)]">{ALLOW_COPY.noLongerOpen}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            <Button type="button" size="sm" disabled={busy} onClick={() => onAnswer('once')}>
              {busyScope === 'once' ? ALLOW_COPY.checking : ALLOW_COPY.once}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAnswer('always')}
            >
              {busyScope === 'always' ? ALLOW_COPY.checking : allowAlwaysLabel(allow.site)}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer('deny')}>
              {busyScope === 'deny' ? ALLOW_COPY.checking : ALLOW_COPY.deny}
            </Button>
          </div>
          <p
            aria-live="polite"
            className={cn(
              'text-[11px] leading-snug',
              note?.tone === 'danger'
                ? 'text-[var(--color-danger)]'
                : note
                  ? 'text-[var(--color-text-muted)]'
                  : 'text-[var(--color-text-faint)]',
            )}
          >
            {note?.text ?? ALLOW_COPY.fine}
          </p>
        </>
      )}
    </section>
  );
}
