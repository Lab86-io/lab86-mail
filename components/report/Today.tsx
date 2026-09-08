'use client';

import { DailyReport } from '@/components/report/DailyReport';

/**
 * Today is the full Daily Brief. DailyReport already owns the complete
 * masthead, edition history, write/refresh actions, loading/error states, and
 * legacy-artifact rendering, so this route does not put a dashboard in front
 * of the document or create a second version of those flows.
 */
export function Today() {
  return <DailyReport />;
}
