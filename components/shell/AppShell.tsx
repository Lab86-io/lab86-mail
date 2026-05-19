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
      <div
        className="grid h-dvh w-screen overflow-hidden"
        style={{
          gridTemplateColumns: '228px minmax(360px, 420px) 1fr',
          gridTemplateRows: '52px 1fr',
        }}
      >
        <div className="col-start-1 row-start-1 row-end-3 overflow-hidden border-r border-[var(--color-border)]">
          <Rail />
        </div>
        <header className="col-start-2 col-end-4 row-start-1 row-end-2 flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4">
          <AIBar />
          <div className="hidden text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] md:flex md:items-center md:gap-1.5">
            <kbd>⌘K</kbd> agent <span>·</span> <kbd>⌘P</kbd> palette <span>·</span> <kbd>?</kbd> shortcuts
          </div>
        </header>
        <div className="col-start-2 col-end-3 row-start-2 row-end-3 overflow-hidden border-r border-[var(--color-border)]">
          <Inbox />
        </div>
        <div className="col-start-3 col-end-4 row-start-2 row-end-3 overflow-hidden">
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
