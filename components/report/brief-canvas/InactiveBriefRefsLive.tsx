'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type RequestForQueries, useConvexAuth, useQueries } from 'convex/react';
import { useEffect, useMemo } from 'react';
import { api } from '@/convex/_generated/api';

const REF_BATCH = 100;

/**
 * Subscribes to the refs of this brief that are no longer active. Convex pushes
 * a new answer when a read row changes, so nothing polls. The canvas reads the
 * answer from the query cache under `queryKey`. Mount it only under a Convex auth
 * provider. A thrown query must not take the brief down: an error leaves the
 * last answer in place.
 */
export function InactiveBriefRefsLive({
  refs,
  queryKey,
}: {
  refs: Array<{ kind: string; id: string }>;
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useConvexAuth();
  const queries = useMemo(() => {
    const entries: RequestForQueries = {};
    if (!isAuthenticated) return entries;
    for (let index = 0; index < refs.length; index += REF_BATCH)
      entries[String(index)] = {
        query: api.albatrossWorkV2.inactiveBriefRefs,
        args: {
          refs: refs.slice(index, index + REF_BATCH).map(({ kind, id }) => ({ kind, id })),
        },
      };
    return entries;
  }, [isAuthenticated, refs]);
  const results = useQueries(queries);
  const answers = Object.values(results);
  const settled = answers.length > 0 && answers.every(Array.isArray);
  const merged = settled ? JSON.stringify(answers.flat()) : null;
  useEffect(() => {
    if (merged) queryClient.setQueryData(queryKey, JSON.parse(merged));
  }, [merged, queryClient, queryKey]);
  return null;
}
