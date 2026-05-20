'use client';

import { PanelLeftOpen } from 'lucide-react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { Inbox } from '@/components/inbox/Inbox';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { ThreadView } from '@/components/thread/ThreadView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useClientStore } from '@/lib/client-state';
import { AIBarSidebar, AIBarTrigger } from './AIBar';
import { Rail } from './Rail';
import { ShortcutsBinding } from './ShortcutsBinding';
import { ShortcutsSheet } from './ShortcutsSheet';

// Each visible-pane permutation gets its own persisted layout so the inbox
// doesn't snap to weird sizes when the reader or AI sidebar mounts/unmounts.
export function AppShell() {
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const railOpen = useClientStore((s) => s.railOpen);
  const setRailOpen = useClientStore((s) => s.setRailOpen);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const composeMode = useClientStore((s) => s.compose.mode);

  const readerVisible = !!(selectedThreadId || composeMode);
  const permutation = `${railOpen ? 'r' : ''}i${readerVisible ? 't' : ''}${aiBarOpen ? 'a' : ''}`;
  const panelIds = [
    ...(railOpen ? ['rail'] : []),
    'inbox',
    ...(readerVisible ? ['reader'] : []),
    ...(aiBarOpen ? ['ai'] : []),
  ];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `lab86-mail-shell-v2:${permutation}`,
    panelIds,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });

  return (
    <TooltipProvider delayDuration={350}>
      <div className="relative h-dvh w-screen overflow-hidden bg-[var(--color-bg)]">
        <Group
          key={permutation}
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full w-full"
        >
          {railOpen ? (
            <Panel
              id="rail"
              defaultSize="220px"
              minSize="160px"
              maxSize="360px"
              className="bg-[var(--color-bg-subtle)]"
            >
              <Rail />
            </Panel>
          ) : null}
          {railOpen ? <ResizeSeparator /> : null}

          <Panel id="inbox" defaultSize="40%" minSize="280px">
            <Inbox />
          </Panel>

          {readerVisible ? <ResizeSeparator /> : null}
          {readerVisible ? (
            <Panel id="reader" defaultSize="40%" minSize="360px">
              <ThreadView />
            </Panel>
          ) : null}

          {aiBarOpen ? <ResizeSeparator /> : null}
          {aiBarOpen ? (
            <Panel id="ai" defaultSize="360px" minSize="280px" maxSize="640px">
              <div className="h-full overflow-hidden border-l border-[var(--color-border)]">
                <AIBarSidebar />
              </div>
            </Panel>
          ) : null}
        </Group>

        {!railOpen ? (
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            className="absolute left-3 top-3 z-30 grid h-7 w-7 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
            title="Expand navigation rail"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <AIBarTrigger />
      </div>

      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
    </TooltipProvider>
  );
}

function ResizeSeparator() {
  // 6px wide hit target with a 1px visible rule down the middle; brightens on
  // hover/drag so it's clearly grabbable.
  return (
    <Separator className="group relative w-[6px] shrink-0 cursor-col-resize bg-transparent outline-none">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
        aria-hidden
      />
    </Separator>
  );
}
