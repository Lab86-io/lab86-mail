'use client';

import { AnimatePresence, motion } from 'motion/react';
import { Component, type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { AlbatrossSurface } from '@/components/albatross/AlbatrossSurfaces';
import { AreaHome } from '@/components/albatross/AreaHome';
import { IntentCaptureLauncher } from '@/components/albatross/IntentCapture';
import { IntentPip } from '@/components/albatross/IntentPip';
import { PlansSurface } from '@/components/albatross/PlansSurface';
import { CalendarSurface } from '@/components/calendar/CalendarSurface';
import { FirstRunRedirect } from '@/components/hosted/HostedOnboarding';
import { Inbox } from '@/components/inbox/Inbox';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { DailyReport } from '@/components/report/DailyReport';
import { TasksSurface } from '@/components/tasks/TasksSurface';
import { ThreadView } from '@/components/thread/ThreadView';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useClientStore } from '@/lib/client-state';
import {
  hasPersistedPrimaryViewValue,
  isAlbatrossPrimaryView,
  normalizePrimaryView,
  type PrimaryView,
  resolveInitialPrimaryView,
} from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { AIBarTrigger, AssistantChat } from './AIBar';
import { Rail } from './Rail';
import { ShortcutsBinding } from './ShortcutsBinding';
import { ShortcutsSheet } from './ShortcutsSheet';

// Each visible-pane permutation gets its own persisted layout so the inbox
// doesn't snap to weird sizes when the reader or AI sidebar mounts/unmounts.
// The navigation rail is no longer part of this group — it's a shadcn Sidebar
// that collapses to an icon strip rather than unmounting.
export function AppShell({
  albatrossEnabled,
  clerkEnabled,
  initialView,
}: {
  albatrossEnabled: boolean;
  clerkEnabled: boolean;
  initialView?: PrimaryView;
}) {
  const railOpen = useClientStore((s) => s.railOpen);
  const railWidth = useClientStore((s) => s.railWidth);
  const setRailOpen = useClientStore((s) => s.setRailOpen);
  const selectedThreadId = useClientStore((s) => s.selectedThreadId);
  const setSelectedThread = useClientStore((s) => s.setSelectedThread);
  const primaryView = useClientStore((s) => s.primaryView);
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const composeMode = useClientStore((s) => s.compose.mode);
  const isMobile = useIsMobile();
  const [panelResizing, setPanelResizing] = useState(false);
  const mobileHistoryThreadRef = useRef<string | null>(null);
  const initialViewAppliedRef = useRef(false);
  const [hasSavedPrimaryView] = useState(() => hasPersistedPrimaryView());
  const normalizedPrimaryView = normalizePrimaryView(primaryView, albatrossEnabled);
  const initialPrimaryView = resolveInitialPrimaryView(
    primaryView,
    albatrossEnabled,
    initialView,
    hasSavedPrimaryView,
  );
  const [bootView, setBootView] = useState<PrimaryView | null>(() =>
    initialPrimaryView !== normalizedPrimaryView ? initialPrimaryView : null,
  );
  const visiblePrimaryView = normalizePrimaryView(bootView ?? primaryView, albatrossEnabled);
  // A fresh capture lands the user on Plans with that intent selected, so the
  // dump→plan moment is never lost behind navigation.
  const [capturedIntentId, setCapturedIntentId] = useState<string | null>(null);
  // Settings deep-links back into the area setup wizard via /?setup=areas.
  const [openAreaSetup] = useState<boolean>(
    () =>
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('setup') === 'areas',
  );
  const handleIntentCaptured = (intentId: string) => {
    setCapturedIntentId(intentId);
    setPrimaryView('intents');
  };

  useEffect(() => {
    // The deep link must win over whatever view was persisted.
    if (openAreaSetup && albatrossEnabled) setPrimaryView('areas');
  }, [openAreaSetup, albatrossEnabled, setPrimaryView]);

  // The thread reader rides along with the mail-ish surfaces; calendar and
  // tasks keep their pane to themselves. Compose stays available everywhere.
  // Areas count as mail-ish: opening a thread from an area home slides the
  // reader in beside it instead of yanking the user back to the inbox.
  const mailish =
    visiblePrimaryView === 'mail' || visiblePrimaryView === 'daily_report' || visiblePrimaryView === 'areas';
  const readerVisible = !!(composeMode || (selectedThreadId && mailish));
  // The assistant is a floating overlay now (AssistantChat), not a docked
  // panel, so it no longer participates in the resizable layout.
  const permutation = `i${readerVisible ? 't' : ''}`;
  const panelIds = ['inbox', ...(readerVisible ? ['reader'] : [])];
  const layoutStorage = typeof window !== 'undefined' && !isMobile ? window.localStorage : noopLayoutStorage;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `lab86-mail-shell-v2:${permutation}`,
    panelIds,
    storage: layoutStorage,
  });

  useEffect(() => {
    if (!bootView && visiblePrimaryView !== primaryView) setPrimaryView(visiblePrimaryView);
  }, [bootView, primaryView, setPrimaryView, visiblePrimaryView]);

  useEffect(() => {
    if (!initialView || initialViewAppliedRef.current) return;

    const retryMs = [0, 150, 600, 1500];
    const timers = retryMs.map((delay, index) =>
      window.setTimeout(() => {
        const currentState = useClientStore.getState();
        const nextView = resolveInitialPrimaryView(
          currentState.primaryView,
          albatrossEnabled,
          initialView,
          hasSavedPrimaryView,
        );
        if (nextView !== currentState.primaryView) currentState.setPrimaryView(nextView);
        if (index === retryMs.length - 1) {
          initialViewAppliedRef.current = true;
          setBootView(null);
        }
      }, delay),
    );

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [albatrossEnabled, hasSavedPrimaryView, initialView]);

  useEffect(() => {
    if (!isMobile || !selectedThreadId || mobileHistoryThreadRef.current === selectedThreadId) return;
    window.history.pushState(
      {
        ...(window.history.state || {}),
        lab86MailMobileThread: selectedThreadId,
      },
      '',
    );
    mobileHistoryThreadRef.current = selectedThreadId;
  }, [isMobile, selectedThreadId]);

  useEffect(() => {
    if (!isMobile) return;
    const onPopState = () => {
      if (mobileHistoryThreadRef.current) {
        mobileHistoryThreadRef.current = null;
        setSelectedThread(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isMobile, setSelectedThread]);

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
          <Rail
            albatrossEnabled={albatrossEnabled}
            clerkEnabled={clerkEnabled}
            activeViewOverride={bootView ?? undefined}
          />
          <main className="app-paper relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
            <SidebarTrigger
              title="Show sidebar"
              className="absolute left-3 top-3 z-30 border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
            />

            {/* Mobile view: inbox stays mounted underneath so back returns instantly. */}
            <div className="relative h-full w-full overflow-hidden">
              <motion.div
                animate={{ x: readerVisible ? '-22%' : '0%', opacity: readerVisible ? 0.72 : 1 }}
                transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-0 h-full w-full"
                aria-hidden={readerVisible}
              >
                <PrimarySurface
                  albatrossEnabled={albatrossEnabled}
                  view={visiblePrimaryView}
                  capturedIntentId={capturedIntentId}
                />
              </motion.div>

              <AnimatePresence initial={false}>
                {readerVisible ? (
                  <motion.div
                    key="reader"
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '100%' }}
                    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute inset-0 z-20 h-full w-full bg-[var(--color-bg)] shadow-[var(--shadow-pop)]"
                  >
                    <ThreadView />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <AIBarTrigger buttonHidden={albatrossEnabled} />
            <AssistantChat />
            {albatrossEnabled ? <IntentCaptureLauncher onCaptured={handleIntentCaptured} /> : null}
            {albatrossEnabled ? <IntentPip onOpenIntent={handleIntentCaptured} /> : null}
          </main>
        </SidebarProvider>

        <CommandPalette />
        <ShortcutsSheet />
        <ShortcutsBinding />
        <FirstRunRedirect />
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
        <Rail
          albatrossEnabled={albatrossEnabled}
          clerkEnabled={clerkEnabled}
          activeViewOverride={bootView ?? undefined}
        />
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
              data-panel-resizing={panelResizing || undefined}
              className="h-full w-full"
            >
              <Panel id="inbox" defaultSize={panelIds.length === 1 ? '100%' : '40%'} minSize="280px">
                <ReflowPanel>
                  <PrimarySurface
                    albatrossEnabled={albatrossEnabled}
                    view={visiblePrimaryView}
                    capturedIntentId={capturedIntentId}
                  />
                </ReflowPanel>
              </Panel>

              {readerVisible ? <ResizeSeparator onResizeStateChange={setPanelResizing} /> : null}
              {readerVisible ? (
                <Panel id="reader" defaultSize="40%" minSize="360px">
                  <ReflowPanel>
                    {/* Slide-in masks the thread's hydration moment. */}
                    <motion.div
                      key={selectedThreadId || 'compose'}
                      initial={{ x: 28, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                      className="h-full min-w-0"
                    >
                      <ThreadView />
                    </motion.div>
                  </ReflowPanel>
                </Panel>
              ) : null}
            </Group>
          </TooltipProvider>
          <AIBarTrigger buttonHidden={albatrossEnabled} />
          <AssistantChat />
          {albatrossEnabled ? <IntentCaptureLauncher onCaptured={handleIntentCaptured} /> : null}
          {albatrossEnabled ? <IntentPip onOpenIntent={handleIntentCaptured} /> : null}
        </main>
      </SidebarProvider>

      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
      <FirstRunRedirect />
    </TooltipProvider>
  );
}

function PrimarySurface({
  albatrossEnabled,
  view,
  capturedIntentId,
}: {
  albatrossEnabled: boolean;
  view: PrimaryView;
  capturedIntentId?: string | null;
}) {
  switch (view) {
    case 'daily_report':
      return <DailyReport />;
    case 'calendar':
      return <CalendarSurface />;
    case 'tasks':
      return <TasksSurface />;
    case 'intents':
      // Plans: the live intent → plan loop. The legacy seed-driven surface in
      // AlbatrossSurfaces is no longer routed here.
      return albatrossEnabled ? (
        <SurfaceErrorBoundary surface="Plans">
          <PlansSurface initialIntentId={capturedIntentId} />
        </SurfaceErrorBoundary>
      ) : (
        <DailyReport />
      );
    case 'areas':
      // The area home page: mail, events, tasks, and context for the selected
      // area. Management/teach flows live in /settings?tab=areas now.
      return albatrossEnabled ? (
        <SurfaceErrorBoundary surface="Areas">
          <AreaHome />
        </SurfaceErrorBoundary>
      ) : (
        <DailyReport />
      );
    case 'unassigned':
      return albatrossEnabled && isAlbatrossPrimaryView(view) ? (
        <AlbatrossSurface kind={view} />
      ) : (
        <DailyReport />
      );
    default:
      return <Inbox />;
  }
}

// A live-data surface must never take the whole shell down with it (a thrown
// Convex query error propagates as a render error). Catch, explain, offer retry.
class SurfaceErrorBoundary extends Component<
  { surface: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <p className="text-[14px] font-medium">{this.props.surface} hit an error.</p>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
            {this.state.error.message.slice(0, 300)}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--color-bg-subtle)]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

function ReflowPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      layout="size"
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn('panel-reflow-surface h-full min-w-0 overflow-hidden', className)}
    >
      {children}
    </motion.div>
  );
}

const RAIL_MIN = 200;
const RAIL_MAX = 420;
const RAIL_DEFAULT = 240;
const noopLayoutStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => null,
  setItem: () => undefined,
};

function hasPersistedPrimaryView() {
  if (typeof window === 'undefined') return false;
  try {
    return hasPersistedPrimaryViewValue(window.localStorage.getItem('lab86-mail-ui'));
  } catch {
    return false;
  }
}

// Drag handle living between the sidebar and the main content. It nudges the
// `--sidebar-width` CSS variable directly during the drag (so the resize is
// smooth and doesn't re-render the whole shell), then commits the final width
// to the store on release so it persists.
function RailResizeHandle() {
  const setRailWidth = useClientStore((s) => s.setRailWidth);
  const ref = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  // Detaches the window listeners of an in-flight drag; needed so an unmount
  // mid-drag doesn't leave pointermove/pointerup handlers (and the disabled
  // text selection) behind.
  const endDrag = useRef<(() => void) | null>(null);

  useEffect(() => () => endDrag.current?.(), []);

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
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      endDrag.current = null;
    };
    const onUp = () => {
      detach();
      setDragging(false);
      setRailWidth(latest);
    };
    endDrag.current = detach;
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

function ResizeSeparator({ onResizeStateChange }: { onResizeStateChange: (resizing: boolean) => void }) {
  // 6px wide hit target with a 1px visible rule down the middle; brightens on
  // hover/drag so it's clearly grabbable.
  return (
    <Separator
      onPointerDown={() => {
        const endResize = () => {
          window.removeEventListener('pointerup', endResize);
          window.removeEventListener('blur', endResize);
          onResizeStateChange(false);
        };
        onResizeStateChange(true);
        window.addEventListener('pointerup', endResize);
        window.addEventListener('blur', endResize);
      }}
      className="group relative w-[6px] shrink-0 cursor-col-resize bg-[var(--color-transparent)] outline-none"
    >
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
        aria-hidden
      />
    </Separator>
  );
}
