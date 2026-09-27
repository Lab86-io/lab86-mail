'use client';

import { TrialDaysLeftNote } from '@/components/billing/TrialNote';
import { DailyReport } from '@/components/report/DailyReport';

/**
 * Today is the full Daily Brief. DailyReport already owns the complete
 * masthead, edition history, write/refresh actions, loading/error states, and
 * legacy-artifact rendering, so this route does not put a dashboard in front
 * of the document or create a second version of those flows. The only thing
 * above it is the quiet trial note in the last days of a trial.
 */
export function Today() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TrialDaysLeftNote className="shrink-0 px-5 pt-3 text-center" />
      <div className="min-h-0 flex-1">
        <DailyReport />
      </div>
    </div>
  );
}
