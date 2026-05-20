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

const PULL_REFRESH_THRESHOLD = 72;
const PULL_REFRESH_MAX = 128;

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
  const [pulling, setPulling] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const pullStartX = useRef<number | null>(null);
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
    const touch = e.touches[0];
    const scrollParent = closestScrollable(e.target, e.currentTarget);
    pullEnabled.current = !scrollParent || scrollParent.scrollTop <= 0;
    pullStartY.current = touch?.clientY ?? null;
    pullStartX.current = touch?.clientX ?? null;
  };

  const trackPullRefresh = (e: TouchEvent<HTMLDivElement>) => {
    if (!pullEnabled.current || pullStartY.current == null) return;
    const touch = e.touches[0];
    const deltaY = (touch?.clientY ?? pullStartY.current) - pullStartY.current;
    const deltaX = Math.abs((touch?.clientX ?? pullStartX.current ?? 0) - (pullStartX.current ?? 0));
    if (deltaY <= 0 || deltaX > deltaY * 1.2) {
      setPulling(false);
      setPullDistance(0);
      return;
    }
    setPulling(true);
    setPullDistance(rubberBand(deltaY));
  };

  const finishPullRefresh = () => {
    const shouldRefresh = pullDistance >= PULL_REFRESH_THRESHOLD;
    pullStartY.current = null;
    pullStartX.current = null;
    pullEnabled.current = false;
    setPulling(false);
    setPullDistance(0);
    if (shouldRefresh) void refreshPage();
  };

  const pullProgress = Math.min(pullDistance / PULL_REFRESH_THRESHOLD, 1);
  const indicatorOffset = pullRefreshing ? 32 : Math.max(0, pullDistance * 0.42);
  const contentOffset = pullRefreshing ? 14 : Math.max(0, pullDistance * 0.24);
  const stretchOpacity = pulling || pullRefreshing ? Math.max(0.12, pullProgress * 0.32) : 0;

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
          className="pointer-events-none absolute inset-x-0 top-0 z-40 h-28 origin-top bg-gradient-to-b from-[var(--color-accent-soft)] to-transparent transition-opacity duration-200"
          style={{
            opacity: stretchOpacity,
            transform: `scaleY(${0.35 + pullProgress * 0.9})`,
          }}
        />
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] shadow-[var(--shadow-pop)] transition-[opacity,transform] duration-200"
          style={{
            opacity: pullDistance > 8 || pullRefreshing ? 1 : 0,
            transform: `translate(-50%, ${indicatorOffset}px) scale(${0.94 + pullProgress * 0.06})`,
          }}
        >
          <RefreshCw
            className={cn(
              'h-3 w-3 transition-colors',
              (pullRefreshing || pullDistance >= PULL_REFRESH_THRESHOLD) && 'text-[var(--color-accent)]',
              pullRefreshing && 'animate-spin',
            )}
            style={pullRefreshing ? undefined : { transform: `rotate(${pullProgress * 210}deg)` }}
          />
          {pullDistance >= PULL_REFRESH_THRESHOLD ? 'Release to refresh' : pullRefreshing ? 'Refreshing' : 'Pull to refresh'}
        </div>
        <div
          className={cn('h-full w-full', !pulling && 'transition-transform duration-300 ease-out')}
          style={{ transform: `translateY(${contentOffset}px)` }}
        >
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
        </div>

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

function rubberBand(distance: number) {
  const clamped = Math.max(0, distance);
  return Math.min(PULL_REFRESH_MAX, PULL_REFRESH_MAX * (1 - 1 / (clamped * 0.018 + 1)));
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
