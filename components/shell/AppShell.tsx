'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ComposeDialog } from '@/components/compose/ComposeDialog';
import { Inbox } from '@/components/inbox/Inbox';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { ThreadView } from '@/components/thread/ThreadView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import { AIBarSidebar, AIBarTrigger } from './AIBar';
import { Rail } from './Rail';
import { ShortcutsBinding } from './ShortcutsBinding';
import { ShortcutsSheet } from './ShortcutsSheet';

export function AppShell() {
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const railOpen = useClientStore((s) => s.railOpen);
  const setRailOpen = useClientStore((s) => s.setRailOpen);
  const RailIcon = railOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <TooltipProvider delayDuration={350}>
      <div
        className="relative grid h-dvh w-screen overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
        style={{
          gridTemplateColumns: [
            railOpen ? '228px' : '0px',
            aiBarOpen ? 'minmax(320px, 380px)' : 'minmax(360px, 420px)',
            '1fr',
            aiBarOpen ? '420px' : '0px',
          ].join(' '),
          gridTemplateRows: '52px 1fr',
        }}
      >
        <div
          className={cn(
            'col-start-1 row-start-1 row-end-3 overflow-hidden bg-[var(--color-bg-subtle)] transition-[border-color] duration-200',
            railOpen ? 'border-r border-[var(--color-border)]' : 'border-r border-transparent',
          )}
        >
          <Rail />
        </div>
        <button
          type="button"
          onClick={() => setRailOpen(!railOpen)}
          className={cn(
            'absolute top-3 z-30 grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] transition-[left,background-color,color,border-color] duration-200 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]',
            railOpen ? 'left-[214px]' : 'left-3',
          )}
          title={railOpen ? 'Collapse navigation rail' : 'Expand navigation rail'}
        >
          <RailIcon className="h-3.5 w-3.5" />
        </button>
        <AIBarTrigger />
        <header className="col-start-2 col-end-5 row-start-1 row-end-2 flex items-center justify-end gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4">
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
        <div className="col-start-4 col-end-5 row-start-2 row-end-3 overflow-hidden border-l border-[var(--color-border)]">
          <AIBarSidebar />
        </div>
      </div>

      <ComposeDialog />
      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
    </TooltipProvider>
  );
}
