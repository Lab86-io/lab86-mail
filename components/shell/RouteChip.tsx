'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BarRoute } from '@/lib/albatross/route-rules';
import { cn } from '@/lib/utils';

// One word at the right edge of the bar: Ask or Hold. Tab flips it. The color
// follows the route: accent-1 for Ask, accent-2 for Hold. No icon, no menu.

export const ROUTE_WORD: Record<BarRoute, string> = { ask: 'Ask', hold: 'Hold' };
export const ROUTE_FLIP_MS = 150;

export interface RouteChipProps {
  route: BarRoute;
  /** True after Tab. A locked chip shows a solid border. */
  locked?: boolean;
  /** True while the endpoint has not confirmed. The chip dims to 70%. */
  pending?: boolean;
  /** True on a blank field. The chip reads Ask at 55% and does nothing. */
  disabled?: boolean;
  reduceMotion?: boolean;
  onFlip?: () => void;
  className?: string;
}

/** The chip description for assistive tech. */
export function routeChipLabel(route: BarRoute, disabled: boolean): string {
  const word = ROUTE_WORD[route];
  if (disabled) return `Route: ${word}`;
  return `Route: ${word}. Press Tab to change it.`;
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function RouteChip({
  route,
  locked = false,
  pending = false,
  disabled = false,
  reduceMotion = false,
  onFlip,
  className,
}: RouteChipProps) {
  const wordRef = useRef<HTMLSpanElement>(null);
  const [leaving, setLeaving] = useState<BarRoute | null>(null);
  const previousRef = useRef(route);

  // The old word moves up 6 px and fades. The new one comes from 6 px below.
  // With reduced movement the word swaps in place.
  useIsomorphicLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = route;
    if (previous === route || reduceMotion) return;
    setLeaving(previous);
    const word = wordRef.current;
    if (word && typeof word.animate === 'function') {
      word.animate(
        [
          { transform: 'translateY(6px)', opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: ROUTE_FLIP_MS, easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)' },
      );
    }
    const timer = setTimeout(() => setLeaving(null), ROUTE_FLIP_MS);
    return () => clearTimeout(timer);
  }, [route, reduceMotion]);

  const leavingRef = useRef<HTMLSpanElement>(null);
  useIsomorphicLayoutEffect(() => {
    const ghost = leavingRef.current;
    if (!leaving || !ghost || typeof ghost.animate !== 'function') return;
    ghost.animate(
      [
        { transform: 'translateY(-50%)', opacity: 1 },
        { transform: 'translateY(calc(-50% - 6px))', opacity: 0 },
      ],
      { duration: ROUTE_FLIP_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
  }, [leaving]);

  const hold = route === 'hold';
  return (
    <button
      type="button"
      data-route={route}
      data-locked={locked || undefined}
      data-pending={pending || undefined}
      aria-label={routeChipLabel(route, disabled)}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onFlip?.();
      }}
      className={cn(
        'relative inline-flex h-6 select-none items-center overflow-hidden rounded-full border px-2.5 text-[11.5px] font-medium leading-none',
        'transition-[opacity,background-color,color,border-color] duration-[var(--duration-fast)] motion-reduce:transition-none',
        hold
          ? 'bg-[var(--color-accent-2-soft)] text-[var(--color-accent-2)]'
          : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
        locked
          ? hold
            ? 'border-[var(--color-accent-2)]'
            : 'border-[var(--color-accent)]'
          : 'border-transparent',
        disabled ? 'cursor-default opacity-55' : pending ? 'opacity-70' : 'opacity-100',
        className,
      )}
    >
      <span ref={wordRef} key={route} className="relative block">
        {ROUTE_WORD[route]}
      </span>
      {leaving ? (
        <span
          ref={leavingRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-2.5 top-1/2 -translate-y-1/2"
        >
          {ROUTE_WORD[leaving]}
        </span>
      ) : null}
    </button>
  );
}

/** The mono "Tab" hint left of the chip. Hidden below 480 px. */
export function RouteTabHint({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'hidden font-mono text-[10px] text-[var(--color-text-faint)] transition-opacity duration-[var(--duration-fast)] min-[480px]:inline',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      Tab
    </span>
  );
}
