'use client';

import { Rail } from './Rail';
import { AIBar } from './AIBar';
import { Inbox } from '@/components/inbox/Inbox';
import { ThreadView } from '@/components/thread/ThreadView';
import { ComposeDialog } from '@/components/compose/ComposeDialog';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { ShortcutsBinding } from './ShortcutsBinding';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppShell() {
  return (
    <TooltipProvider delayDuration={350}>
      <div className="grid h-dvh w-screen grid-cols-[228px_minmax(360px,420px)_1fr] grid-rows-[52px_1fr] overflow-hidden">
        <Rail />
        <header className="col-span-2 row-start-1 row-end-2 flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]/60 px-4 backdrop-blur">
          <AIBar />
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
            <kbd>⌘K</kbd> agent · <kbd>⌘P</kbd> palette · <kbd>?</kbd> shortcuts
          </div>
        </header>
        <div className="row-start-2 row-end-3 col-start-2 col-end-3 border-r border-[var(--color-border)] overflow-hidden">
          <Inbox />
        </div>
        <div className="row-start-2 row-end-3 col-start-3 col-end-4 overflow-hidden">
          <ThreadView />
        </div>
      </div>

      <ComposeDialog />
      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
    </TooltipProvider>
  );
}
