'use client';

import { useEffect, useState } from 'react';
import { horizonLine, type WorkHorizon } from '@/lib/albatross/horizon';
import { cn } from '@/lib/utils';

export interface LaterCardWork {
  _id: string;
  title: string | null;
  rawText: string;
  horizon?: WorkHorizon | null;
}

/** The user's own words, unless the horizon line already says the same thing. */
export function laterCardLabel(work: LaterCardWork, line: string | null): string | null {
  const label = work.horizon?.label?.trim();
  if (!label) return null;
  if (line && line.trim().toLowerCase() === label.toLowerCase()) return null;
  return label;
}

/**
 * True one frame after mount. The card starts 24 px to the right and slides
 * into place. With reduced motion the CSS keeps it in place from the start.
 * The first render is the same on the server and the client, so hydration
 * has nothing to patch.
 */
export function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setEntered(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return entered;
}

/**
 * One dormant Work on the Later rail. A serif title, the wake line in the
 * status voice, and the user's words in italic. Nothing on it asks for
 * anything.
 */
export function LaterCard({
  work,
  nowMs,
  active = false,
  onOpen,
}: {
  work: LaterCardWork;
  nowMs: number;
  active?: boolean;
  onOpen: () => void;
}) {
  const entered = useEntered();
  const line = horizonLine(work.horizon, nowMs);
  const label = laterCardLabel(work, line);
  const title = work.title || work.rawText;
  return (
    <div
      className={cn(
        'w-full transition-[transform,opacity] duration-[var(--duration-normal)] ease-[var(--ease-enter)] sm:w-[200px] sm:shrink-0',
        'motion-reduce:transition-none motion-reduce:translate-x-0 motion-reduce:opacity-100',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
      )}
    >
      <button
        type="button"
        data-later-card={work._id}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className={cn(
          'flex w-full items-baseline justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left',
          'bg-[var(--color-bg)] transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)]',
          'hover:-translate-y-px hover:bg-[var(--color-bg-elevated)] hover:shadow-[var(--shadow-soft)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
          'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
          'sm:block',
          active ? 'border-[var(--color-accent)]/50' : 'border-[var(--color-border)]',
        )}
      >
        <span className="block min-w-0 flex-1 truncate font-serif text-[16px] font-semibold leading-snug">
          {title}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-[var(--color-accent-3)] sm:mt-1 sm:block">
          {line || 'Later'}
        </span>
        {label ? (
          <span className="mt-0.5 hidden truncate text-[12px] italic text-[var(--color-text-muted)] sm:block">
            {label}
          </span>
        ) : null}
      </button>
    </div>
  );
}
