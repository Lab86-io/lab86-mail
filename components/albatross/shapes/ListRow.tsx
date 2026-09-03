'use client';

import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ListItem {
  id: string;
  text: string;
  done: boolean;
  addedAt: number;
  doneAt?: number;
}

/** A touch press this long shows the Remove control. */
export const LONG_PRESS_MS = 500;

/**
 * One list item. A hollow circle, the text, and a quiet Remove control that
 * shows on hover or after a long press on touch. The circle fills in 150 ms
 * when the item is checked and the text drops to 55% opacity.
 */
export function ListRow({
  item,
  busy = false,
  onToggle,
  onRemove,
  rowRef,
}: {
  item: ListItem;
  busy?: boolean;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  /** Reports the row element, so the list can move it on a settle. */
  rowRef?: (node: HTMLLIElement | null) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(
    () => () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') return;
    clearPress();
    pressTimer.current = setTimeout(() => setRevealed(true), LONG_PRESS_MS);
  };

  return (
    <li
      ref={rowRef}
      data-list-item={item.id}
      data-done={item.done ? 'true' : 'false'}
      className={cn('group flex items-center gap-3 py-2 will-change-transform', busy && 'opacity-55')}
      onPointerDown={onPointerDown}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
    >
      <button
        type="button"
        aria-pressed={item.done}
        aria-label={item.done ? `Uncheck ${item.text}` : `Check ${item.text}`}
        disabled={busy}
        onClick={() => onToggle(item.id)}
        className={cn(
          'relative flex size-[18px] shrink-0 items-center justify-center rounded-full border',
          'transition-colors duration-[var(--duration-fast)]',
          item.done
            ? 'border-[var(--color-accent)]'
            : 'border-[var(--color-border-strong)] hover:border-[var(--color-accent)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-[10px] rounded-full bg-[var(--color-accent)] transition-transform duration-[var(--duration-fast)] ease-[var(--ease-enter)] motion-reduce:transition-none',
            item.done ? 'scale-100' : 'scale-0',
          )}
        />
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 text-[13.5px] leading-snug transition-opacity duration-[var(--duration-fast)]',
          item.done ? 'opacity-55' : 'opacity-100',
        )}
      >
        {item.text}
      </span>
      <button
        type="button"
        aria-label={`Remove ${item.text}`}
        disabled={busy}
        onClick={() => onRemove(item.id)}
        className={cn(
          'shrink-0 text-[11.5px] text-[var(--color-text-muted)] transition-opacity duration-[var(--duration-fast)]',
          'hover:text-[var(--color-text)] hover:underline focus-visible:opacity-100 group-hover:opacity-100',
          revealed ? 'opacity-100' : 'opacity-0',
        )}
      >
        Remove
      </button>
    </li>
  );
}
