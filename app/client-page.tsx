'use client';

import { AppShell } from '@/components/shell/AppShell';

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
