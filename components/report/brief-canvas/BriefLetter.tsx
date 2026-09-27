'use client';

import { type CSSProperties, useState } from 'react';
import { NarrativeBrief } from '@/components/narrative/NarrativeBrief';
import { Avatar } from '@/components/ui/avatar';
import { briefRefKey } from '@/lib/brief/hydration';
import {
  BRIEF_LETTER_EMPTY_COPY,
  BRIEF_LETTER_MEASURE_PX,
  type BriefLetterKind,
  briefLetterHasNoRows,
  markWeekdays,
  noiseFooterCopy,
} from '@/lib/brief/letter';
import { briefActionTier, isBriefSteeringAction, isKnownBriefAction } from '@/lib/shared/brief-actions';
import type {
  BriefActionV2,
  BriefContentLeaf,
  BriefDocumentV2,
  BriefNode,
} from '@/lib/shared/brief-document';
import { shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';
import { BriefReviewPopover, BriefSteeringMenu } from './BriefActions';
import { type BriefNodeContext, BriefNodeView, withBriefRegion } from './BriefNodeView';
import { payloadForBriefAction } from './brief-action-runtime';

/* The letter keeps its narrative in one column, with weather in the masthead:
 * the lede, lanes as real mail rows, the week
 * ahead with weekday names in the data voice, three area lines, and one
 * footer count. No tiles, no cards, no counts in headings. The same renderer
 * carries the area pulse: lede, pulse lines, one prompt, live open work. */

type EntityListNode = Extract<BriefContentLeaf, { kind: 'entity_list' }>;
type EntityItem = EntityListNode['items'][number];

// Kicker copy for the row lanes when the document carries no title of its own
// (brief round 2026-09-22: waiting, tasks, connected, and the area mail lane).
const LANE_TITLES: Record<string, string> = {
  answer: 'Answer',
  today: 'Today',
  know: 'Know',
  since: 'What Albatross did',
  done: 'Done this week',
  open: 'Still open',
  'next-week': 'Next week',
  waiting: 'Waiting on',
  tasks: 'Tasks this week',
  connected: 'Connected tools',
  mail: 'Mail',
};

// Paragraph regions and their kickers: the daily `yesterday` and `week-ahead`,
// and the area `week`.
const PARAGRAPH_KICKERS: Record<string, string> = {
  yesterday: 'Since yesterday',
  'week-ahead': 'Week ahead',
  week: 'Week ahead',
};

// The entrance stagger from the design note: 120, 170, 205 ms, then +60 ms.
const ROW_DELAYS_MS = [120, 170, 205];
function rowDelay(index: number): number {
  return index < ROW_DELAYS_MS.length ? ROW_DELAYS_MS[index] : 205 + (index - 2) * 60;
}

export function BriefLetter({
  document,
  kind,
  context,
  noiseCount,
}: {
  document: BriefDocumentV2;
  kind: BriefLetterKind;
  context: BriefNodeContext;
  noiseCount?: number | null;
}) {
  const footer = kind === 'daily' ? noiseFooterCopy(noiseCount) : null;
  const empty = kind === 'daily' && briefLetterHasNoRows(document);
  // The weekly review reads in the same wide layout as the daily letter.
  const wide = kind === 'daily' || kind === 'weekly';
  let rowIndex = 0;

  return (
    <div
      data-brief-letter={kind}
      className={cn('mx-auto w-full', wide && 'daily-brief-layout')}
      style={wide ? undefined : ({ maxWidth: BRIEF_LETTER_MEASURE_PX } satisfies CSSProperties)}
    >
      <div data-brief-column="narrative" className="min-w-0">
        {document.regions.map((region) => {
          if (region.id === 'lede') {
            return (
              <section key={region.id} data-brief-region={region.id} className="blur-in">
                {kind === 'daily' && context.liveSections ? (
                  <NarrativeBrief at={document.generatedAt} fallback={<LetterLede node={region.tree} />} />
                ) : (
                  <LetterLede node={region.tree} />
                )}
                <div aria-hidden className="flex justify-center py-5">
                  <span className="h-px w-10 bg-[var(--color-border-strong)]" />
                </div>
                {empty ? (
                  <p className="mb-6 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                    {BRIEF_LETTER_EMPTY_COPY}
                  </p>
                ) : null}
              </section>
            );
          }
          if (region.tree.kind === 'entity_list' && region.id !== 'areas') {
            const start = rowIndex;
            rowIndex += region.tree.items.length;
            return (
              <LetterLane
                key={region.id}
                regionId={region.id}
                node={region.tree}
                context={withBriefRegion(context, region.id)}
                firstRowIndex={start}
              />
            );
          }
          if (region.tree.kind === 'text' && PARAGRAPH_KICKERS[region.id]) {
            return (
              <section key={region.id} data-brief-region={region.id} className="blur-in mb-8">
                <span className="mb-2 block text-[11px] font-semibold text-[var(--color-accent-2)]">
                  {PARAGRAPH_KICKERS[region.id]}
                </span>
                <WeekAheadText text={region.tree.text} />
              </section>
            );
          }
          if (region.id === 'areas' && region.tree.kind === 'entity_list') {
            return (
              <LetterAreas key={region.id} node={region.tree} context={withBriefRegion(context, region.id)} />
            );
          }
          if (region.id === 'pulse' && region.tree.kind === 'stack') {
            return (
              <section
                key={region.id}
                data-brief-region={region.id}
                className="blur-in mb-8 flex flex-col gap-2"
              >
                {region.tree.children.map((child, index) =>
                  child.kind === 'text' ? (
                    <PulseLine key={child.id ?? index} text={child.text} />
                  ) : (
                    <BriefNodeView
                      key={child.id ?? index}
                      node={child}
                      context={withBriefRegion(context, region.id)}
                      regionSummary={region.summary}
                    />
                  ),
                )}
              </section>
            );
          }
          // The ask prompt and the live open-work list keep their canvas
          // renderers; the letter only sets the measure and the rhythm.
          return (
            <section key={region.id} data-brief-region={region.id} className="blur-in mb-8">
              <BriefNodeView
                node={region.tree}
                context={withBriefRegion(context, region.id)}
                regionSummary={region.summary}
                topLevel
              />
            </section>
          );
        })}
        {footer ? (
          <p
            data-brief-letter-footer
            className="mt-2 border-t border-[var(--color-border)] pt-4 text-[12.5px] text-[var(--color-text-muted)]"
          >
            {footer}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LetterLede({ node }: { node: BriefNode }) {
  if (node.kind !== 'hero') return null;
  return (
    <div className="flex flex-col gap-3">
      {node.children.map((child, index) =>
        child.kind === 'text' && child.role === 'lede' ? (
          <p
            key={child.id ?? index}
            data-brief-letter-lede
            className="text-pretty font-display text-[22px] leading-[1.45] text-[var(--color-text)]"
          >
            {child.text}
          </p>
        ) : child.kind === 'text' ? (
          <p
            key={child.id ?? index}
            className="indent-[1.5em] text-[14px] leading-relaxed text-[var(--color-text-muted)]"
          >
            {child.text}
          </p>
        ) : null,
      )}
    </div>
  );
}

function LetterLane({
  regionId,
  node,
  context,
  firstRowIndex,
}: {
  regionId: string;
  node: EntityListNode;
  context: BriefNodeContext;
  firstRowIndex: number;
}) {
  const visible = node.items.filter((item) => !context.hiddenRefs.has(briefRefKey(item.ref)));
  if (!visible.length) return null;
  const title = node.title || LANE_TITLES[regionId] || null;
  return (
    <section
      data-brief-region={regionId}
      className={cn(
        'brief-letter-lane surface-card mb-8 rounded-card p-1',
        regionId === 'answer'
          ? 'surface-accent'
          : regionId === 'today'
            ? 'surface-accent-3'
            : 'surface-accent-2',
      )}
    >
      {title ? (
        <span
          data-brief-letter-kicker
          className="block border-b border-[var(--surface-border)] px-3 py-2 text-[11px] font-semibold text-[var(--surface-accent)]"
        >
          {title}
        </span>
      ) : null}
      <div className="brief-letter-items">
        {visible.map((item, index) => (
          <LetterRow
            key={briefRefKey(item.ref)}
            item={item}
            context={context}
            delayMs={rowDelay(firstRowIndex + index)}
          />
        ))}
      </div>
    </section>
  );
}

/* One row: a leading mark, a name line, the subject, the one line, and the
 * known actions as text. The first known action is the row tap; the rest sit
 * after it at the row end. Threads show the sender, events the hour, tasks
 * the due day, connected tools their source. The sender comes from the
 * document first and from hydration second. */
function LetterRow({
  item,
  context,
  delayMs,
}: {
  item: EntityItem;
  context: BriefNodeContext;
  delayMs: number;
}) {
  const key = briefRefKey(item.ref);
  const entity = context.entities.get(key);
  const gone = entity?.gone === true;
  const kind = item.ref.kind;
  const isEvent = kind === 'event';
  const isTask = kind === 'task' || kind === 'card';
  const isTool = kind === 'mcp';
  // A logged operation from "What Albatross did" (FEATURES item 7).
  const isOperation = kind === 'derived' && item.ref.id.startsWith('operation:');
  const subject = entity?.title || item.ref.label || '(no subject)';
  const sender = isEvent
    ? 'Calendar'
    : isTask
      ? 'Task'
      : isOperation
        ? item.framing.sender || 'Albatross'
        : item.framing.sender ||
          (entity?.subtitle ? shortFrom(entity.subtitle) : '') ||
          (isTool ? 'Connected tool' : 'Unknown sender');
  const age = item.framing.age?.trim() || '';
  const completed = isTask ? (context.completedRefs.get(key) ?? entity?.completed ?? false) : false;
  const unread = kind === 'thread' && entity?.unread === true;
  const line = item.framing.reason || (gone ? 'This item is no longer available.' : '');
  // Steering choices go to the overflow menu; the row keeps the rest.
  const known = item.actions.filter(
    (candidate) => isKnownBriefAction(candidate.action) && !isBriefSteeringAction(candidate.action),
  );
  const steering = item.actions.filter((candidate) => isBriefSteeringAction(candidate.action));
  const action = known[0];
  const run = (candidate: BriefActionV2) =>
    context.onAction(candidate, payloadForBriefAction(candidate, item.ref), item.ref);

  return (
    <article
      data-brief-letter-row
      data-brief-letter-completed={completed || undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' && action && !gone) {
          event.preventDefault();
          // A review action confirms in its popover; Enter on the row does
          // not skip that step.
          if (!letterActionConfirms(action.action)) void run(action);
          return;
        }
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault();
          focusSiblingRow(event.currentTarget, event.key === 'j' ? 1 : -1);
        }
      }}
      className={cn(
        'brief-letter-row blur-in flex gap-3 rounded-ui px-3 py-3 outline-none hover:bg-[var(--color-hover-soft)] focus-visible:bg-[var(--color-hover-soft)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]',
        gone && 'opacity-55',
      )}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {isEvent || isTask || isOperation ? (
        <span
          aria-hidden
          className={cn(
            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full font-display text-[11px] font-semibold',
            isEvent
              ? 'bg-[var(--color-accent-3-soft)] text-[var(--color-accent-3)]'
              : completed || isOperation
                ? 'bg-[var(--color-accent-2-soft)] text-[var(--color-accent-2)]'
                : 'border border-[var(--color-border-strong)] text-[var(--color-text-muted)]',
          )}
        >
          {isEvent ? eventHour(entity?.startAt) : completed || isOperation ? '\u2713' : dueDay(entity?.dueAt)}
        </span>
      ) : (
        <Avatar name={sender} size={28} className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-0.5 @[480px]:flex-row @[480px]:items-baseline @[480px]:justify-between">
          <div className="min-w-0 flex-1">
            <p
              data-brief-letter-sender
              className="truncate font-display text-[15px] font-medium leading-snug text-[var(--color-text)]"
            >
              {sender}
              {age ? (
                <span
                  data-brief-letter-age
                  className="ml-2 font-sans text-[11px] font-normal text-[var(--color-text-muted)]"
                >
                  {age}
                </span>
              ) : null}
            </p>
            <p
              data-brief-letter-subject
              className={cn(
                'truncate text-[14px] leading-snug text-[var(--color-text)]',
                completed && 'line-through text-[var(--color-text-muted)]',
              )}
            >
              {unread ? (
                <>
                  <span
                    data-brief-letter-unread
                    aria-hidden
                    className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-[var(--color-accent)] align-middle"
                  />
                  <span className="sr-only">Unread. </span>
                </>
              ) : null}
              {subject}
            </p>
          </div>
          {(known.length || steering.length) && !gone ? (
            <span
              data-brief-letter-actions
              className="flex shrink-0 flex-wrap items-baseline gap-x-3 self-start @[480px]:self-baseline"
            >
              {known.map((candidate, index) => (
                <LetterAction
                  key={`${candidate.action}:${candidate.label}`}
                  action={candidate}
                  payload={payloadForBriefAction(candidate, item.ref)}
                  primary={index === 0}
                  onRun={() => run(candidate)}
                />
              ))}
              {steering.length ? (
                <BriefSteeringMenu actions={steering} onRun={run} className="self-center" />
              ) : null}
            </span>
          ) : null}
        </div>
        {line ? (
          <p
            data-brief-letter-line
            className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-text-muted)]"
          >
            {line}
          </p>
        ) : null}
      </div>
    </article>
  );
}

// Review actions that confirm before they run. `draft_reply` stays direct: it
// opens the composer and sends nothing, so a popover would add nothing.
function letterActionConfirms(action: string): boolean {
  return briefActionTier(action) === 'review' && action !== 'draft_reply';
}

/* One text action of a row. Immediate and navigation actions run on click;
 * review actions open the shared confirm popover first. */
function LetterAction({
  action,
  payload,
  primary,
  onRun,
}: {
  action: BriefActionV2;
  payload: Record<string, unknown>;
  primary: boolean;
  onRun: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const confirms = letterActionConfirms(action.action);
  const button = (
    <button
      type="button"
      data-brief-letter-action
      data-brief-letter-action-name={action.action}
      data-brief-letter-action-review={confirms || undefined}
      onClick={confirms ? undefined : () => void onRun()}
      className={cn(
        'text-[13px] hover:underline focus-visible:underline focus-visible:outline-none',
        primary ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]',
      )}
    >
      {action.label}
    </button>
  );
  if (!confirms) return button;
  return (
    <BriefReviewPopover
      action={action}
      payload={payload}
      open={open}
      onOpenChange={setOpen}
      pending={pending}
      onConfirm={async () => {
        setPending(true);
        try {
          await onRun();
          setOpen(false);
        } finally {
          setPending(false);
        }
      }}
    >
      {button}
    </BriefReviewPopover>
  );
}

// J and K move between the rows of the whole letter, across lanes.
function focusSiblingRow(row: HTMLElement, step: 1 | -1) {
  const letter = row.closest<HTMLElement>('[data-brief-letter]');
  if (!letter) return;
  const rows = Array.from(letter.querySelectorAll<HTMLElement>('[data-brief-letter-row]'));
  const current = rows.indexOf(row);
  const next = Math.min(rows.length - 1, Math.max(0, current + step));
  rows[next]?.focus();
}

function eventHour(startAt: number | undefined): string {
  if (typeof startAt !== 'number') return '·';
  const hour = new Date(startAt).getHours();
  const twelve = hour % 12 || 12;
  return String(twelve);
}

/* The due weekday of a task, short, in the data voice. */
function dueDay(dueAt: number | undefined): string {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) return '·';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(dueAt)).slice(0, 2);
}

/* Weekday names carry the data voice (accent-3, weight 500). The text is
 * plain in the document; the split happens here, not in the model. */
export function WeekAheadText({ text }: { text: string }) {
  return (
    <p
      data-brief-letter-week-ahead
      className="text-pretty text-[15px] leading-relaxed text-[var(--color-text)]"
    >
      {markWeekdays(text).map((segment) =>
        segment.weekday ? (
          <span
            key={`${segment.start}:${segment.text}`}
            data-brief-weekday
            className="font-medium text-[var(--color-accent-3)]"
          >
            {segment.text}
          </span>
        ) : (
          <span key={`${segment.start}:${segment.text}`}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/* Three area lines: "name · line". The name opens the area. */
function LetterAreas({ node, context }: { node: EntityListNode; context: BriefNodeContext }) {
  if (!node.items.length) return null;
  return (
    <section data-brief-region="areas" className="blur-in mb-6">
      {node.title ? (
        <span className="mb-1 block text-[11px] font-semibold text-[var(--color-accent-2)]">
          {node.title}
        </span>
      ) : null}
      <ul className="flex flex-col gap-1">
        {node.items.map((item) => {
          const action = item.actions.find((candidate) => isKnownBriefAction(candidate.action));
          const name = item.ref.label || 'Area';
          return (
            <li key={briefRefKey(item.ref)} data-brief-letter-area className="text-[13px] leading-relaxed">
              {action ? (
                <button
                  type="button"
                  onClick={() =>
                    void context.onAction(action, payloadForBriefAction(action, item.ref), item.ref)
                  }
                  className="font-medium text-[var(--color-text)] hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {name}
                </button>
              ) : (
                <span className="font-medium text-[var(--color-text)]">{name}</span>
              )}
              {item.framing.reason ? (
                <span className="text-[var(--color-text-muted)]"> · {item.framing.reason}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* "Last change: ..." lines of the area pulse. The label is the data voice. */
function PulseLine({ text }: { text: string }) {
  const split = text.match(/^(Last change|Next move|Open question):\s*(.*)$/s);
  if (!split) {
    return <p className="text-[15px] leading-relaxed text-[var(--color-text)]">{text}</p>;
  }
  return (
    <p data-brief-letter-pulse className="text-[15px] leading-relaxed text-[var(--color-text)]">
      <span className="font-medium text-[var(--color-accent-3)]">{split[1]}</span>
      <span className="text-[var(--color-text-muted)]">. </span>
      {split[2]}
    </p>
  );
}
