'use client';

import {
  CalendarDays,
  ChevronDown,
  CircleCheck,
  FileText,
  GitBranch,
  GitPullRequest,
  Hash,
  KeyRound,
  type LucideIcon,
  Mail,
  Mic,
  SquareKanban,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useState } from 'react';
import { ApprovalDecisionPills, useApprovalView } from '@/components/albatross/ApprovalDecision';
import type { NotificationItem } from '@/components/notifications/model';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type ApprovalView, approvalRowLine } from '@/lib/albatross/approval-decision';
import type { ObligationSource, ObligationView } from '@/lib/obligations/contract';
import type { LaterOption, NeedsYouEntry, NeedsYouGroup } from '@/lib/obligations/groups';
import { isClosedObligation } from '@/lib/obligations/groups';
import {
  agoLabel,
  type DueLabel,
  type DueTone,
  dueLabel,
  kindLabel,
  primaryAction,
  rowLeadKind,
  sourceWords,
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

/** One monochrome glyph for each source. Never a logo. */
const SOURCE_GLYPHS: Record<ObligationSource, LucideIcon> = {
  mail: Mail,
  slack: Hash,
  atlassian: SquareKanban,
  granola: Mic,
  drive: FileText,
  github: GitPullRequest,
  bitbucket: GitBranch,
  calendar: CalendarDays,
};

/** The round source mark: a glyph in the control color. The size follows the avatar beside it. */
export function SourceGlyph({
  source,
  size = 28,
  className,
}: {
  source: ObligationSource;
  size?: number;
  className?: string;
}) {
  const Glyph = SOURCE_GLYPHS[source] ?? Mail;
  return (
    <span
      aria-hidden
      data-needs-you-glyph={source}
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-[var(--color-avatar-ring)] bg-[var(--color-control)] text-[var(--color-text-muted)]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Glyph style={{ width: size / 2, height: size / 2 }} />
    </span>
  );
}

/** The lead of one obligation: initials for a person, a source glyph for a system, a key for a code. */
export function ObligationLead({
  obligation,
  size = 28,
  className,
}: {
  obligation: ObligationView;
  size?: number;
  className?: string;
}) {
  const kind = rowLeadKind(obligation);
  if (kind === 'code') {
    return (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-full border border-[var(--color-avatar-ring)] bg-[var(--color-control)] text-[var(--color-text-muted)]',
          className,
        )}
        style={{ width: size, height: size }}
      >
        <KeyRound style={{ width: size / 2, height: size / 2 }} />
      </span>
    );
  }
  if (kind === 'glyph') return <SourceGlyph source={obligation.source} size={size} className={className} />;
  return <Avatar name={obligation.asker} size={size} className={className} />;
}

/** The round lead of a row: initials for a person, a glyph for a code, a source, or an Albatross. */
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
  return <ObligationLead obligation={entry.obligation} className="mt-px" />;
}

function albatrossDue(item: NotificationItem): DueLabel {
  if (item.kind === 'checkin') return { text: 'Today', tone: 'today' };
  return { text: 'Your turn', tone: 'plain' };
}

/** The words of one row, so the row and the tests agree. An approval row says what goes out and to whom. */
export function rowWords(entry: NeedsYouListEntry, now: number, timezone: string, approval?: ApprovalView) {
  if (entry.type === 'albatross') {
    const { item } = entry;
    const checkin = item.kind === 'checkin';
    if (approval) {
      return {
        name: item.title,
        // The title is long, and the round lead already says Albatross.
        source: '',
        line: approval.line ?? approvalRowLine(item.body),
        meta: [item.createdAt ? whenLabel(item.createdAt, now, timezone) : null, item.source]
          .filter(Boolean)
          .join(' · '),
        due: { text: approval.word, tone: approval.tone } as DueLabel,
      };
    }
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
        : [when, kindLabel(obligation), obligation.workTitle?.trim() || null].filter(Boolean).join(' · ');
  // "Board check-in · Calendar · Board check-in" says the place twice: the asker already names it.
  const label = obligation.sourceLabel?.trim();
  return {
    name: obligation.asker,
    source: sourceWords({
      source: obligation.source,
      sourceLabel: label && label !== obligation.asker ? label : undefined,
    }),
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
  onRsvp?: (response: 'yes' | 'no' | 'maybe') => void;
  onStartAlbatross?: () => void;
  /** The Later menu on the row, beside Done. Without options the row has no Later pill. */
  laterOptions?: readonly LaterOption[];
  onLater?: (option: LaterOption) => void;
  /** An Albatross question or approval: the one action of its row ("Answer"). */
  onAlbatrossAction?: () => void;
  albatrossActionLabel?: string;
  /** Reply in place (the Today list). Without it, the Reply pill opens the row. */
  onReply?: () => void;
  /** A closed row inside its Undo window shows Undo in place of the due word. */
  onUndo?: () => void;
  /** The word beside Undo, when it is not the close reason ("Later"). */
  undoWord?: string;
  /** The pills stay in view, not only on hover: a touch screen, or a list outside the page. */
  pillsAlways?: boolean;
  /** No side padding: the row sits in a measure that already has its inset (the Today list). */
  flush?: boolean;
  registerRef: (node: HTMLButtonElement | null) => void;
}

interface Pill {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

/** The hover pills of one open obligation: the first action, then Done. An invitation shows Yes and No. */
export function rowPills(
  obligation: ObligationView,
  handlers: Pick<NeedsYouRowProps, 'onOpen' | 'onDone' | 'onCopy' | 'onRsvp' | 'onStartAlbatross'> & {
    copied?: boolean;
    /** Reply in place; without it, Reply opens the row. */
    onReply?: () => void;
  },
): Pill[] {
  if (isClosedObligation(obligation)) return [];
  const pills: Pill[] = [];
  const primary = primaryAction(obligation);
  if (primary === 'copy') {
    if (handlers.onCopy)
      pills.push({ label: handlers.copied ? 'Copied' : 'Copy', onClick: handlers.onCopy, primary: true });
  } else if (primary === 'send_reply') {
    pills.push({ label: 'Reply', onClick: handlers.onReply ?? handlers.onOpen, primary: true });
  } else if (primary === 'rsvp') {
    const { onRsvp } = handlers;
    if (onRsvp) {
      pills.push({ label: 'Yes', onClick: () => onRsvp('yes'), primary: true });
      pills.push({ label: 'No', onClick: () => onRsvp('no') });
    }
    return pills;
  } else if (primary === 'start_albatross' && handlers.onStartAlbatross) {
    pills.push({ label: 'Start in Albatross', onClick: handlers.onStartAlbatross, primary: true });
  }
  if (handlers.onDone) pills.push({ label: 'Done', onClick: handlers.onDone });
  return pills;
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
  onRsvp,
  onStartAlbatross,
  laterOptions,
  onLater,
  onAlbatrossAction,
  albatrossActionLabel,
  onReply,
  onUndo,
  undoWord,
  pillsAlways,
  flush,
  registerRef,
}: NeedsYouRowProps) {
  const approval = entry.type === 'albatross' ? entry.item.approval : undefined;
  const approvalView = useApprovalView(approval);
  const words = rowWords(entry, now, timezone, approvalView);
  const obligation = entry.type === 'obligation' ? entry.obligation : null;
  const closed = obligation ? isClosedObligation(obligation) : false;
  const code = obligation?.kind === 'code' && !closed ? obligation.code : null;
  const pills = obligation
    ? rowPills(obligation, { onOpen, onDone, onCopy, onRsvp, onStartAlbatross, copied, onReply })
    : onAlbatrossAction
      ? [{ label: albatrossActionLabel || 'Answer', onClick: onAlbatrossAction, primary: true }]
      : [];
  const later = obligation && !closed && obligation.kind !== 'code' && onLater && laterOptions?.length;
  const [laterOpen, setLaterOpen] = useState(false);
  const undo = Boolean(onUndo) && (closed || Boolean(undoWord));
  const hasPills = pills.length > 0 || Boolean(later);
  const due = words.due;
  const pillClass = (primary?: boolean) =>
    cn(
      'h-[22px] whitespace-nowrap rounded-[8px] border bg-[var(--color-bg-elevated)] px-2 text-[12px] font-medium leading-5 transition-colors hover:bg-[var(--color-control-hover)] disabled:opacity-60',
      primary
        ? 'border-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-border))] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
    );
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
          'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 py-[11px] text-left transition-colors hover:bg-[var(--color-hover-soft)] focus-visible:rounded-ui focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-ring)]',
          flush ? 'px-0' : 'px-5',
          selected && 'bg-[var(--color-selected-soft)]',
          closed && 'opacity-[0.72]',
        )}
      >
        <RowLead entry={entry} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="max-w-[75%] shrink-0 truncate font-display text-[14px] font-medium leading-[18px] text-[var(--color-text)]">
              {words.name}
            </span>
            {words.source ? (
              <span
                data-needs-you-source
                className="flex min-w-0 shrink items-baseline gap-[7px] text-[11px] leading-[18px] text-[var(--color-text-muted)]"
              >
                <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-[var(--color-text-faint)]" />
                <span className="truncate">{words.source}</span>
              </span>
            ) : null}
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
            hasPills && !pillsAlways && 'group-hover:invisible group-focus-within:invisible',
            laterOpen && 'invisible',
            (hasPills && pillsAlways) || undo ? 'invisible' : undefined,
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
      {approval && approvalView?.canDecide ? (
        <ApprovalDecisionPills
          approval={approval}
          size="row"
          className={cn(
            'absolute bottom-[9px]',
            flush ? 'right-0' : 'right-3',
            pillsAlways ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
          )}
        />
      ) : null}
      {undo ? (
        <span className={cn('absolute top-[9px] flex items-baseline gap-2', flush ? 'right-0' : 'right-3')}>
          <span className={cn('text-[11.5px] leading-[22px]', DUE_TONE.done)}>{undoWord ?? due.text}</span>
          <button
            type="button"
            data-needs-you-undo
            onClick={(event) => {
              event.stopPropagation();
              onUndo?.();
            }}
            className={pillClass(true)}
          >
            Undo
          </button>
        </span>
      ) : hasPills ? (
        <span
          className={cn(
            'absolute top-[9px] gap-1',
            flush ? 'right-0' : 'right-3',
            // The menu is a portal: focus leaves the row, and the pills must stay.
            pillsAlways || laterOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
          )}
        >
          {pills.map((pill) => (
            <button
              key={pill.label}
              type="button"
              tabIndex={pillsAlways ? 0 : -1}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                pill.onClick();
              }}
              className={pillClass(pill.primary)}
            >
              {pill.label}
            </button>
          ))}
          {later ? (
            <DropdownMenu open={laterOpen} onOpenChange={setLaterOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-needs-you-later
                  tabIndex={pillsAlways ? 0 : -1}
                  disabled={busy}
                  onClick={(event) => event.stopPropagation()}
                  className={pillClass()}
                >
                  Later
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {laterOptions.map((option) => (
                  <DropdownMenuItem key={option.id} onSelect={() => onLater(option)}>
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
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
