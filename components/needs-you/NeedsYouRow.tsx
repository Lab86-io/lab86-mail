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
import { todayRowLine } from '@/lib/obligations/today-page';
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
  glyph,
  className,
}: {
  source: ObligationSource;
  size?: number;
  /** The size of the glyph, when half of `size` is too small to read. */
  glyph?: number;
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
      <Glyph style={{ width: glyph ?? size / 2, height: glyph ?? size / 2 }} />
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
  const line = obligation.kind === 'code' && closed ? 'Verification code.' : obligation.title;
  return {
    name: obligation.asker,
    source: sourceWords({
      source: obligation.source,
      sourceLabel: label && label !== obligation.asker ? label : undefined,
    }),
    line,
    meta,
    when,
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
  /**
   * The Today list: the actions always show, at the right on a wide column and
   * under the text on a narrow one. The due word moves into the meta line.
   */
  actionsInline?: boolean;
  /** How many more notices this row stands for (one sender on the Today list). */
  bundled?: number;
  /** The first row of the Today list: only its first action has the solid fill. */
  lead?: boolean;
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

const FULL_DAYS: Record<string, string> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

/** A due word alone asks the reader to guess: "Fri" reads "Due Fri"; an invitation says when it starts. */
export function dueSentenceWord(obligation: Pick<ObligationView, 'kind'>, text: string): string {
  if (!text || obligation.kind === 'code' || obligation.kind === 'waiting' || /^(over|past)/i.test(text))
    return text;
  const word = /^(Today|Tomorrow|Yesterday)\b/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : (FULL_DAYS[text] ?? text);
  return `${obligation.kind === 'rsvp' || obligation.kind === 'prepare' ? 'Starts' : 'Due'} ${word}`;
}

/**
 * On the Today list the mark on the avatar names the source, so the words name
 * only the place, and not when the line already says it: "Answer the invitation: Standup".
 */
function placeWords(entry: NeedsYouListEntry, source: string, inline: boolean | undefined) {
  if (!inline || entry.type !== 'obligation') return source;
  const { sourceLabel, asker, title } = entry.obligation;
  const place = sourceLabel?.trim();
  return place && place !== asker && !title.includes(place) ? place : '';
}

/** The word of a row whose first action only opens the item: what the person does there. */
export function firstActionWord(obligation: Pick<ObligationView, 'source' | 'title'>): string {
  return /^review\b/i.test(obligation.title) ? 'Review' : 'Open';
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
  actionsInline,
  bundled = 0,
  lead,
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
  // The Today list: each row says where to start, so a row with no other first action opens.
  if (actionsInline && obligation && !closed) {
    if (!pills.some((pill) => pill.primary))
      pills.unshift({ label: firstActionWord(obligation), onClick: onOpen, primary: true });
    for (const pill of pills)
      pill.label =
        pill.label === 'Yes'
          ? 'Accept'
          : pill.label === 'No'
            ? 'Decline'
            : pill.label === 'Reply' && draftReady
              ? 'Open draft'
              : pill.label;
  }
  const later = obligation && !closed && obligation.kind !== 'code' && onLater && laterOptions?.length;
  const [laterOpen, setLaterOpen] = useState(false);
  const undo = Boolean(onUndo) && (closed || Boolean(undoWord));
  const hasPills = pills.length > 0 || Boolean(later);
  const due = words.due;
  const urgent = obligation?.pushLevel === 'time_sensitive';
  const statusWord = obligation
    ? due.text
      ? dueSentenceWord(obligation, due.text)
      : urgent
        ? 'Urgent'
        : ''
    : due.text;
  const pillClass = (primary?: boolean) =>
    actionsInline
      ? cn(
          // 36 px with a 44 px target on a touch width; 32 px beside a wide row.
          'h-11 w-full whitespace-nowrap rounded-[var(--radius-control)] border px-2 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ring)] disabled:opacity-60 @[560px]:h-8 @[560px]:text-[13px]',
          primary
            ? lead
              ? 'border-transparent bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:opacity-90'
              : 'border-transparent bg-[color-mix(in_oklab,var(--color-accent)_11%,var(--color-content))] font-semibold text-[var(--color-accent)] dark:bg-[color-mix(in_oklab,var(--color-accent)_22%,var(--color-content))] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]'
            : // The way out of a row stays quiet: text only until the pointer is on it.
              'border-transparent bg-transparent text-[color-mix(in_oklab,var(--color-text)_78%,var(--color-content))] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]',
        )
      : cn(
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
          'grid w-full items-start gap-x-3 text-left transition-colors hover:bg-[var(--color-hover-soft)] focus-visible:rounded-ui focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-ring)]',
          actionsInline
            ? 'grid-cols-[32px_minmax(0,1fr)] pb-1.5 pt-2.5 @[560px]:py-2.5 @[560px]:pr-[226px]'
            : 'grid-cols-[28px_minmax(0,1fr)_auto] py-[11px]',
          flush ? 'px-0' : 'px-5',
          selected && 'bg-[var(--color-selected-soft)]',
          closed && 'opacity-[0.72]',
        )}
      >
        <span className="relative">
          <RowLead entry={entry} />
          {actionsInline && obligation && obligation.source !== 'mail' ? (
            <SourceGlyph
              source={obligation.source}
              size={18}
              glyph={11}
              className="absolute -bottom-1 -right-1.5 border-2 border-[var(--color-content)]"
            />
          ) : null}
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              'flex min-w-0',
              actionsInline ? 'flex-wrap items-baseline gap-x-2' : 'items-baseline gap-2',
            )}
          >
            <span
              className={cn(
                'max-w-[75%] shrink-0 truncate leading-[18px] text-[var(--color-text)]',
                actionsInline
                  ? 'text-[13px] font-medium text-[color-mix(in_oklab,var(--color-text)_82%,var(--color-content))]'
                  : 'font-display text-[14px] font-medium',
              )}
            >
              {words.name}
            </span>
            {bundled > 0 || placeWords(entry, words.source, actionsInline) ? (
              <span
                data-needs-you-source
                className={cn(
                  'flex min-w-0 shrink items-baseline gap-[7px] leading-[18px] text-[var(--color-text-muted)]',
                  actionsInline ? 'text-[13px]' : 'text-[11px]',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-[3px] shrink-0 rounded-full bg-[var(--color-text-faint)]',
                    actionsInline && 'hidden',
                  )}
                />
                <span className="truncate">
                  {bundled > 0 ? `${bundled + 1} notices` : placeWords(entry, words.source, actionsInline)}
                </span>
              </span>
            ) : null}
            {actionsInline && statusWord ? (
              <span className="text-[13px] leading-[18px]">
                {statusWord ? (
                  <span
                    data-needs-you-due
                    className={
                      urgent && !due.text
                        ? 'rounded-[5px] bg-[color-mix(in_oklab,var(--color-accent-2)_14%,var(--color-content))] px-1.5 py-0.5 font-semibold text-[var(--color-accent-2)]'
                        : due.tone === 'plain' && !urgent
                          ? 'text-[var(--color-text-muted)]'
                          : // On this list a due word says one thing: time is short.
                            'font-medium text-[var(--color-accent-2)]'
                    }
                  >
                    {statusWord}
                  </span>
                ) : null}
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
                'mt-0.5 line-clamp-2',
                actionsInline
                  ? 'text-[15px] font-medium leading-[21px] tracking-[-0.003em]'
                  : 'text-[13px] leading-[18px]',
                closed ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]',
              )}
            >
              {actionsInline ? todayRowLine(words.line) : words.line}
            </span>
          )}
          {actionsInline ? null : (
            <span className="mt-1 block text-[11px] leading-[14px] text-[var(--color-text-faint)]">
              {words.meta}
              {draftReady ? ' · Draft ready' : ''}
            </span>
          )}
        </span>
        {actionsInline ? null : (
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
        )}
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
        <span
          className={cn(
            'absolute flex items-baseline gap-2',
            actionsInline ? 'top-3' : 'top-[9px]',
            flush ? 'right-0' : 'right-3',
          )}
        >
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
            actionsInline
              ? // Three fixed columns, so the actions line up from row to row.
                'grid grid-cols-[86px_64px_56px] gap-1 pb-2.5 pl-[44px] @[560px]:absolute @[560px]:right-0 @[560px]:top-1/2 @[560px]:-translate-y-1/2 @[560px]:pb-0 @[560px]:pl-0'
              : cn(
                  'absolute top-[9px] gap-1',
                  flush ? 'right-0' : 'right-3',
                  // The menu is a portal: focus leaves the row, and the pills must stay.
                  pillsAlways || laterOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
                ),
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
