'use client';

import { notFound } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AssistantChat } from '@/components/shell/AIBar';
import { QueryProvider } from '@/components/shell/QueryProvider';
import { useApplyThemeExtras } from '@/components/shell/ThemePanel';
import { createFixtureTransport } from '@/lib/chat/preview-fixture';

export default function ChatPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ChatPreview />;
}

function ChatPreview() {
  useApplyThemeExtras();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const transport = useMemo(() => createFixtureTransport(), []);
  return (
    <QueryProvider clerkEnabled={false}>
      <main
        data-preview-state={ready ? 'ready' : 'loading'}
        className="mx-auto h-dvh max-w-3xl border-x border-[var(--color-border)] bg-[var(--color-bg)]"
      >
        <AssistantChat transport={transport} preview />
      </main>
    </QueryProvider>
  );
}
