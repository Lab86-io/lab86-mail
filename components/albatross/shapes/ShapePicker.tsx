'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { SHAPE_MEANING } from '@/lib/albatross/shape-policy';
import { WORK_SHAPES, type WorkShape } from '@/lib/albatross/work-shape';
import { cn } from '@/lib/utils';

export const SHAPE_SAVE_ERROR = 'Could not change the shape. Try again.';

/** The next shape for an arrow key. The list does not wrap. */
export function stepShape(current: WorkShape, delta: 1 | -1): WorkShape {
  const index = WORK_SHAPES.indexOf(current);
  const next = Math.min(WORK_SHAPES.length - 1, Math.max(0, index + delta));
  return WORK_SHAPES[next];
}

/**
 * The shape word in the Work header. It is a text button, not a badge. It
 * opens the seven shapes, one line each. Up and Down move, Enter picks,
 * Escape closes. A pick calls `onChange` and closes.
 */
export function ShapePicker({
  value,
  onChange,
  saving = false,
  error = null,
  className,
}: {
  value: WorkShape;
  onChange: (next: WorkShape) => void;
  saving?: boolean;
  error?: string | null;
  className?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<WorkShape>(value);

  useEffect(() => {
    if (open) setCursor(value);
  }, [open, value]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const pick = (next: WorkShape) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setCursor((current) => stepShape(current, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      event.stopPropagation();
      pick(cursor);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the blur only closes the list; the button and the list carry the interaction.
    <div
      ref={rootRef}
      className={cn('relative inline-flex flex-col items-start', className)}
      onBlur={(event) => {
        if (open && !rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Shape: ${value}`}
        disabled={saving}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKey}
        className={cn(
          'rounded px-1 text-[12.5px] text-[var(--color-text-muted)] underline decoration-[var(--color-border-strong)] decoration-1 underline-offset-[3px]',
          'transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-text)] hover:decoration-[var(--color-accent)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
          saving && 'opacity-55',
        )}
      >
        {value}
      </button>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Shape"
          aria-activedescendant={`${listId}-${cursor}`}
          tabIndex={-1}
          onKeyDown={onKey}
          className="absolute left-0 top-full z-20 mt-1 w-80 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-soft)]"
        >
          {WORK_SHAPES.map((shape) => {
            const current = shape === value;
            const focused = shape === cursor;
            return (
              <button
                key={shape}
                type="button"
                id={`${listId}-${shape}`}
                role="option"
                aria-selected={current}
                tabIndex={-1}
                data-shape-option={shape}
                data-focused={focused ? 'true' : undefined}
                onPointerEnter={() => setCursor(shape)}
                onClick={() => pick(shape)}
                className={cn(
                  'flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left',
                  focused && 'bg-[var(--color-bg-subtle)]',
                )}
              >
                <span className={cn('w-16 shrink-0 text-[13px]', current ? 'font-semibold' : 'font-medium')}>
                  {shape}
                </span>
                <span className="text-[12px] text-[var(--color-text-muted)]">{SHAPE_MEANING[shape]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[11.5px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}
