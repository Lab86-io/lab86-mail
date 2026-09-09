'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { NarrativeEntry } from '@/lib/narrative/core';
import { TodayWorkspace } from './TodayWorkspace';

/** Poll only for an active writer; focus and local corrections also invalidate reads. */
export function narrativeBriefPollInterval(data?: { enabled?: boolean; running?: boolean }) {
  return data?.enabled && data.running ? 8000 : false;
}

/** Read through the memory permission boundary, never a stale copy embedded
 * in an immutable DailyReport. Corrections/deletion therefore reach Today. */
export function NarrativeBrief({ at, fallback }: { at: number; fallback: ReactNode }) {
  const memory = useQuery({
    queryKey: ['narrative', 'brief', at],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/narrative?op=brief&at=${at}`, { signal });
      if (!response.ok) throw new Error('Narrative unavailable');
      return response.json() as Promise<{
        enabled?: boolean;
        entry?: NarrativeEntry;
        lastError?: string;
        running?: boolean;
      }>;
    },
    staleTime: 0,
    refetchInterval: (query) => narrativeBriefPollInterval(query.state.data),
    retry: false,
  });
  const entry = memory.data?.entry;
  if (!entry)
    return (
      <>
        {fallback}
        {memory.data?.enabled ? (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            {memory.data.running
              ? 'Your narrative is being prepared.'
              : 'No current narrative account is ready.'}{' '}
            <Link href="/narrative" className="underline">
              Review history
            </Link>
          </p>
        ) : null}
      </>
    );
  return (
    <div data-narrative-brief className="space-y-4">
      <p className="font-serif text-[19px] leading-[1.7] tracking-[-0.015em] whitespace-pre-line">
        {entry.text}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
        <Link
          href={`/narrative?id=${encodeURIComponent(entry._id)}`}
          className="underline underline-offset-4"
        >
          Read the {entry.sourceIds.length} supporting observations
        </Link>
        <Link href="/settings?tab=narrative">Sources & privacy</Link>
      </div>
      {!entry.model ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Source-backed account.{' '}
          {memory.data?.lastError
            ? 'The narrative writer is temporarily unavailable.'
            : 'The narrative writer has not finished this edition.'}
        </p>
      ) : null}
      <TodayWorkspace key={`${entry._id}:${entry.updatedAt}`} at={at} revision={entry.updatedAt} />
    </div>
  );
}
