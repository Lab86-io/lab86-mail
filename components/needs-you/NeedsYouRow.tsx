'use client';

import { ChevronDown, CircleCheck, KeyRound } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { NotificationItem } from '@/components/notifications/model';
import { Avatar } from '@/components/ui/avatar';
import type { NeedsYouEntry, NeedsYouGroup } from '@/lib/obligations/groups';
import { isClosedObligation } from '@/lib/obligations/groups';
import {
  agoLabel,
  type DueLabel,
  type DueTone,
  dueLabel,
  kindLabel,
  spacedCode,
  whenLabel,
} from '@/lib/obligations/labels';
import { cn } from '@/lib/utils';

export type NeedsYouListEntry = NeedsYouEntry<NotificationItem>;

const DUE_TONE: Record<DueTone, string> = {
  plain: 'text-[var(--color-text-faint)]',
  today: 'font-medium text-[var(--color-accent-3)]',
  hot: 'font-medium text-[var(--color-accent-2)]',
  done: 'font-medium text-[var(--color-success)]',
};

/** The round lead of a row: initials for a person, a glyph for a code or an Albatross. */
export function RowLead({ entry }: { entry: NeedsYouListEntry }) {
  if (entry.type === 'albatross') {
    return (
      <span
        aria-hidden
        className="mt-px grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
      >
        <CircleCheck className="size-[15px]" />
      </span>
    );
  }
  if (entry.obligation.kind === 'code') {
    return (
      <span
        aria-hidden
        className="mt-px grid size-7 shrink-0 place-items-center rounded-full border border-[var(--color-avatar-ring)] bg-[var(--color-control)] text-[var(--color-text-muted)]"
      >
        <KeyRound className="size-3.5" />
      </span>
    );
  }
  return <Avatar name={entry.obligation.asker} size={28} className="mt-px" />;
}

function albatrossDue(item: NotificationItem): DueLabel {
  if (item.kind === 'checkin') return { text: 'Today', tone: 'today' };
  return { text: 'Your turn', tone: 'plain' };
}

/** The words of one row, so the row and the tests agree. */
export function rowWords(entry: NeedsYouListEntry, now: number, timezone: string) {
  if (entry.type === 'albatross') {
    const { item } = entry;
    const checkin = item.kind === 'checkin';
    return {
      name: checkin ? 'Daily check-in' : item.context.replace(/ · you put this down$/, ''),
      source: 'Albatross',
      line: item.title,
      meta: [
        item.createdAt ? whenLabel(item.createdAt, now, timezone) : null,
        checkin ? 'Check-in' : item.source,
      ]
        .filter(Boolean)
        .join(' · '),
      due: albatrossDue(item),
    };
  }
  const { obligation } = entry;
  const closed = isClosedObligation(obligation);
  const when = whenLabel(obligation.createdAt, now, timezone);
  const meta =
    obligation.kind === 'code'
      ? closed
        ? when
        : `${when} · ${agoLabel(obligation.createdAt, now)}`
      : closed
        ? when
        : `${when} · ${kindLabel(obligation)}`;
  return {
    name: obligation.asker,
    source: 'Mail',
    line: obligation.kind === 'code' && closed ? 'Verification code.' : obligation.title,
    meta,
    due: dueLabel(obligation, now, timezone),
  };
}

export interface NeedsYouRowProps {
  entry: NeedsYouListEntry;
  now: number;
  timezone: string;
  selected: boolean;
  /** The one row in the tab order. */
  focusable: boolean;
  draftReady?: boolean;
  copied?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onDone?: () => void;
  onCopy?: () => void;
  registerRef: (node: HTMLButtonElement | null) => void;
}

export function NeedsYouRow({
  entry,
  now,
  timezone,
  selected,
  focusable,
  draftReady,
  copied,
  busy,
  onOpen,
  onKeyDown,
  onDone,
  onCopy,
  registerRef,
}: NeedsYouRowProps) {
  const words = rowWords(entry, now, timezone);
  const obligation = entry.type === 'obligation' ? entry.obligation : null;
  const closed = obligation ? isClosedObligation(obligation) : false;
  const code = obligation?.kind === 'code' && !closed ? obligation.code : null;
  const pills: { label: string; onClick: () => void; primary?: boolean }[] = [];
  if (obligation && !closed) {
    if (code && onCopy) pills.push({ label: copied ? 'Copied' : 'Copy', onClick: onCopy, primary: true });
    else if (obligation.kind === 'reply') pills.push({ label: 'Reply', onClick: onOpen, primary: true });
    if (onDone) pills.push({ label: 'Done', onClick: onDone });
  }
  const due = words.due;
  return (
    <li
      data-needs-you-row={entry.id}
      className="group relative border-b border-[var(--color-list-divider,var(--color-border))]"
    >
      <button
        type="button"
        ref={registerRef}
        tabIndex={focusable ? 0 : -1}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        className={cn(
          'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 px-5 py-[11px] text-left transition-colors hover:bg-[var(--color-hover-soft)] focus-visible:rounded-ui focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-ring)]',
          selected && 'bg-[var(--color-selected-soft)]',
          closed && 'opacity-[0.72]',
        )}
      >
        <RowLead entry={entry} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-display text-[14px] font-medium leading-[18px] text-[var(--color-text)]">
              {words.name}
            </span>
            <span className="flex shrink-0 items-baseline gap-[7px] text-[11px] leading-[18px] text-[var(--color-text-muted)]">
              <span aria-hidden className="size-[3px] rounded-full bg-[var(--color-text-faint)]" />
              {words.source}
            </span>
          </span>
          {code ? (
            <span className="mt-[3px] flex items-baseline gap-3">
              <span
                data-needs-you-code
                className="text-[22px] font-medium leading-6 tracking-[0.06em] tabular-nums text-[var(--color-text)]"
              >
                {spacedCode(code.value)}
              </span>
              <span className="text-[12px] text-[var(--color-text-muted)]">Verification code</span>
            </span>
          ) : (
            <span
              className={cn(
                'mt-0.5 line-clamp-2 text-[13px] leading-[18px]',
                closed ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]',
              )}
            >
              {words.line}
            </span>
          )}
          <span className="mt-1 block text-[11px] leading-[14px] text-[var(--color-text-faint)]">
            {words.meta}
            {draftReady ? ' · Draft ready' : ''}
          </span>
        </span>
        <span
          data-needs-you-due
          className={cn(
            'whitespace-nowrap pt-px text-right text-[11.5px] leading-[18px] tabular-nums',
            DUE_TONE[due.tone],
            pills.length > 0 && 'group-hover:invisible group-focus-within:invisible',
          )}
        >
          {due.text}
          {due.sub ? (
            <small className="block text-[10.5px] font-normal text-[var(--color-text-faint)]">
              {due.sub}
            </small>
          ) : null}
        </span>
      </button>
      {pills.length > 0 ? (
        <span className="absolute right-3 top-[9px] hidden gap-1 group-hover:flex group-focus-within:flex">
          {pills.map((pill) => (
            <button
              key={pill.label}
              type="button"
              tabIndex={-1}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                pill.onClick();
              }}
              className={cn(
                'h-[22px] rounded-[8px] border bg-[var(--color-bg-elevated)] px-2 text-[12px] font-medium leading-5 transition-colors hover:bg-[var(--color-control-hover)] disabled:opacity-60',
                pill.primary
                  ? 'border-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-border))] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
              )}
            >
              {pill.label}
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}

export function GroupHead({
  group,
  first,
  action,
}: {
  group: Pick<NeedsYouGroup<NotificationItem>, 'id' | 'label' | 'entries'>;
  /** The first group of the list sits closer to the header. */
  first?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] px-5 pb-2',
        first ? 'pt-3.5' : 'pt-[22px]',
      )}
    >
      <h2 className="text-[12px] font-semibold text-[var(--color-text-muted)]">
        {group.label}
        <span className="ml-2 font-normal tabular-nums text-[var(--color-text-faint)]">
          {group.entries.length}
        </span>
      </h2>
      {action}
    </div>
  );
}

/** The collapsed head of Closed today. Enter or Space opens it. */
export function ClosedGroupHead({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={cn('px-5 pb-2 pt-[18px]', open && 'border-b border-[var(--color-border)]')}>
      <h2 className="text-[12px] font-semibold text-[var(--color-text-muted)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 rounded-ui focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
        >
          Closed today
          <span className="font-normal tabular-nums text-[var(--color-text-faint)]">{count}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3 text-[var(--color-text-faint)] transition-transform',
              !open && '-rotate-90',
            )}
          />
        </button>
      </h2>
    </div>
  );
}
