'use client';

import { type CSSProperties, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { Inbox } from '@/components/inbox/Inbox';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { DailyReport } from '@/components/report/DailyReport';
import { ThreadView } from '@/components/thread/ThreadView';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useClientStore } from '@/lib/client-state';
import { cn } from '@/lib/utils';
import { AIBarSidebar, AIBarTrigger } from './AIBar';
import { Rail } from './Rail';
import { ShortcutsBinding } from './ShortcutsBinding';
import { ShortcutsSheet } from './ShortcutsSheet';

// Each visible-pane permutation gets its own persisted layout so the inbox
// doesn't snap to weird sizes when the reader or AI sidebar mounts/unmounts.
// The navigation rail is no longer part of this group — it's a shadcn Sidebar
// that collapses to an icon strip rather than unmounting.
export function AppShell() {
  const aiBarOpen = useClientStore((s) => s.aiBarOpen);
  const railOpen = useClientStore((s) => s.railOpen);
  const railWidth = useClientStore((s) => s.railWidth);
  const setRailOpen = useClientStore((s) => s.setRailOpen);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const primaryView = useClientStore((s) => s.primaryView);
  const composeMode = useClientStore((s) => s.compose.mode);
  const isMobile = useIsMobile();

  const readerVisible = !!(selectedThreadId || composeMode);
  const permutation = `i${readerVisible ? 't' : ''}${aiBarOpen ? 'a' : ''}`;
  const panelIds = ['inbox', ...(readerVisible ? ['reader'] : []), ...(aiBarOpen ? ['ai'] : [])];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `lab86-mail-shell-v2:${permutation}`,
    panelIds,
    storage: typeof window !== 'undefined' && !isMobile ? window.localStorage : undefined,
  });

  // Mobile: full-screen single-panel view with slide transitions
  if (isMobile) {
    return (
      <TooltipProvider delayDuration={0}>
        <SidebarProvider
          open={railOpen}
          onOpenChange={setRailOpen}
          style={{ '--sidebar-width': `${railWidth}px` } as CSSProperties}
          className="h-dvh overflow-hidden bg-[var(--color-bg)]"
        >
          <Rail />
          <main className="app-paper relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
            {/* Mobile view: only show one panel at a time */}
            <div className="relative h-full w-full overflow-hidden">
              {/* Inbox/Daily Report - always rendered but may be hidden */}
              <div
                className={cn(
                  'absolute inset-0 h-full w-full transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
                  readerVisible ? '-translate-x-full' : 'translate-x-0'
                )}
              >
                {primaryView === 'daily_report' ? <DailyReport /> : <Inbox />}
              </div>

              {/* Thread View - slides in when selected */}
              {readerVisible && (
                <div className="absolute inset-0 h-full w-full translate-x-full animate-in slide-in-from-right-full duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]">
                  <ThreadView />
                </div>
              )}

              {/* AI Sidebar - slides in when open */}
              {aiBarOpen && (
                <div className="absolute inset-0 z-20 h-full w-full translate-x-full animate-in slide-in-from-right-full duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]">
                  <div className="h-full w-full overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg)]">
                    <AIBarSidebar />
                  </div>
                </div>
              )}
            </div>
            <AIBarTrigger />
          </main>
        </SidebarProvider>

        <CommandPalette />
        <ShortcutsSheet />
        <ShortcutsBinding />
      </TooltipProvider>
    );
  }

  // Desktop: resizable panels
  return (
    <TooltipProvider delayDuration={350}>
      <SidebarProvider
        open={railOpen}
        onOpenChange={setRailOpen}
        style={{ '--sidebar-width': `${railWidth}px` } as CSSProperties}
        className="h-dvh overflow-hidden bg-[var(--color-bg)]"
      >
        <Rail />
        {/* Drag handle to resize the expanded rail; hidden when collapsed to icons. */}
        {railOpen ? <RailResizeHandle /> : null}
        <main className="app-paper relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
          {/* SidebarProvider nests a 0ms TooltipProvider; restore the app's
              default delay for the reader/inbox content it wraps. */}
          <TooltipProvider delayDuration={350}>
            <Group
              key={permutation}
              orientation="horizontal"
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
              className="h-full w-full"
            >
              <Panel id="inbox" defaultSize="40%" minSize="280px">
                {primaryView === 'daily_report' ? <DailyReport /> : <Inbox />}
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
          </TooltipProvider>
          <AIBarTrigger />
        </main>
      </SidebarProvider>

      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
    </TooltipProvider>
  );
}

const RAIL_MIN = 200;
const RAIL_MAX = 420;
const RAIL_DEFAULT = 240;

// Drag handle living between the sidebar and the main content. It nudges the
// `--sidebar-width` CSS variable directly during the drag (so the resize is
// smooth and doesn't re-render the whole shell), then commits the final width
// to the store on release so it persists.
function RailResizeHandle() {
  const setRailWidth = useClientStore((s) => s.setRailWidth);
  const ref = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const wrapper = ref.current?.closest('[data-slot="sidebar-wrapper"]') as HTMLElement | null;
    if (!wrapper) return;
    const startX = e.clientX;
    const startW = useClientStore.getState().railWidth;
    let latest = startW;
    setDragging(true);
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      latest = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + (ev.clientX - startX)));
      wrapper.style.setProperty('--sidebar-width', `${latest}px`);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      setDragging(false);
      setRailWidth(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      aria-label="Resize navigation rail"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
      title="Drag to resize · double-click to reset"
      className="group relative z-20 hidden w-[6px] shrink-0 cursor-col-resize bg-[var(--color-transparent)] p-0 outline-none md:block"
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-colors',
          dragging
            ? 'w-[2px] bg-[var(--color-accent)]'
            : 'w-px bg-[var(--color-transparent)] group-hover:bg-[var(--color-accent)]',
        )}
        aria-hidden
      />
    </button>
  );
}

function ResizeSeparator() {
  // 6px wide hit target with a 1px visible rule down the middle; brightens on
  // hover/drag so it's clearly grabbable.
  return (
    <Separator className="group relative w-[6px] shrink-0 cursor-col-resize bg-[var(--color-transparent)] outline-none">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
        aria-hidden
      />
    </Separator>
  );
}
