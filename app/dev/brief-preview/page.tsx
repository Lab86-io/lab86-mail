'use client';

import { notFound, useSearchParams } from 'next/navigation';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { richBriefDocumentFixture } from '@/lib/shared/brief-document-fixtures';

/* Dev-only harness: the rich fixture through the real BriefCanvas, full
 * viewport, so layout (column thresholds), theming, and depth can be verified
 * deterministically without a signed-in account that owns a document-v2
 * brief. Add ?embedded=1 for the shape Today renders — no masthead, flowing in
 * a parent scroll. Not linked from anywhere; 404s outside development. */
export default function BriefPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BriefPreviewInner />;
}

function BriefPreviewInner() {
  useApplyThemeExtras();
  const embedded = useSearchParams().get('embedded') === '1';
  return (
    <QueryProvider clerkEnabled={false}>
      {embedded ? (
        <div className="mx-auto max-w-5xl px-5 py-10">
          <p className="mb-8 text-[13px] text-[var(--color-text-muted)]">
            Stand-in for the live layer of Today. The brief follows in the same scroll.
          </p>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
            <span aria-hidden className="h-px w-5 shrink-0 bg-[var(--color-border-strong)]" />
            <h2 className="font-serif text-[15px] font-semibold">The brief</h2>
            <p className="text-[12px] text-[var(--color-text-faint)]">
              Written just now, from your mail and calendar.
            </p>
            <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
          <BriefCanvas value={richBriefDocumentFixture} embedded />
        </div>
      ) : (
        <div className="h-dvh">
          <BriefCanvas value={richBriefDocumentFixture} masthead />
        </div>
      )}
    </QueryProvider>
  );
}
