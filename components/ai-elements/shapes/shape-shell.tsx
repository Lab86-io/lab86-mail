'use client';

// The shared pieces of every shape card (docs/chat-agentic-pass.md, section
// 3): the paper surface, a dense list row in the mail-list typography, and
// the action bar. The bar shows at most two text actions (primary first) and
// puts the rest behind a "More" menu. A mutation writes its outcome in place
// in the accent-3 status voice and disables the row's other mutations; it
// never navigates away and never toasts.

import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ShapeAction } from '@/lib/ai/tool-shapes';
import { type ActionEntry, planActionEntries, splitActionEntries } from '@/lib/chat/shape-actions';
import { cn } from '@/lib/utils';
import { type ActionStatus, useShapeActionsContext } from './shape-actions';

export function ShapeShell({
  title,
  summary,
  children,
  className,
}: {
  title?: string;
  summary?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="shape-card"
      className={cn(
        'corner-smooth w-full min-w-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-soft)]',
        className,
      )}
    >
      {title || summary ? (
        <header className="flex min-w-0 flex-col gap-0.5 px-3 pt-2.5 pb-2">
          {title ? <span className="truncate text-[12.5px] font-medium">{title}</span> : null}
          {summary ? (
            <span className="text-[11.5px] leading-snug text-[var(--color-text-muted)]">{summary}</span>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}

/** Small facts joined with a middle dot: "Inbox · Due today · high". */
export function Facts({
  items,
  className,
}: {
  items: Array<string | undefined | null | false>;
  className?: string;
}) {
  const clean = items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (!clean.length) return null;
  return (
    <span className={cn('truncate text-[11.5px] text-[var(--color-text-muted)]', className)}>
      {clean.join(' · ')}
    </span>
  );
}

export function ShapeMore({ count, noun }: { count: number; noun: string }) {
  if (count <= 0) return null;
  return (
    <div className="border-t border-[var(--color-list-divider)] px-3 py-1.5 text-[11px] text-[var(--color-text-faint)]">
      {count} more {noun}
    </div>
  );
}

export function ShapeList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

/**
 * One dense row. `primary` and `meta` share the first line (sender and date
 * in the mail list); `secondary` is the second line; the actions sit at the
 * end of the second line.
 */
export function ShapeRow({
  rowKey,
  primary,
  meta,
  secondary,
  actions,
  emphasis = false,
  done = false,
  children,
}: {
  rowKey: string;
  primary: ReactNode;
  meta?: ReactNode;
  secondary?: ReactNode;
  actions: ShapeAction[];
  /** Bold the first line (an unread thread). */
  emphasis?: boolean;
  /** Strike the first line (a completed task). */
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="shape-row"
      className="flex min-w-0 flex-col gap-0.5 border-t border-[var(--color-list-divider)] px-3 py-2 first:border-t-0"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-display text-[13px] leading-snug',
            emphasis ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]/90',
            done && 'line-through text-[var(--color-text-faint)]',
          )}
        >
          {primary}
        </span>
        {meta ? (
          <span className="shrink-0 text-[11px] leading-snug tabular-nums text-[var(--color-text-faint)]">
            {meta}
          </span>
        ) : null}
      </div>
      {secondary || actions.length ? (
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-[var(--color-text-muted)]">
            {secondary}
          </span>
          <ActionBar rowKey={rowKey} actions={actions} />
        </div>
      ) : null}
      {children}
    </div>
  );
}

const textButton =
  'shrink-0 text-[11.5px] font-medium leading-tight text-[var(--color-accent)] transition-colors duration-[var(--duration-fast)] hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline';

function rowOutcome(status: Record<string, ActionStatus>, entries: ActionEntry[], rowKey: string) {
  let done: string | null = null;
  let error: string | null = null;
  let pending = false;
  for (const entry of entries) {
    const state = status[`${rowKey}:${entry.key}`];
    if (!state) continue;
    if (state.state === 'done') done = state.label;
    else if (state.state === 'error') error = state.message;
    else pending = true;
  }
  return { done, error, pending };
}

/**
 * The actions of one row or card. Navigation actions stay enabled after a
 * mutation; mutations disable once one has run on the row.
 */
export function ActionBar({
  rowKey,
  actions,
  className,
}: {
  rowKey: string;
  actions: ShapeAction[];
  className?: string;
}) {
  const { status, run } = useShapeActionsContext();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [prompting, setPrompting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const entries = planActionEntries(actions);
  if (!entries.length) return null;
  const { visible, more } = splitActionEntries(entries);
  const outcome = rowOutcome(status, entries, rowKey);

  const start = (entry: ActionEntry) => {
    if (entry.confirm) {
      setConfirming(entry.key);
      return;
    }
    if (entry.prompt === 'note') {
      setPrompting(entry.key);
      return;
    }
    void run(`${rowKey}:${entry.key}`, entry.action, { rsvp: entry.rsvp });
  };
  const disabledFor = (entry: ActionEntry) => outcome.pending || (entry.mutating && outcome.done != null);

  const confirmEntry = confirming ? entries.find((entry) => entry.key === confirming) : null;
  if (confirmEntry) {
    return (
      <span className={cn('flex shrink-0 items-baseline gap-2', className)}>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">Delete this event?</span>
        <button
          type="button"
          className={cn(textButton, 'text-[var(--color-danger)]')}
          onClick={() => {
            setConfirming(null);
            void run(`${rowKey}:${confirmEntry.key}`, confirmEntry.action);
          }}
        >
          Delete
        </button>
        <button type="button" className={textButton} onClick={() => setConfirming(null)}>
          Keep
        </button>
      </span>
    );
  }

  const promptEntry = prompting ? entries.find((entry) => entry.key === prompting) : null;
  if (promptEntry) {
    return (
      <span className={cn('flex min-w-0 flex-1 items-center gap-2', className)}>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && note.trim()) {
              setPrompting(null);
              void run(`${rowKey}:${promptEntry.key}`, promptEntry.action, { note });
            }
            if (event.key === 'Escape') setPrompting(null);
          }}
          placeholder="A note about this sender"
          aria-label="Note about this sender"
          className="corner-smooth min-w-0 flex-1 rounded-[var(--radius-xs)] border border-[var(--color-control-border)] bg-[var(--color-control)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus-visible:border-[var(--color-accent)]"
        />
        <button
          type="button"
          className={textButton}
          disabled={!note.trim()}
          onClick={() => {
            setPrompting(null);
            void run(`${rowKey}:${promptEntry.key}`, promptEntry.action, { note });
          }}
        >
          Save
        </button>
        <button type="button" className={textButton} onClick={() => setPrompting(null)}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className={cn('flex shrink-0 items-baseline gap-2.5', className)}>
      {outcome.done ? (
        <span data-slot="shape-outcome" className="text-[11.5px] font-medium text-[var(--color-accent-3)]">
          {outcome.done}
        </span>
      ) : null}
      {outcome.error ? (
        <span
          data-slot="shape-error"
          className="max-w-[220px] truncate text-[11px] text-[var(--color-danger)]"
        >
          {outcome.error}
        </span>
      ) : null}
      {visible.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className={cn(textButton, entry.danger && 'text-[var(--color-danger)]')}
          disabled={disabledFor(entry)}
          aria-busy={status[`${rowKey}:${entry.key}`]?.state === 'pending' || undefined}
          onClick={() => start(entry)}
        >
          {entry.label}
        </button>
      ))}
      {more.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(textButton, 'text-[var(--color-text-muted)]')}
              disabled={outcome.pending}
            >
              More
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-32">
            {more.map((entry) => (
              <DropdownMenuItem
                key={entry.key}
                disabled={disabledFor(entry)}
                onSelect={() => start(entry)}
                className={cn('text-[12px]', entry.danger && 'text-[var(--color-danger)]')}
              >
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
  );
}
