'use client';

// The signed-in user's personal details, for form prefill in every chat and
// for the settings list. One react-query key, so a save in one place updates
// the other (docs/albatross-thread.md, "Personal details").

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { PersonalDetailsResponse } from '@/lib/albatross/thread-contract';

export const PERSONAL_DETAILS_QUERY_KEY = ['personal-details'] as const;

export async function fetchPersonalDetails(): Promise<PersonalDetailsResponse> {
  const response = await fetch('/api/personal-details', { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not load your details.');
  return data as PersonalDetailsResponse;
}

export function usePersonalDetails(enabled = true) {
  return useQuery({
    queryKey: PERSONAL_DETAILS_QUERY_KEY,
    queryFn: fetchPersonalDetails,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Refresh the details after a save, a delete, or an undo anywhere. */
export function useInvalidatePersonalDetails() {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: PERSONAL_DETAILS_QUERY_KEY }), [qc]);
}
