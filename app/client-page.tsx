'use client';

import dynamic from 'next/dynamic';

const AppShell = dynamic(() => import('@/components/shell/AppShell').then((mod) => mod.AppShell), {
  ssr: false,
  loading: () => <main className="app-paper h-dvh bg-[var(--color-bg)]" />,
});

export function ClientPage({ clerkEnabled }: { clerkEnabled: boolean }) {
  // Today is where a new session lands. A saved view still wins over it.
  return <AppShell clerkEnabled={clerkEnabled} initialView="today" />;
}
