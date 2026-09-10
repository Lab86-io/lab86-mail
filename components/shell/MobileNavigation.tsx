'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';

/** In-flow navigation keeps every primary surface clear of floating menu controls. */
export function MobileNavigation({ onSearch }: { onSearch: () => void }) {
  return (
    <nav
      aria-label="App navigation"
      className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
    >
      <SidebarTrigger title="Show sidebar" className="size-11 shrink-0 text-[var(--color-text-muted)]" />
      <Button
        type="button"
        variant="outline"
        onClick={onSearch}
        className="h-11 min-w-0 flex-1 justify-start gap-2 px-3 text-sm"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        Search Albatross
      </Button>
    </nav>
  );
}
