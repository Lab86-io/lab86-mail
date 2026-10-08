'use client';

// Live thread rows on web (docs/albatross-threads.md, lead decision 9): the
// Work list plus `albatrossThreads.activity`, merged by `buildThreadRows`.
// Convex shares one subscription between the rail and the list, so both read
// the same rows at the same instant.

import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useCallback, useMemo } from 'react';
import { api } from '@/convex/_generated/api';
import type { ThreadActivity } from '@/lib/albatross/threads';
import { buildThreadRows, type ThreadRow } from '@/lib/albatross/threads';
import type { WorkListItem } from './AlbatrossesSurface';

export function useAllWork(): WorkListItem[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.albatrossWorkV2.allWork, isAuthenticated ? {} : 'skip') as WorkListItem[] | undefined;
}

export function useThreadActivity(): ThreadActivity | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.albatrossThreads.activity, isAuthenticated ? {} : 'skip') as ThreadActivity | undefined;
}

/** The rows for a list of Work. Undefined until both queries answer. */
export function useThreadRows(works: readonly WorkListItem[] | undefined): ThreadRow[] | undefined {
  const activity = useThreadActivity();
  return useMemo(() => (works && activity ? buildThreadRows(works, activity) : undefined), [works, activity]);
}

/** `seen` (T2): on open and while the thread shows; `unread: true` is "Mark as unread". */
export function useMarkSeen() {
  const markSeen = useMutation(api.albatrossThreads.markSeen);
  return useCallback(
    (workId: string, unread = false) =>
      markSeen(unread ? { workId, unread: true } : { workId }).catch(() => undefined),
    [markSeen],
  );
}
