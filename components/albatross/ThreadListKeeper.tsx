'use client';

// The list unmounts when the user leaves it, and Convex then drops its queries.
// A return would wait for the network again. The rail never unmounts, so this
// holds the two queries of the list there: a return paints from the live copy.
//
// The hold ends a while after the user leaves, so a day in the inbox does not
// pay for each log line of a run. The next visit starts the queries again.

import { useEffect, useState } from 'react';
import { useClientStore } from '@/lib/client-state';
import { useAllWork, useThreadActivity } from './use-thread-rows';

export const THREAD_LIST_HOLD_MS = 10 * 60_000;

/** The surfaces that show thread rows. */
export function showsThreadRows(view: string): boolean {
  return view === 'albatrosses' || view === 'areas';
}

export function ThreadListKeeper() {
  const onList = useClientStore((state) => showsThreadRows(state.primaryView));
  // On from the first load: the first switch paints at once as well.
  const [held, setHeld] = useState(true);
  useEffect(() => {
    if (onList) {
      setHeld(true);
      return;
    }
    const timer = globalThis.setTimeout(() => setHeld(false), THREAD_LIST_HOLD_MS);
    return () => globalThis.clearTimeout(timer);
  }, [onList]);
  useAllWork(held);
  useThreadActivity(held);
  return null;
}
