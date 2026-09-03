'use client';

import { useEffect, useRef, useState } from 'react';

// One 2 px line on the top edge of the calendar frame. It grows to 70% while
// a sync runs, holds, then runs to 100% and fades when the sync settles. With
// reduced movement it is a static line for the sync, then gone.

export type SyncLinePhase = 'hidden' | 'start' | 'growing' | 'finishing' | 'fading' | 'static';

export interface SyncLineHost {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  requestFrame: (callback: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
}

const browserHost: SyncLineHost = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as any),
  requestFrame: (callback) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => callback())
      : setTimeout(callback, 16),
  cancelFrame: (handle) =>
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame(handle as any)
      : clearTimeout(handle as any),
};

export const SYNC_LINE_GROW_MS = 800;
export const SYNC_LINE_FINISH_MS = 200;
export const SYNC_LINE_FADE_MS = 200;

export function syncLineStyle(phase: SyncLinePhase): { width: string; opacity: number; transition: string } {
  switch (phase) {
    case 'start':
      return { width: '0%', opacity: 1, transition: 'none' };
    case 'growing':
      return { width: '70%', opacity: 1, transition: `width ${SYNC_LINE_GROW_MS}ms var(--ease-enter)` };
    case 'finishing':
      return { width: '100%', opacity: 1, transition: `width ${SYNC_LINE_FINISH_MS}ms var(--ease-exit)` };
    case 'fading':
      return { width: '100%', opacity: 0, transition: `opacity ${SYNC_LINE_FADE_MS}ms var(--ease-exit)` };
    case 'static':
      return { width: '100%', opacity: 1, transition: 'none' };
    default:
      return { width: '0%', opacity: 0, transition: 'none' };
  }
}

export function initialSyncLinePhase(active: boolean, reduceMotion: boolean): SyncLinePhase {
  if (!active) return 'hidden';
  return reduceMotion ? 'static' : 'start';
}

export function SyncLine({
  active,
  reduceMotion = false,
  host = browserHost,
}: {
  active: boolean;
  reduceMotion?: boolean;
  host?: SyncLineHost;
}) {
  const [phase, setPhase] = useState<SyncLinePhase>(() => initialSyncLinePhase(active, reduceMotion));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const current = phaseRef.current;
    if (reduceMotion) {
      setPhase(active ? 'static' : 'hidden');
      return;
    }
    if (active) {
      if (current === 'growing') return;
      if (current !== 'start') setPhase('start');
      const frame = host.requestFrame(() => setPhase('growing'));
      return () => host.cancelFrame(frame);
    }
    if (current === 'hidden' || current === 'fading') return;
    setPhase('finishing');
    const fade = host.setTimeout(() => setPhase('fading'), SYNC_LINE_FINISH_MS);
    const hide = host.setTimeout(() => setPhase('hidden'), SYNC_LINE_FINISH_MS + SYNC_LINE_FADE_MS);
    return () => {
      host.clearTimeout(fade);
      host.clearTimeout(hide);
    };
  }, [active, reduceMotion, host]);

  return (
    <div
      aria-hidden
      data-sync-line
      data-phase={phase}
      className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 bg-[var(--color-accent-3)]"
      style={syncLineStyle(phase)}
    />
  );
}
