'use client';

// The loader of a saved file's bytes for the thread: a 403 that asks for the
// identity check runs Clerk's reverification, then the fetch runs again
// (docs/albatross-goal-runs.md G5, "Secret values in a PDF"). The thread's
// data layer owns this hook, inside the Clerk provider; the dev harness has
// none and the PDF pane falls back to a plain fetch.

import { useReverification } from '@clerk/nextjs';
import { useCallback } from 'react';
import { GOAL_RUN_COPY } from '@/lib/albatross/goal-run-view';
import { fetchSavedFileOrCheck, SavedFileError } from './PdfPane';

export function useSavedFileLoader(): (url: string) => Promise<ArrayBuffer> {
  const withCheck = useReverification(fetchSavedFileOrCheck);
  return useCallback(
    async (url: string) => {
      const result = await withCheck(url);
      if (result && 'bytes' in result) return result.bytes;
      // The user closed the check: the file stays sealed.
      throw new SavedFileError(GOAL_RUN_COPY.pdfNotDownloaded, 403, 'verify_identity');
    },
    [withCheck],
  );
}
