'use client';

import type { CSSProperties } from 'react';
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
import { isKnownBriefAction } from '@/lib/shared/brief-actions';
import type {
  BriefActionV2,
  BriefContentLeaf,
  BriefDocumentV2,
  BriefNode,
} from '@/lib/shared/brief-document';
import { shortFrom } from '@/lib/shared/format';
import { cn } from '@/lib/utils';
import type { BriefNodeContext } from './BriefNodeView';
import { BriefNodeView } from './BriefNodeView';
import { payloadForBriefAction } from './brief-action-runtime';

/* The letter form of a brief (2026-09-03). One measure, top to bottom: the
 * lede in the display face, a dinkus, the lanes as real mail rows, the week
 * ahead with weekday names in the data voice, three area lines, and one
 * footer count. No tiles, no cards, no counts in headings. The same renderer
 * carries the area pulse: lede, pulse lines, one prompt, live open work. */

type EntityListNode = Extract<BriefContentLeaf, { kind: 'entity_list' }>;
type EntityItem = EntityListNode['items'][number];

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
  let rowIndex = 0;

  return (
    <div
      data-brief-letter={kind}
      className="mx-auto flex w-full flex-col"
      style={{ maxWidth: BRIEF_LETTER_MEASURE_PX } satisfies CSSProperties}
    >
      {document.regions.map((region) => {
        if (region.id === 'lede') {
          return (
            <section key={region.id} data-brief-region={region.id} className="blur-in">
              <LetterLede node={region.tree} />
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
              context={context}
              firstRowIndex={start}
            />
          );
        }
        if (region.id === 'week-ahead' && region.tree.kind === 'text') {
          return (
            <section key={region.id} data-brief-region={region.id} className="blur-in mb-8">
              <span className="mb-2 block text-[11px] font-semibold text-[var(--color-accent-2)]">
                Week ahead
              </span>
              <WeekAheadText text={region.tree.text} />
            </section>
          );
        }
        if (region.id === 'areas' && region.tree.kind === 'entity_list') {
          return <LetterAreas key={region.id} node={region.tree} context={context} />;
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
                    context={context}
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
            <BriefNodeView node={region.tree} context={context} regionSummary={region.summary} topLevel />
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
          <p key={child.id ?? index} className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">
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
  return (
    <section data-brief-region={regionId} className="mb-8">
      {node.title ? (
        <span
          data-brief-letter-kicker
          className="mb-1 block text-[11px] font-semibold text-[var(--color-accent-2)]"
        >
          {node.title}
        </span>
      ) : null}
      <div className="divide-y divide-[var(--color-border)]">
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

/* One mail row: avatar, sender, subject, the one line, one text action. The
 * sender comes from the document first and from hydration second. */
function LetterRow({
  item,
  context,
  delayMs,
}: {
  item: EntityItem;
  context: BriefNodeContext;
  delayMs: number;
}) {
  const entity = context.entities.get(briefRefKey(item.ref));
  const gone = entity?.gone === true;
  const isEvent = item.ref.kind === 'event';
  const subject = entity?.title || item.ref.label || '(no subject)';
  const sender = isEvent
    ? 'Calendar'
    : item.framing.sender || (entity?.subtitle ? shortFrom(entity.subtitle) : '') || 'Unknown sender';
  const line = item.framing.reason || (gone ? 'This item is no longer available.' : '');
  const action = item.actions.find((candidate) => isKnownBriefAction(candidate.action));
  const run = (candidate: BriefActionV2) =>
    context.onAction(candidate, payloadForBriefAction(candidate, item.ref), item.ref);

  return (
    <article
      data-brief-letter-row
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' && action && !gone) {
          event.preventDefault();
          void run(action);
          return;
        }
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault();
          focusSiblingRow(event.currentTarget, event.key === 'j' ? 1 : -1);
        }
      }}
      className={cn(
        'blur-in flex gap-3 py-3 outline-none focus-visible:bg-[var(--color-hover-soft)]',
        gone && 'opacity-55',
      )}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {isEvent ? (
        <span
          aria-hidden
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-accent-3-soft)] font-display text-[11px] font-semibold text-[var(--color-accent-3)]"
        >
          {eventHour(entity?.startAt)}
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
            </p>
            <p
              data-brief-letter-subject
              className="truncate text-[14px] leading-snug text-[var(--color-text)]"
            >
              {subject}
            </p>
          </div>
          {action && !gone ? (
            <button
              type="button"
              data-brief-letter-action
              onClick={() => void run(action)}
              className="shrink-0 self-start text-[13px] text-[var(--color-accent)] hover:underline focus-visible:underline focus-visible:outline-none @[480px]:self-baseline"
            >
              {action.label}
            </button>
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
