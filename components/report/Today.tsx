'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Newspaper } from 'lucide-react';
import { useState } from 'react';
import { DailyReport } from '@/components/report/DailyReport';
import { TodaySurface } from '@/components/report/TodaySurface';
import { Button } from '@/components/ui/button';
import { briefFreshness, briefIsStale } from '@/lib/albatross/today';
import { callTool } from '@/lib/api-client';

/**
 * Today has two faces. The day itself is structured, deterministic and always
 * correct — it is rendered from live work, approvals and calendar rows. The
 * generated brief is the reading experience, and it survives, but it stopped
 * being the first thing the page is about.
 *
 * The brief used to be the whole surface, which meant a stale generation could
 * present a three-week-old day as today's, under a masthead reading "Live".
 */
export function Today() {
  const [mode, setMode] = useState<'day' | 'brief'>('day');

  // Only the freshness stamp, so the day view can say honestly whether a brief
  // is worth reading before the user commits to opening it.
  const latest = useQuery({
    queryKey: ['daily-report', 'latest-stamp'],
    queryFn: async () => callTool<{ report?: { createdAt?: number } | null }>('get_latest_daily_report'),
    staleTime: 60_000,
    retry: false,
  });
  const generatedAt = latest.data?.report?.createdAt ?? null;
  const nowMs = Date.now();
  const freshness = briefFreshness(generatedAt, nowMs);
  const stale = briefIsStale(generatedAt, nowMs);

  if (mode === 'brief') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <Button type="button" size="xs" variant="ghost" onClick={() => setMode('day')}>
            <ArrowLeft className="size-3.5" /> Today
          </Button>
          <span className="text-[11px] text-[var(--color-text-faint)]">/</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">The brief</span>
          {freshness ? (
            <span
              className={
                stale
                  ? 'text-[11.5px] font-medium text-[var(--color-warning)]'
                  : 'text-[11.5px] text-[var(--color-text-faint)]'
              }
            >
              {stale ? `${freshness} — this describes an older day` : freshness}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <DailyReport />
        </div>
      </div>
    );
  }

  return (
    <TodaySurface
      brief={
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-serif text-[15px] font-semibold">The brief</h2>
              <p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
                {generatedAt
                  ? stale
                    ? `${freshness} — it describes an older day.`
                    : `${freshness}. The longer read on your mail and calendar.`
                  : 'Not written yet today.'}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode('brief')}>
              <Newspaper className="size-3.5" /> Read it
            </Button>
          </div>
        </div>
      }
    />
  );
}
