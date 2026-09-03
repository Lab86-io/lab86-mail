'use client';

import { type CSSProperties, type TouchEvent, useCallback, useRef, useState } from 'react';

// Pull-to-resync for touch devices. A pull of `threshold` px on the calendar
// body posts a resync. The body offsets with resistance and springs back.

export const PULL_THRESHOLD_PX = 64;
export const PULL_RESISTANCE = 0.4;
export const PULL_MAX_OFFSET_PX = 48;
export const PULL_SPRING_MS = 300;

export function pullOffset(pull: number, max = PULL_MAX_OFFSET_PX, resistance = PULL_RESISTANCE): number {
  if (pull <= 0) return 0;
  return Math.min(max, pull * resistance);
}

// The pull only counts when nothing between the touch target and the
// container is scrolled down. Otherwise the user scrolls an inner list.
export function scrolledBetween(target: Element | null, container: Element | null): boolean {
  let node: Element | null = target;
  while (node && node !== container) {
    if ((node as HTMLElement).scrollTop > 0) return true;
    node = node.parentElement;
  }
  return false;
}

export interface PullToResync {
  offset: number;
  pulling: boolean;
  style: CSSProperties;
  handlers: {
    onTouchStart: (event: TouchEvent<HTMLElement>) => void;
    onTouchMove: (event: TouchEvent<HTMLElement>) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
}

export function usePullToResync({
  threshold = PULL_THRESHOLD_PX,
  onPull,
  enabled = true,
}: {
  threshold?: number;
  onPull: () => void;
  enabled?: boolean;
}): PullToResync {
  const [offset, setOffset] = useState(0);
  const [pulling, setPulling] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);

  const reset = useCallback(() => {
    startY.current = null;
    pullRef.current = 0;
    setPulling(false);
    setOffset(0);
  }, []);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (!enabled || event.touches.length !== 1) return;
      if (scrolledBetween(event.target as Element, event.currentTarget)) return;
      startY.current = event.touches[0].clientY;
      pullRef.current = 0;
    },
    [enabled],
  );

  const onTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    if (startY.current === null || event.touches.length !== 1) return;
    const pull = event.touches[0].clientY - startY.current;
    if (pull <= 0) {
      pullRef.current = 0;
      setOffset(0);
      setPulling(false);
      return;
    }
    if (scrolledBetween(event.target as Element, event.currentTarget)) return;
    pullRef.current = pull;
    setPulling(true);
    setOffset(pullOffset(pull));
  }, []);

  const onTouchEnd = useCallback(() => {
    if (startY.current === null) return;
    const pull = pullRef.current;
    reset();
    if (pull >= threshold) onPull();
  }, [onPull, reset, threshold]);

  const style: CSSProperties = {
    transform: offset ? `translateY(${offset}px)` : undefined,
    transition: pulling ? 'none' : `transform ${PULL_SPRING_MS}ms var(--ease-enter)`,
  };

  return {
    offset,
    pulling,
    style,
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset },
  };
}
