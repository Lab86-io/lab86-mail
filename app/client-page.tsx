'use client';

import dynamic from 'next/dynamic';

const AppShell = dynamic(
  () => import('@/components/shell/AppShell').then((mod) => mod.AppShell),
  { ssr: false },
);

export function ClientPage() {
  return <AppShell />;
}
