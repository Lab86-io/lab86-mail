'use client';

import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type ListItem, ListRow } from '@/components/albatross/shapes/ListRow';
import { cn } from '@/lib/utils';

export const SETTLE_FILL_MS = 150;
export const SETTLE_HOLD_MS = 400;
export const SETTLE_MOVE_MS = 300;
export const LIST_EMPTY_LINE = 'Nothing on the list yet.';
export const LIST_SAVE_ERROR = 'Could not save. Try again.';
export const LIST_ADD_PLACEHOLDER = 'Add';
/** More done items than this and a "Hide done" control appears. */
export const HIDE_DONE_ABOVE = 5;

/** Pasted text with several lines becomes several items. Blank lines are dropped. */
export function splitPastedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);
}

/**
 * The rows in the order the page shows them. Open items sit first, by the
 * time they were added. Done items sit last, the most recent at the bottom.
 * A held item keeps the group it was in before its toggle, so the row can
 * fill in place and settle after the hold.
 */
export function orderedListItems(
  items: ListItem[],
  holds: ReadonlyMap<string, boolean> = new Map(),
): { open: ListItem[]; done: ListItem[] } {
  const open: ListItem[] = [];
  const done: ListItem[] = [];
  for (const item of items) {
    const shownDone = holds.has(item.id) ? holds.get(item.id)! : item.done;
    (shownDone ? done : open).push(item);
  }
  open.sort((a, b) => a.addedAt - b.addedAt);
  done.sort((a, b) => (a.doneAt ?? a.addedAt) - (b.doneAt ?? b.addedAt));
  return { open, done };
}

/** The server rows with the user's last toggles laid over them. */
export function visibleListItems(
  items: ListItem[],
  optimistic: ReadonlyMap<string, { done: boolean; at: number }>,
): ListItem[] {
  return items.map((item) => {
    const choice = optimistic.get(item.id);
    if (!choice || choice.done === item.done) return item;
    return { ...item, done: choice.done, doneAt: choice.done ? choice.at : undefined };
  });
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * Move each row from its last position to its new one. The move is a 300 ms
 * transform, so a settle reads as motion and not as a jump.
 */
function useSettleMoves(orderKey: string) {
  const rows = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const register = useCallback((id: string, node: HTMLElement | null) => {
    if (node) rows.current.set(id, node);
    else rows.current.delete(id);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new order is the trigger; the rows come from the ref.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const animate = !reducedMotion();
    const next = new Map<string, number>();
    for (const [id, node] of rows.current) {
      const top = node.offsetTop;
      next.set(id, top);
      const previous = tops.current.get(id);
      if (!animate || previous === undefined || Math.abs(previous - top) < 1) continue;
      node.style.transition = 'none';
      node.style.transform = `translateY(${previous - top}px)`;
      void node.offsetHeight;
      node.style.transition = `transform ${SETTLE_MOVE_MS}ms var(--ease-enter)`;
      node.style.transform = '';
    }
    tops.current = next;
  }, [orderKey]);

  return register;
}

/**
 * The list body. A quick-add line, then the open items, a hairline, and the
 * done items. No header chrome. A checked item fills, holds, then settles to
 * the bottom.
 */
export function ListBody({
  items,
  onAdd,
  onToggle,
  onRemove,
  busyIds,
  error = null,
  className,
}: {
  items: ListItem[];
  onAdd: (texts: string[]) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  busyIds?: ReadonlySet<string>;
  error?: string | null;
  className?: string;
}) {
  const [draft, setDraft] = useState('');
  const [holds, setHolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [hideDone, setHideDone] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
    };
  }, []);

  const toggle = (id: string) => {
    const item = items.find((row) => row.id === id);
    if (!item) return;
    const shownDone = holds.has(id) ? holds.get(id)! : item.done;
    setHolds((current) => new Map(current).set(id, shownDone));
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setHolds((current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }, SETTLE_FILL_MS + SETTLE_HOLD_MS),
    );
    onToggle(id);
  };

  const add = (texts: string[]) => {
    const clean = texts.map((text) => text.trim()).filter(Boolean);
    if (!clean.length) return;
    onAdd(clean);
    setDraft('');
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    add([draft]);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.includes('\n')) return;
    event.preventDefault();
    add(splitPastedLines(text));
  };

  const { open, done } = orderedListItems(items, holds);
  const orderKey = [...open, ...done].map((item) => item.id).join('|');
  const register = useSettleMoves(orderKey);
  const shownDone = hideDone ? [] : done;

  return (
    <section aria-label="List" data-shape-body="list" className={cn('mt-6', className)}>
      <input
        type="text"
        aria-label="Add an item"
        value={draft}
        placeholder={LIST_ADD_PLACEHOLDER}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        className={cn(
          'w-full border-0 border-b border-[var(--color-border)] bg-transparent px-0 py-2 text-[14px] leading-6 outline-none',
          'placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]',
        )}
      />
      {items.length === 0 ? (
        <p className="mt-4 text-[13px] text-[var(--color-text-muted)]">{LIST_EMPTY_LINE}</p>
      ) : (
        <ul className="mt-2" data-list-order={orderKey}>
          {open.map((item) => (
            <ListRow
              key={item.id}
              item={item}
              busy={busyIds?.has(item.id)}
              onToggle={toggle}
              onRemove={onRemove}
              rowRef={(node) => register(item.id, node)}
            />
          ))}
          {done.length ? (
            <li
              aria-hidden
              data-list-hairline
              className={cn('my-1 h-px bg-[var(--color-border)]', !open.length && 'hidden')}
            />
          ) : null}
          {shownDone.map((item) => (
            <ListRow
              key={item.id}
              item={item}
              busy={busyIds?.has(item.id)}
              onToggle={toggle}
              onRemove={onRemove}
              rowRef={(node) => register(item.id, node)}
            />
          ))}
        </ul>
      )}
      {done.length > HIDE_DONE_ABOVE ? (
        <button
          type="button"
          onClick={() => setHideDone((current) => !current)}
          className="mt-2 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
        >
          {hideDone ? `Show done (${done.length})` : 'Hide done'}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </section>
  );
}
