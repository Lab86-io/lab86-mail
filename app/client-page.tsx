'use client';

import dynamic from 'next/dynamic';

// The shell is client-only (no SSR), so the bundle download used to render a
// blank page. Paint an immediate app-shaped skeleton instead.
function BootSkeleton() {
  return (
    <div className="flex h-dvh w-full bg-[var(--color-bg)]">
      <div className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3 md:block">
        <div className="h-7 w-28 rounded-md shimmer" />
        <div className="mt-5 space-y-2">
          {Array.from({ length: 7 }, (_, i) => `rail-${i}`).map((key) => (
            <div key={key} className="h-6 rounded-md shimmer" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-[var(--color-border)] px-3 py-2.5">
          <div className="h-8 w-full max-w-xl rounded-md shimmer" />
        </div>
        <div className="flex-1 space-y-2 p-3">
          {Array.from({ length: 9 }, (_, i) => `row-${i}`).map((key) => (
            <div key={key} className="h-12 rounded-lg shimmer" />
          ))}
        </div>
      </div>
    </div>
  );
}

const AppShell = dynamic(() => import('@/components/shell/AppShell').then((mod) => mod.AppShell), {
  ssr: false,
  loading: () => <BootSkeleton />,
});

export function ClientPage() {
  return <AppShell />;
}
