'use client';

import { DailyReport } from '@/components/report/DailyReport';
import { TodaySurface } from '@/components/report/TodaySurface';

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
 */
export function Today() {
  return <TodaySurface brief={<DailyReport embedded />} />;
}
