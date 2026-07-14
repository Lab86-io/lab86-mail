'use client';

import dynamic from 'next/dynamic';

const AppShell = dynamic(() => import('@/components/shell/AppShell').then((mod) => mod.AppShell), {
  ssr: false,
  loading: () => <main className="app-paper h-dvh bg-[var(--color-bg)]" />,
});

export function ClientPage({
  albatrossEnabled,
  clerkEnabled,
}: {
  albatrossEnabled: boolean;
  clerkEnabled: boolean;
}) {
  return (
    <AppShell
      albatrossEnabled={albatrossEnabled}
      clerkEnabled={clerkEnabled}
      initialView={albatrossEnabled ? 'areas' : undefined}
    />
  );
}
