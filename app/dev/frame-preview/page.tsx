'use client';

import { notFound } from 'next/navigation';
import { FrameGallery } from '@/components/report/brief-canvas/FrameGallery';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';

/* Dev-only gallery: every picture frame on today's artwork, in the same
 * geometry the brief uses, so a frame can be judged and removed on sight.
 * Not linked from anywhere; 404s outside development. */
export default function FramePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <FramePreviewInner />;
}

function FramePreviewInner() {
  useApplyThemeExtras();
  return (
    <QueryProvider clerkEnabled={false}>
      <FrameGallery />
    </QueryProvider>
  );
}
