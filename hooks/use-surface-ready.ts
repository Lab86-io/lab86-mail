'use client';

import { useEffect, useState } from 'react';
import type { MarkedSurface } from '@/lib/ops/speed';
import { markSurfaceReady, openSurfaceVisit } from '@/lib/ops/surface-timing';

/**
 * Times one surface. Mounting starts the visit; `ready` true ends it, on the
 * next frame so that the content has painted. A surface that remounts is a
 * new visit: a keyed thread gets one for each thread.
 */
export function useSurfaceReady(surface: MarkedSurface, ready: boolean) {
  useState(() => openSurfaceVisit(surface));
  useEffect(() => {
    // A test renderer has no frames, and the reporter is off there.
    if (!ready || typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(() => markSurfaceReady(surface));
    return () => cancelAnimationFrame(frame);
  }, [ready, surface]);
}
