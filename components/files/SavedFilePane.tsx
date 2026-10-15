'use client';

// A saved file opened in Files from `?view=files&file=<id>` (the link the
// server writes for a filled PDF, docs/albatross-goal-runs.md G5). A PDF
// shows in the PDF pane; another type offers Download. The identity check
// for a sealed file runs through the thread's loader hook.

import { ArrowLeft } from 'lucide-react';
import { PdfPane } from '@/components/albatross/thread/PdfPane';
import { useSavedFileLoader } from '@/components/albatross/thread/use-saved-file';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { savedFileDownloadUrl, savedFilePreviewUrl } from '@/lib/albatross/goal-run-view';

export const SAVED_FILE_COPY = {
  back: 'Back to Files',
  download: 'Download',
  noPreview: 'This file has no preview here. Download it to open it.',
} as const;

export function SavedFilePane({
  fileId,
  title,
  contentType,
  onClose,
}: {
  fileId: string;
  title: string;
  /** From the library row when the file is in the loaded pages; a PDF when unknown. */
  contentType?: string | null;
  onClose: () => void;
}) {
  const loadFile = useSavedFileLoader();
  const pdf = !contentType || contentType === 'application/pdf';
  return (
    <section aria-label={title} className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-bg)]">
      <TooltipProvider>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={SAVED_FILE_COPY.back} onClick={onClose}>
                <ArrowLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{SAVED_FILE_COPY.back}</TooltipContent>
          </Tooltip>
          <span className="min-w-0 truncate text-[13px] font-medium">{title}</span>
        </header>
      </TooltipProvider>
      <div className="min-h-0 flex-1">
        {pdf ? (
          <PdfPane
            url={savedFilePreviewUrl(fileId)}
            downloadUrl={savedFileDownloadUrl(fileId)}
            title={title}
            loadFile={loadFile}
          />
        ) : (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-[13px] text-[var(--color-text-muted)]">{SAVED_FILE_COPY.noPreview}</p>
            <Button asChild size="sm" variant="outline" className="w-fit">
              <a href={savedFileDownloadUrl(fileId)} download>
                {SAVED_FILE_COPY.download}
              </a>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
