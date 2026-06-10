'use client';

import { Settings2 } from 'lucide-react';
import Link from 'next/link';

// Settings moved from a cramped dialog to a full page at /settings — this is
// the rail entry point that survives for compatibility.
export function HostedSettingsButton() {
  return (
    <Link
      href="/settings"
      className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
      title="Settings"
    >
      <Settings2 className="h-3.5 w-3.5" />
    </Link>
  );
}
