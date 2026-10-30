'use client';

import { ArrowUpRight, Check } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { NotificationItem } from '@/components/notifications/model';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ObligationView } from '@/lib/obligations/contract';
import { isClosedObligation, type LaterOption } from '@/lib/obligations/groups';
import {
  actionNote,
  closeReasonLabel,
  dueSentence,
  expiryFraction,
  expiryLabel,
  kindLabel,
  obligationSentence,
  spacedCode,
  whenLabel,
} from '@/lib/obligations/labels';
import { cn } from '@/lib/utils';

export interface DraftState {
  status: 'loading' | 'ready' | 'error';
  to: string[];
  body: string;
  edited: boolean;
}

interface SourcePart {
  key: string;
  node: ReactNode;
}

function SourceLine({ parts, when }: { parts: SourcePart[]; when: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--color-text-muted)]">
      {parts.map((part, index) => (
        <span key={part.key} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden className="h-3 w-px bg-[var(--color-border-strong)]" /> : null}
          {part.node}
        </span>
      ))}
      <span className="ml-auto font-normal tabular-nums text-[var(--color-text-faint)]">{when}</span>
    </div>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-3 text-pretty text-[22px] font-medium leading-[1.3] tracking-tight text-[var(--color-text)]">
      {children}
    </h2>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 border-l-2 border-[var(--color-accent-2)] pl-3">
      <span className="block text-[11px] font-semibold text-[var(--color-accent-2)]">Why this needs you</span>
      <p className="mt-0.5 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">{children}</p>
    </div>
  );
}

function Card({
  kicker,
  sub,
  end,
  accent,
  children,
}: {
  kicker: string;
  sub?: ReactNode;
  end?: ReactNode;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'corner-smooth mt-5 rounded-ui border bg-[var(--color-bg-elevated)] shadow-[var(--shadow-soft)]',
        accent ? 'surface-accent border-[var(--surface-border)]' : 'border-[var(--color-border)]',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 border-b px-3.5 py-2.5',
          accent ? 'border-[var(--surface-border)]' : 'border-[var(--color-border)]',
        )}
      >
        <span
          className={cn(
            'text-[11px] font-semibold',
            accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]',
          )}
        >
          {kicker}
        </span>
        {sub ? (
          <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-muted)]">{sub}</span>
        ) : null}
        {end ? <span className="ml-auto flex shrink-0 gap-3">{end}</span> : null}
      </div>
      <div className="px-3.5 pb-3.5 pt-3 text-[13.5px] leading-[1.6] text-[var(--color-text)]">
        {children}
      </div>
    </div>
  );
}

function QuietLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[13px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
    >
      {children}
    </button>
  );
}

function ErrorLine({ error, busy, onRetry }: { error: string | null; busy: boolean; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 text-[12px] text-[var(--color-danger)]">
      {error}{' '}
      {onRetry ? (
        <Button variant="ghost" size="sm" className="h-11" disabled={busy} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function Actions({
  children,
  note,
  error,
  busy,
  onRetry,
}: {
  children: ReactNode;
  note: string;
  error: string | null;
  busy: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="mt-auto flex flex-col gap-2.5 border-t border-[var(--color-border)] pt-5">
      <ErrorLine error={error} busy={busy} onRetry={onRetry} />
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <p className="text-[12px] text-[var(--color-text-faint)]">{note}</p>
    </div>
  );
}

export interface ObligationDetailProps {
  obligation: ObligationView;
  now: number;
  timezone: string;
  draft?: DraftState;
  busy: boolean;
  error: string | null;
  copied: boolean;
  laterOpen: boolean;
  laterOptions: LaterOption[];
  onLaterOpenChange: (open: boolean) => void;
  onDone: () => void;
  onLater: (option: LaterOption) => void;
  onNotMine: () => void;
  onSendReply: () => void;
  onDraftChange: (body: string) => void;
  onCopy: () => void;
  onOpenSource: () => void;
  onRetry?: () => void;
}

export function ObligationDetail({
  obligation,
  now,
  timezone,
  draft,
  busy,
  error,
  copied,
  laterOpen,
  laterOptions,
  onLaterOpenChange,
  onDone,
  onLater,
  onNotMine,
  onSendReply,
  onDraftChange,
  onCopy,
  onOpenSource,
  onRetry,
}: ObligationDetailProps) {
  const closed = isClosedObligation(obligation);
  const hot = obligation.pushLevel === 'time_sensitive' || obligation.kind === 'code';
  const due = dueSentence(obligation, now, timezone);
  const parts: SourcePart[] = [
    { key: 'source', node: 'Mail' },
    { key: 'asker', node: obligation.asker },
    {
      key: 'kind',
      node: (
        <span className={hot ? 'text-[var(--color-accent-2)]' : 'text-[var(--color-accent)]'}>
          {kindLabel(obligation)}
        </span>
      ),
    },
  ];
  if (due) parts.push({ key: 'due', node: <span className="text-[var(--color-accent-3)]">{due}</span> });
  if (closed) {
    parts.push({
      key: 'closed',
      node: <span className="text-[var(--color-success)]">{closeReasonLabel(obligation.closeReason)}</span>,
    });
  }
  const openSource = <QuietLink onClick={onOpenSource}>Open in Mail</QuietLink>;
  const sourceCard = (
    <Card kicker="From the mail" sub={obligation.askerAddress} end={openSource}>
      {obligation.excerpt ? (
        <p className="whitespace-pre-wrap break-words">{obligation.excerpt}</p>
      ) : (
        <p className="text-[var(--color-text-muted)]">The mail is in the thread.</p>
      )}
    </Card>
  );
  const later = (
    <DropdownMenu open={laterOpen} onOpenChange={onLaterOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-11" disabled={busy}>
          Later
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {laterOptions.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onLater(option)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const notMine = (
    <Button variant="ghost" className="h-11" disabled={busy} onClick={onNotMine}>
      Not mine
    </Button>
  );
  const done = (primary: boolean) => (
    <Button variant={primary ? 'default' : 'ghost'} className="h-11" disabled={busy} onClick={onDone}>
      Done
    </Button>
  );

  if (obligation.kind === 'code') {
    const expiresAt = obligation.code?.expiresAt;
    const fraction = expiryFraction(obligation, now);
    const expired = expiresAt !== undefined && expiresAt <= now;
    return (
      <>
        <SourceLine parts={parts} when={whenLabel(obligation.createdAt, now, timezone)} />
        <Title>{obligationSentence(obligation)}</Title>
        <p
          data-needs-you-code
          className="mt-[18px] text-[44px] font-medium leading-none tracking-[0.08em] tabular-nums text-[var(--color-text)]"
        >
          {spacedCode(obligation.code?.value ?? '')}
        </p>
        {expiresAt !== undefined ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            <span
              aria-hidden
              className="size-2.5 rounded-full border-[1.5px] border-[var(--color-accent-2)]"
              style={
                {
                  background: `conic-gradient(var(--color-accent-2) 0 ${Math.round(fraction * 100)}%, transparent ${Math.round(fraction * 100)}%)`,
                } as CSSProperties
              }
            />
            {expired || closed ? (
              <span>{closed ? closeReasonLabel(obligation.closeReason) : 'Expired'}</span>
            ) : (
              <span>
                Expires in{' '}
                <b className="font-medium text-[var(--color-accent-2)]">{expiryLabel(expiresAt, now)}</b>
              </span>
            )}
          </p>
        ) : null}
        {sourceCard}
        <p className="mt-5 text-[12px] leading-[1.5] text-[var(--color-text-muted)]">
          This closes itself when you use the code or when it expires.
        </p>
        {closed ? (
          <ClosedLine obligation={obligation} now={now} timezone={timezone} />
        ) : (
          <Actions note="Pushed at once, in quiet hours too." error={error} busy={busy} onRetry={onRetry}>
            <Button className="h-11 min-w-28" disabled={busy} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            {notMine}
          </Actions>
        )}
      </>
    );
  }

  return (
    <>
      <SourceLine parts={parts} when={whenLabel(obligation.createdAt, now, timezone)} />
      <Title>{obligationSentence(obligation)}</Title>
      {obligation.why ? <Why>{obligation.why}</Why> : null}
      {sourceCard}
      {obligation.kind === 'reply' && !closed ? (
        <Card
          kicker="Draft reply"
          sub={`To ${obligation.asker}`}
          accent
          end={
            draft?.edited ? (
              <span className="text-[11.5px] text-[var(--color-text-muted)]">Edited</span>
            ) : draft?.status === 'ready' ? (
              <span className="text-[11.5px] text-[var(--color-text-muted)]">Prepared for you</span>
            ) : null
          }
        >
          {!draft || draft.status === 'loading' ? (
            <p role="status" className="text-[12.5px] text-[var(--color-text-muted)]">
              Preparing a draft…
            </p>
          ) : (
            <>
              {draft.status === 'error' ? (
                <p className="mb-2 text-[12px] text-[var(--color-text-muted)]">
                  Could not prepare a draft. Write the reply here.
                </p>
              ) : null}
              <textarea
                aria-label="Draft reply"
                value={draft.body}
                placeholder="Write the reply here."
                onChange={(event) => onDraftChange(event.target.value)}
                className="field-sizing-content min-h-24 w-full resize-none bg-transparent p-0 text-[13.5px] leading-[1.65] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
              />
            </>
          )}
        </Card>
      ) : null}
      {closed ? (
        <ClosedLine obligation={obligation} now={now} timezone={timezone} />
      ) : (
        <Actions note={actionNote(obligation)} error={error} busy={busy} onRetry={onRetry}>
          {obligation.kind === 'reply' ? (
            <>
              <Button
                className="h-11"
                disabled={busy || draft?.status === 'loading' || !draft?.body.trim()}
                onClick={onSendReply}
              >
                Send reply
              </Button>
              {done(false)}
            </>
          ) : (
            done(true)
          )}
          {later}
          {notMine}
        </Actions>
      )}
    </>
  );
}

function ClosedLine({
  obligation,
  now,
  timezone,
}: {
  obligation: ObligationView;
  now: number;
  timezone: string;
}) {
  const at = obligation.closedAt ?? obligation.updatedAt;
  return (
    <p className="mt-auto border-t border-[var(--color-border)] pt-5 text-[12px] text-[var(--color-text-muted)]">
      <span className="font-medium text-[var(--color-success)]">
        {closeReasonLabel(obligation.closeReason)}
      </span>
      {' · '}
      {whenLabel(at, now, timezone)}
    </p>
  );
}

export function AlbatrossDetail({
  item,
  now,
  timezone,
  busy,
  error,
  onAction,
  onRetry,
}: {
  item: NotificationItem;
  now: number;
  timezone: string;
  busy: boolean;
  error: string | null;
  onAction: () => void;
  onRetry?: () => void;
}) {
  return (
    <>
      <SourceLine
        parts={[
          { key: 'source', node: 'Albatross' },
          { key: 'kind', node: <span className="text-[var(--color-accent)]">{item.source}</span> },
        ]}
        when={item.createdAt ? whenLabel(item.createdAt, now, timezone) : ''}
      />
      <Title>{item.title}</Title>
      <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{item.context}</p>
      <p className="my-6 whitespace-pre-wrap break-words text-[14px] leading-[1.75] text-[var(--color-text)]">
        {item.body}
      </p>
      <Actions
        note="Opening this does not resolve it. It stays here until you handle it."
        error={error}
        busy={busy}
        onRetry={onRetry}
      >
        {item.action ? (
          <Button className="h-11" disabled={busy} onClick={onAction}>
            {item.actionLabel}
            <ArrowUpRight className="size-4" aria-hidden />
          </Button>
        ) : null}
      </Actions>
    </>
  );
}

export function EmptyDetail({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-8 py-12 text-center">
      <Check className="mb-5 size-6 text-[var(--color-text-faint)]" aria-hidden />
      <p className="font-serif text-[22px] text-[var(--color-text)]">
        {hasItems ? 'A little attention goes a long way.' : 'You’re caught up.'}
      </p>
      <p className="mt-2 max-w-xs text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        {hasItems
          ? 'Select something to see why it needs you and the prepared next step.'
          : 'When something needs you, it shows here and on your phone.'}
      </p>
    </div>
  );
}
