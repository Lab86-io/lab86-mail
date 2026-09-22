'use client';

import { create } from 'zustand';

/* A one-shot request to open one edition of the Daily Brief. A `brief_ready`
 * notification and the `/brief?id=<reportId>` deep link set it. DailyReport
 * consumes it once and clears it. Transient, never persisted. */

interface BriefEditionRequestState {
  reportId: string | null;
  request: (reportId: string | null) => void;
  clear: () => void;
}

export const useBriefEditionRequest = create<BriefEditionRequestState>((set) => ({
  reportId: null,
  request: (reportId) => set({ reportId: reportId?.trim() ? reportId.trim() : null }),
  clear: () => set({ reportId: null }),
}));

export function requestBriefEdition(reportId: string | null) {
  useBriefEditionRequest.getState().request(reportId);
}

/** `?brief=<id>` on the shell route names one edition of the Daily Brief. */
export function briefEditionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('brief');
  return value?.trim() ? value.trim() : null;
}
