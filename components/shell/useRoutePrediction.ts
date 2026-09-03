'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BarRoute, RouteVerdict } from '@/lib/albatross/route-classifier';
import { flipRoute, instantRoute, predictRoute, ROUTE_CONFIRM_DELAY_MS } from '@/lib/albatross/route-client';

// The route state of the bar. The heuristic sets the chip at once. The
// endpoint confirms `delayMs` after the last keystroke. Tab flips the chip
// and locks it for this text. A blank field unlocks and reads Ask.

export interface RoutePredictionOptions {
  text: string;
  delayMs?: number;
  predict?: (text: string, options: { signal: AbortSignal }) => Promise<RouteVerdict>;
  instant?: (text: string, current: BarRoute) => RouteVerdict;
}

export interface RoutePrediction {
  route: BarRoute;
  confidence: number;
  /** True while the endpoint has not confirmed the shown route. */
  pending: boolean;
  /** True after Tab or a preset. A locked chip ignores predictions. */
  locked: boolean;
  /** True when the field is blank. The chip reads Ask and Tab does nothing. */
  empty: boolean;
  /** Flip the route by hand and lock it. No effect on a blank field. */
  flip: () => void;
  /** Set the route and lock it, for the sidebar door. */
  preset: (route: BarRoute) => void;
  /** Back to Ask, unlocked, not pending. For after a Hold lands. */
  reset: () => void;
}

export function useRoutePrediction({
  text,
  delayMs = ROUTE_CONFIRM_DELAY_MS,
  predict = predictRoute,
  instant = instantRoute,
}: RoutePredictionOptions): RoutePrediction {
  const [route, setRoute] = useState<BarRoute>('ask');
  const [confidence, setConfidence] = useState(0);
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const empty = text.trim() === '';

  const routeRef = useRef(route);
  routeRef.current = route;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const textRef = useRef(text);
  textRef.current = text;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    cancel();
    if (empty) {
      setRoute('ask');
      setConfidence(0);
      setPending(false);
      setLocked(false);
      return;
    }
    if (lockedRef.current) return;
    const verdict = instant(text, routeRef.current);
    setRoute(verdict.route);
    setConfidence(verdict.confidence);
    setPending(true);
    const requested = text;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const controller = new AbortController();
      controllerRef.current = controller;
      predict(requested, { signal: controller.signal })
        .then((confirmed) => {
          // A stale answer never lands on newer text, and never on a locked chip.
          if (controller.signal.aborted) return;
          if (requested !== textRef.current || lockedRef.current) return;
          setRoute(confirmed.route);
          setConfidence(confirmed.confidence);
          setPending(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          if (requested !== textRef.current || lockedRef.current) return;
          setPending(false);
        })
        .finally(() => {
          if (controllerRef.current === controller) controllerRef.current = null;
        });
    }, delayMs);
    return cancel;
  }, [text, empty, delayMs, predict, instant, cancel]);

  const flip = useCallback(() => {
    if (textRef.current.trim() === '') return;
    cancel();
    setRoute((current) => flipRoute(current));
    setConfidence(1);
    setPending(false);
    setLocked(true);
  }, [cancel]);

  const preset = useCallback(
    (next: BarRoute) => {
      cancel();
      setRoute(next);
      setConfidence(1);
      setPending(false);
      setLocked(true);
    },
    [cancel],
  );

  const reset = useCallback(() => {
    cancel();
    setRoute('ask');
    setConfidence(0);
    setPending(false);
    setLocked(false);
  }, [cancel]);

  return { route, confidence, pending, locked, empty, flip, preset, reset };
}
