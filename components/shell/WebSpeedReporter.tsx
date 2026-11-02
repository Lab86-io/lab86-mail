'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { useEffect } from 'react';
import { installWebSpeedListeners, sharedWebSpeedReporter } from '@/lib/ops/surface-timing';

// A stable function: a new one each render would report each metric again.
const reportVital = (metric: { name: string; value: number }) => {
  sharedWebSpeedReporter()?.addVital(metric.name, metric.value);
};

/** The speed data of the signed-in shell (docs/ops-signals.md). It draws nothing. */
export function WebSpeedReporter() {
  useReportWebVitals(reportVital);
  useEffect(() => {
    const reporter = sharedWebSpeedReporter();
    return reporter ? installWebSpeedListeners(reporter, window, document) : undefined;
  }, []);
  return null;
}
