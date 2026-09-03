'use client';

import { AnimatePresence, motion } from 'motion/react';
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { ActivitySurface } from '@/components/albatross/ActivitySurface';
import { AlbatrossCompanion } from '@/components/albatross/AlbatrossCompanion';
import { AlbatrossesSurface } from '@/components/albatross/AlbatrossesSurface';
import { AreaHome } from '@/components/albatross/AreaHome';
import { IntentCaptureLauncher } from '@/components/albatross/IntentCapture';
import { WorkDetail } from '@/components/albatross/WorkDetail';
import { CalendarSurface } from '@/components/calendar/CalendarSurface';
import { FilesSurface } from '@/components/files/FilesSurface';
import { RecordMailboxesConnected } from '@/components/hosted/HostedOnboarding';
import { Inbox } from '@/components/inbox/Inbox';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { Today } from '@/components/report/Today';
import { TasksSurface } from '@/components/tasks/TasksSurface';
import { ThreadView } from '@/components/thread/ThreadView';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { useClientStore } from '@/lib/client-state';
import {
  areaIdFromSearch,
  hasPersistedPrimaryViewValue,
  normalizePrimaryView,
  type PrimaryView,
  primaryViewFromSearch,
  resolveInitialPrimaryView,
  workIdFromSearch,
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
  clerkEnabled,
  initialView,
}: {
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
  const normalizedPrimaryView = normalizePrimaryView(primaryView);
  const initialPrimaryView = resolveInitialPrimaryView(primaryView, initialView, hasSavedPrimaryView);
  const [bootView, setBootView] = useState<PrimaryView | null>(() =>
    initialPrimaryView !== normalizedPrimaryView ? initialPrimaryView : null,
  );
  const visiblePrimaryView = normalizePrimaryView(bootView ?? primaryView);
  const selectedWorkId = useClientStore((s) => s.selectedWorkId);
  const setSelectedWorkId = useClientStore((s) => s.setSelectedWorkId);
  const setSelectedAreaId = useClientStore((s) => s.setSelectedAreaId);
  // Settings deep-links back into the area setup wizard via /?setup=areas.
  const [openAreaSetup] = useState<boolean>(
    () =>
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('setup') === 'areas',
  );
  const [deepLinkedView] = useState<PrimaryView | null>(() => {
    if (typeof window === 'undefined') return null;
    return primaryViewFromSearch(window.location.search);
  });
  // `?work=<id>` and `?area=<id>` address one Albatross or one Area directly,
  // so a link out of a notification or a brief opens the thing it names.
  const [deepLinkedWorkId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : workIdFromSearch(window.location.search),
  );
  const [deepLinkedAreaId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : areaIdFromSearch(window.location.search),
  );
  // Capture lands on the new Albatross itself — the plan is the payoff for
  // dumping the thought, so the user should see it, not a list.
  const handleWorkCaptured = useCallback(
    (workId: string) => {
      setSelectedWorkId(workId);
      setPrimaryView('albatrosses');
    },
    [setPrimaryView, setSelectedWorkId],
  );

  // The Area Brief captures an area-bound intent, then hands it off here so the
  // dump→plan moment lands on Plans with that intent selected — same contract
  // as the global capture launcher, driven through client state.
  const pendingOpenIntentId = useClientStore((s) => s.pendingOpenIntentId);
  const setPendingOpenIntentId = useClientStore((s) => s.setPendingOpenIntentId);
  useEffect(() => {
    if (!pendingOpenIntentId) return;
    handleWorkCaptured(pendingOpenIntentId);
    setPendingOpenIntentId(null);
  }, [handleWorkCaptured, pendingOpenIntentId, setPendingOpenIntentId]);
  const pendingOpenWorkId = useClientStore((s) => s.pendingOpenWorkId);
  const setPendingOpenWorkId = useClientStore((s) => s.setPendingOpenWorkId);
  useEffect(() => {
    if (!pendingOpenWorkId) return;
    handleWorkCaptured(pendingOpenWorkId);
    setPendingOpenWorkId(null);
  }, [handleWorkCaptured, pendingOpenWorkId, setPendingOpenWorkId]);

  useEffect(() => {
    // The deep link must win over whatever view was persisted.
    if (openAreaSetup) setPrimaryView('areas');
  }, [openAreaSetup, setPrimaryView]);

  useEffect(() => {
    if (deepLinkedWorkId) {
      initialViewAppliedRef.current = true;
      setBootView(null);
      setSelectedWorkId(deepLinkedWorkId);
      setPrimaryView('albatrosses');
      return;
    }
    if (deepLinkedAreaId) {
      initialViewAppliedRef.current = true;
      setBootView(null);
      setSelectedAreaId(deepLinkedAreaId);
      setPrimaryView('areas');
      return;
    }
    if (!deepLinkedView) return;
    initialViewAppliedRef.current = true;
    setBootView(null);
    setPrimaryView(deepLinkedView);
  }, [
    deepLinkedAreaId,
    deepLinkedView,
    deepLinkedWorkId,
    setPrimaryView,
    setSelectedAreaId,
    setSelectedWorkId,
  ]);

  // The thread reader rides along with the mail-ish surfaces; calendar and
  // tasks keep their pane to themselves. Compose stays available everywhere.
  // Areas count as mail-ish: opening a thread from an area home slides the
  // reader in beside it instead of yanking the user back to the inbox.
  const mailish =
    visiblePrimaryView === 'mail' || visiblePrimaryView === 'today' || visiblePrimaryView === 'areas';
  const readerVisible = !!(composeMode || (selectedThreadId && mailish));
  // Mail is the only surface built as a card the reader can halve. Everywhere
  // else the reader arrives as a sheet over the page, so Today and Areas keep
  // their own full-width shape instead of pretending to be an inbox.
  const readerSplit = readerVisible && visiblePrimaryView === 'mail';
  const readerSheet = readerVisible && !readerSplit;
  // The assistant is a floating overlay now (AssistantChat), not a docked
  // panel, so it no longer participates in the resizable layout.
  const permutation = `i${readerSplit ? 't' : ''}`;
  const panelIds = ['inbox', ...(readerSplit ? ['reader'] : [])];
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
    if (!initialView || initialViewAppliedRef.current || deepLinkedView) return;

    const retryMs = [0, 150, 600, 1500];
    const timers = retryMs.map((delay, index) =>
      window.setTimeout(() => {
        const currentState = useClientStore.getState();
        const nextView = resolveInitialPrimaryView(
          currentState.primaryView,
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
  }, [deepLinkedView, hasSavedPrimaryView, initialView]);

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
          <Rail clerkEnabled={clerkEnabled} activeViewOverride={bootView ?? undefined} />
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
                <PrimarySurface view={visiblePrimaryView} selectedWorkId={selectedWorkId} />
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
            <AssistantChat />
            <AIBarTrigger />
            <IntentCaptureLauncher onCaptured={handleWorkCaptured} />
            <AlbatrossCompanion />
          </main>
        </SidebarProvider>

        <CommandPalette />
        <ShortcutsSheet />
        <ShortcutsBinding />
        <RecordMailboxesConnected />
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
        <Rail clerkEnabled={clerkEnabled} activeViewOverride={bootView ?? undefined} />
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
                  <PrimarySurface view={visiblePrimaryView} selectedWorkId={selectedWorkId} />
                </ReflowPanel>
              </Panel>

              {readerSplit ? <ResizeSeparator onResizeStateChange={setPanelResizing} /> : null}
              {readerSplit ? (
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

            {/* Off Mail there is no card to halve, so the thread visits as a
                sheet over the page. The surface underneath keeps its own
                width and stays usable — this is not a modal. */}
            <AnimatePresence initial={false}>
              {readerSheet ? (
                <motion.div
                  key="reader-sheet"
                  initial={{ x: 32, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 32, opacity: 0 }}
                  transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute inset-y-0 right-0 z-30 w-[min(560px,calc(100%-96px))]"
                >
                  <ThreadView variant="sheet" />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </TooltipProvider>
          <AssistantChat />
          <AIBarTrigger />
          <IntentCaptureLauncher onCaptured={handleWorkCaptured} />
          <AlbatrossCompanion />
        </main>
      </SidebarProvider>

      <CommandPalette />
      <ShortcutsSheet />
      <ShortcutsBinding />
      <RecordMailboxesConnected />
    </TooltipProvider>
  );
}

function PrimarySurface({ view, selectedWorkId }: { view: PrimaryView; selectedWorkId?: string | null }) {
  switch (view) {
    case 'today':
      return (
        <SurfaceErrorBoundary surface="Today">
          <Today />
        </SurfaceErrorBoundary>
      );
    case 'albatrosses':
      // One Albatross when the user picked one, otherwise the whole list.
      return (
        <SurfaceErrorBoundary surface="Albatrosses">
          {selectedWorkId ? <WorkDetail workId={selectedWorkId} /> : <AlbatrossesSurface />}
        </SurfaceErrorBoundary>
      );
    case 'areas':
      // The area home page: mail, events, tasks, and context for the selected
      // area. Management/teach flows live in /settings?tab=areas now.
      return (
        <SurfaceErrorBoundary surface="Areas">
          {selectedWorkId ? <WorkDetail workId={selectedWorkId} /> : <AreaHome />}
        </SurfaceErrorBoundary>
      );
    case 'activity':
      return (
        <SurfaceErrorBoundary surface="Activity">
          <ActivitySurface />
        </SurfaceErrorBoundary>
      );
    case 'calendar':
      return <CalendarSurface />;
    case 'files':
      return <FilesSurface />;
    case 'tasks':
      // The board left the rail. It stays routable for saved links and for the
      // people who turn it back on in Settings.
      return <TasksSurface />;
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
  // The seam of the one mail surface: the list and reader halves open toward
  // this 6px grab area, which paints itself as card surface with top/bottom
  // borders that continue the halves' outline, plus a 1px interior rule. The
  // vertical inset matches the halves' sm:p-2 gutter.
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
        className="pointer-events-none absolute inset-x-0 inset-y-2 border-y border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute bottom-2 left-1/2 top-2 w-px -translate-x-1/2 bg-[var(--color-border)]/70 transition-colors group-hover:bg-[var(--color-accent)] group-data-[separator-state=drag]:w-[2px] group-data-[separator-state=drag]:bg-[var(--color-accent)]"
        aria-hidden
      />
    </Separator>
  );
}
