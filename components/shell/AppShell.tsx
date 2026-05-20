'use client';

import { useQueryClient } from '@tanstack/react-query';
import { PanelLeftOpen, RefreshCw } from 'lucide-react';
import type { TouchEvent } from 'react';
import { useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
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

// Each visible-pane permutation gets its own persisted layout so the inbox
// doesn't snap to weird sizes when the reader or AI sidebar mounts/unmounts.
export function AppShell() {
  const queryClient = useQueryClient();
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const railOpen = useClientStore((s) => s.railOpen);
  const setRailOpen = useClientStore((s) => s.setRailOpen);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const composeMode = useClientStore((s) => s.compose.mode);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const pullEnabled = useRef(false);

  const readerVisible = !!(selectedThreadId || composeMode);
  const permutation = `${railOpen ? 'r' : ''}i${readerVisible ? 't' : ''}${aiBarOpen ? 'a' : ''}`;
  const panelIds = [
    ...(railOpen ? ['rail'] : []),
    'inbox',
    ...(readerVisible ? ['reader'] : []),
    ...(aiBarOpen ? ['ai'] : []),
  ];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `mail-os-shell-v2:${permutation}`,
    panelIds,
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });

  const refreshPage = async () => {
    setPullRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['thread'] }),
      ]);
    } finally {
      window.setTimeout(() => setPullRefreshing(false), 450);
    }
  };

  const beginPullRefresh = (e: TouchEvent<HTMLDivElement>) => {
    const scrollParent = closestScrollable(e.target, e.currentTarget);
    pullEnabled.current = !scrollParent || scrollParent.scrollTop <= 0;
    pullStartY.current = e.touches[0]?.clientY ?? null;
  };

  const trackPullRefresh = (e: TouchEvent<HTMLDivElement>) => {
    if (!pullEnabled.current || pullStartY.current == null) return;
    const delta = (e.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current;
    setPullDistance(delta > 0 ? Math.min(delta, 120) : 0);
  };

  const finishPullRefresh = () => {
    const shouldRefresh = pullDistance >= 72;
    pullStartY.current = null;
    pullEnabled.current = false;
    setPullDistance(0);
    if (shouldRefresh) void refreshPage();
  };

  return (
    <TooltipProvider delayDuration={350}>
      <div
        className="relative h-dvh w-screen overflow-hidden overscroll-contain bg-[var(--color-bg)]"
        onTouchStart={beginPullRefresh}
        onTouchMove={trackPullRefresh}
        onTouchEnd={finishPullRefresh}
        onTouchCancel={finishPullRefresh}
      >
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] transition-opacity"
          style={{
            opacity: pullDistance > 8 || pullRefreshing ? 1 : 0,
            transform: `translate(-50%, ${Math.max(0, pullDistance / 3)}px)`,
          }}
        >
          <RefreshCw
            className={cn(
              'h-3 w-3',
              (pullRefreshing || pullDistance >= 72) && 'animate-spin text-[var(--color-accent)]',
            )}
          />
          {pullDistance >= 72 ? 'Release to refresh' : pullRefreshing ? 'Refreshing' : 'Pull to refresh'}
        </div>
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

function closestScrollable(target: EventTarget, boundary: HTMLElement) {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== boundary) {
    const style = window.getComputedStyle(node);
    const canScrollY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (canScrollY) return node;
    node = node.parentElement;
  }
  return null;
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
