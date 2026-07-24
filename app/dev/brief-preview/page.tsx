'use client';

import { notFound } from 'next/navigation';
import { BriefCanvas } from '@/components/report/brief-canvas/BriefCanvas';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { richBriefDocumentFixture } from '@/lib/shared/brief-document-fixtures';

/* Dev-only harness: the rich fixture through the real BriefCanvas, full
 * viewport, so layout (column thresholds), theming, and depth can be verified
 * deterministically without a signed-in account that owns a document-v2
 * brief. Not linked from anywhere; 404s outside development. */
export default function BriefPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BriefPreviewInner />;
}

function BriefPreviewInner() {
  useApplyThemeExtras();
  return (
    <QueryProvider clerkEnabled={false}>
      <div className="h-dvh">
        <BriefCanvas value={richBriefDocumentFixture} masthead />
      </div>
    </QueryProvider>
  );
}
