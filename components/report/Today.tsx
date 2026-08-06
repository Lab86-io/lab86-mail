'use client';

import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { DailyReport } from '@/components/report/DailyReport';
import { TodaySurface } from '@/components/report/TodaySurface';
import { Button } from '@/components/ui/button';

/**
 * Today is one page, not two faces of one.
 *
 * It reads in layers down a single scroll. The live layer — what needs you, the
 * day drawn to scale, what is waiting — is queried on every load, so it can
 * never be stale. The brief's synthesis follows underneath it, stamped with
 * when it was written, and is rewritten in place rather than navigated to.
 *
 * The two used to be separate modes behind a toggle. That made a document
 * written once by a morning cron compete with the live state of the day for the
 * same job, and it let a three-week-old edition present itself as today.
 *
 * The one exception is an edition from before the current format. Those carry a
 * full-bleed cover inside their own HTML, which under Today's plate would be
 * two mastheads and two dates on one page, so they open on their own.
 */
export function Today() {
  const [legacyOpen, setLegacyOpen] = useState(false);

  if (legacyOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <Button type="button" size="xs" variant="ghost" onClick={() => setLegacyOpen(false)}>
            <ArrowLeft className="size-3.5" /> Today
          </Button>
          <span className="text-[11px] text-[var(--color-text-faint)]">/</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">An older edition</span>
        </div>
        <div className="min-h-0 flex-1">
          <DailyReport />
        </div>
      </div>
    );
  }

  return <TodaySurface brief={<DailyReport embedded onOpenLegacy={() => setLegacyOpen(true)} />} />;
}
