'use client';

// One thread row (docs/research/albatross-threads-web-design-2026-10-08.md,
// §3; lead decisions 1, 2, 7). One 7 px status dot, the title (weight is the
// unread mark), the time, and "Status word · preview". The hover actions take
// the time's slot. "Steer" opens one line in place; "Answer" opens the form
// the parent renders in place; the context menu holds "Mark as unread".

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BlankSentence } from '@/components/albatross/BlankSentence';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import {
  STEER_NOTE_MAX,
  type StatusWordTone,
  statusWordTone,
  THREAD_ROW_COPY,
  type ThreadRowAction,
  type ThreadRowActionKind,
  type ThreadTone,
  threadRowAccessibleName,
  threadRowActions,
  threadRowRecedes,
  threadTimeLabel,
  threadTone,
} from '@/lib/albatross/thread-list-view';
import type { ThreadRow as ThreadRowData } from '@/lib/albatross/threads';
import { cn } from '@/lib/utils';

export interface ThreadRowProps {
  row: ThreadRowData;
  /** The rail is narrow and quiet; the list is wide and shows the area. */
  variant: 'rail' | 'list';
  /** The open thread: filled, `aria-current`, never receded. */
  open?: boolean;
  /** "Needs you" rows in the list carry the serif title, as the list always did. */
  prominent?: boolean;
  nowMs: number;
  timeZone?: string;
  locale?: string;
  /** An unsent draft waits in this thread: the word "Draft" takes the time's slot. */
  hasDraft?: boolean;
  onOpen: (row: ThreadRowData) => void;
  /** Open, Stop, Try again, Handle it, and Answer (the parent renders the form). */
  onAction?: (kind: ThreadRowActionKind, row: ThreadRowData) => void;
  /** Steer in place: resolves true when the note reached the run. */
  onSteer?: (row: ThreadRowData, text: string) => Promise<boolean>;
  onMarkUnread?: (row: ThreadRowData) => void;
  /** The in-place answer panel, when this row is the one being answered. */
  inPlace?: ReactNode;
  /** Roving tabindex from the rail: one tab stop for the list. */
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  className?: string;
}

const DOT_CLASS: Record<ThreadTone, string> = {
  needs_you: 'bg-[var(--color-accent)]',
  working: 'thread-dot-halo bg-[var(--color-accent-2)] text-[var(--color-accent-2)]',
  starts_soon: 'border-[1.5px] border-[var(--color-accent-2)] bg-transparent',
  done: 'bg-[var(--color-success)]',
  quiet: 'border-[1.5px] border-[var(--color-border-strong)] bg-transparent',
};

const WORD_CLASS: Record<StatusWordTone, string> = {
  needs_you: 'text-[var(--color-accent)]',
  working: 'text-[var(--color-accent-2)]',
  starts_soon: 'text-[var(--color-accent-2)]',
  done: 'text-[var(--color-success)]',
  quiet: 'text-[var(--color-text-muted)]',
  failed: 'text-[var(--color-danger)]',
};

/** How long "Sent to the run" shows on the row after a note from the list. */
export const STEER_SENT_SHOWS_MS = 4_000;

export function ThreadRow({
  row,
  variant,
  open = false,
  prominent = false,
  nowMs,
  timeZone,
  locale,
  hasDraft = false,
  onOpen,
  onAction,
  onSteer,
  onMarkUnread,
  inPlace,
  tabIndex,
  onKeyDown,
  className,
}: ThreadRowProps) {
  const tone = threadTone(row.status);
  const word = statusWordTone(row.status);
  const recedes = threadRowRecedes(row, open);
  const time = threadTimeLabel(row, nowMs, locale, timeZone);
  const actions = threadRowActions(row);
  const [steerOpen, setSteerOpen] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const sentShows = sentAt !== null && nowMs - sentAt < STEER_SENT_SHOWS_MS;
  const list = variant === 'list';
  // A row that waits for you, in the list: the blank sentence and the action in view.
  const yours = list && prominent;
  const labelId = useId();

  // "Sent to the run" leaves on its own, even when the clock stands still.
  useEffect(() => {
    if (sentAt === null) return;
    const timer = window.setTimeout(() => setSentAt(null), STEER_SENT_SHOWS_MS);
    return () => window.clearTimeout(timer);
  }, [sentAt]);

  // A steer line closes when the run it addressed is gone.
  useEffect(() => {
    if (!row.workingRunId) setSteerOpen(false);
  }, [row.workingRunId]);

  const act = (action: ThreadRowAction) => {
    if (action.kind === 'steer') {
      setSteerOpen((value) => !value);
      return;
    }
    onAction?.(action.kind, row);
  };

  const preview = sentShows ? THREAD_ROW_COPY.steerSent : row.preview;
  const previewTone = sentShows ? WORD_CLASS.working : row.unread ? 'text-[var(--color-text)]' : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-thread-row={row.workId}
          data-thread-status={row.status}
          data-thread-unread={row.unread || undefined}
          data-thread-open={open || undefined}
          className={cn(
            'group/thread-row relative rounded-ui transition-opacity',
            open ? 'bg-[var(--color-selected-soft)]' : 'hover:bg-[var(--color-hover-soft)]',
            recedes && 'opacity-[0.72] hover:opacity-100 focus-within:opacity-100',
            'motion-reduce:transition-none',
            className,
          )}
        >
          <button
            type="button"
            data-thread-row-main
            tabIndex={tabIndex}
            onKeyDown={onKeyDown}
            onClick={() => onOpen(row)}
            aria-current={open ? 'page' : undefined}
            aria-label={threadRowAccessibleName(row, time)}
            aria-describedby={undefined}
            title={row.preview}
            className={cn(
              'grid w-full grid-cols-[16px_minmax(0,1fr)] gap-x-2 rounded-ui text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)]',
              list ? 'px-3.5 py-3' : 'px-2.5 py-2',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'relative mt-[6px] size-[7px] justify-self-center rounded-full',
                list && prominent && 'mt-[7px]',
                DOT_CLASS[tone],
              )}
            />
            <span className="block min-w-0">
              <span className="flex items-baseline gap-2.5">
                <span
                  id={labelId}
                  className={cn(
                    'min-w-0 flex-1 truncate leading-[18px]',
                    list ? 'text-[14.5px] leading-[20px]' : 'text-[13px]',
                    row.unread ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {row.title}
                </span>
                <span
                  data-thread-time
                  className={cn(
                    'shrink-0 text-[11px] leading-[18px] tabular-nums transition-opacity',
                    row.unread ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]',
                    hasDraft && !open && 'font-medium text-[var(--color-accent-2)]',
                    actions.length &&
                      !yours &&
                      'group-focus-within/thread-row:opacity-0 group-hover/thread-row:opacity-0',
                    'motion-reduce:transition-none',
                  )}
                >
                  {hasDraft && !open ? THREAD_ROW_COPY.draft : time}
                </span>
              </span>
              {yours ? (
                <BlankSentence
                  as="span"
                  blanks={row.blanks}
                  fallback={preview}
                  className="mt-1 block text-[18px]"
                />
              ) : (
                <span
                  className={cn(
                    'mt-0.5 block truncate leading-4 text-[var(--color-text-muted)]',
                    list ? 'text-[12.5px]' : 'text-[12px]',
                    previewTone,
                  )}
                >
                  {/* The rail names the status; the list's dot already says it, so the line is the news. */}
                  {row.statusLabel && (!list || !preview) ? (
                    <>
                      <span className={cn('font-medium', WORD_CLASS[word])}>{row.statusLabel}</span>
                      {preview ? <span className="mx-1 text-[var(--color-text-faint)]">·</span> : null}
                    </>
                  ) : null}
                  {preview}
                </span>
              )}
            </span>
          </button>

          {yours && actions.length && !inPlace ? (
            <div data-thread-row-actions className="flex flex-wrap gap-2 pb-4 pl-[38px] pr-3.5">
              {actions.map((action) => (
                <Button
                  key={action.kind}
                  type="button"
                  size="sm"
                  variant={action.primary ? 'default' : 'outline'}
                  data-thread-row-action={action.kind}
                  onClick={() => act(action)}
                >
                  {action.kind === 'open' && row.nextLabel ? row.nextLabel : action.label}
                </Button>
              ))}
            </div>
          ) : null}

          {actions.length && !yours ? (
            <span
              data-thread-row-actions
              className={cn(
                'absolute flex gap-1 opacity-0 transition-opacity group-focus-within/thread-row:opacity-100 group-hover/thread-row:opacity-100 motion-reduce:transition-none',
                list ? 'right-3 top-2.5' : 'right-2 top-1.5',
              )}
            >
              {actions.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  data-thread-row-action={action.kind}
                  tabIndex={-1}
                  aria-pressed={action.kind === 'steer' ? steerOpen : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    act(action);
                  }}
                  className={cn(
                    'h-[22px] rounded-[8px] border bg-[var(--color-bg-elevated)] px-2 text-[12px] font-medium',
                    action.primary
                      ? 'border-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-border))] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
                    'hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
                  )}
                >
                  {action.label}
                </button>
              ))}
            </span>
          ) : null}

          {steerOpen && row.workingRunId && onSteer ? (
            <SteerInPlace
              row={row}
              list={list}
              onSend={async (text) => {
                const sent = await onSteer(row, text);
                if (sent) {
                  setSteerOpen(false);
                  setSentAt(Date.now());
                }
                return sent;
              }}
              onClose={() => setSteerOpen(false)}
            />
          ) : null}

          {inPlace ? (
            <div
              data-thread-row-in-place
              className={cn('pb-3', list ? 'pl-[38px] pr-3.5' : 'pl-[34px] pr-2.5')}
            >
              {inPlace}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onSelect={() => onOpen(row)}>{THREAD_ROW_COPY.openThread}</ContextMenuItem>
        {onMarkUnread ? (
          <ContextMenuItem disabled={row.unread} onSelect={() => onMarkUnread(row)}>
            {THREAD_ROW_COPY.markUnread}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One line to the run, sent with Enter; Escape closes it (T10). */
function SteerInPlace({
  row,
  list,
  onSend,
  onClose,
}: {
  row: ThreadRowData;
  list: boolean;
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const send = () => {
    const note = text.trim();
    if (!note || busy) return;
    setBusy(true);
    setFailed(false);
    void onSend(note)
      .then((sent) => {
        if (!sent) setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  const hintId = `steer-hint-${row.workId}`;
  return (
    <div data-thread-row-steer className={cn('pb-2.5', list ? 'pl-[38px] pr-3.5' : 'pl-[34px] pr-2.5')}>
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          value={text}
          maxLength={STEER_NOTE_MAX}
          disabled={busy}
          aria-label={`Note to the run: ${row.stepTitle ?? row.title}`}
          aria-describedby={hintId}
          placeholder={THREAD_ROW_COPY.steerPlaceholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          className="h-7 text-[12.5px]"
        />
        <Button type="button" size="xs" disabled={busy || !text.trim()} onClick={send}>
          {THREAD_ROW_COPY.steerSend}
        </Button>
      </div>
      <p
        id={hintId}
        className={cn(
          'mt-1.5 text-[11px]',
          failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]',
        )}
      >
        {failed ? THREAD_ROW_COPY.steerFailed : THREAD_ROW_COPY.steerHint}
      </p>
    </div>
  );
}
