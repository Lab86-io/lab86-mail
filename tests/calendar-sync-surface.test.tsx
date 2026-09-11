import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CalendarProvider } from '../components/calendar/engine/calendar-context';
import { CalendarHeader } from '../components/calendar/engine/calendar-header';
import { DndProvider } from '../components/calendar/engine/dnd-context';
import { isPendingEvent } from '../components/calendar/engine/helpers';
import type { IEvent } from '../components/calendar/engine/interfaces';
import {
  initialSyncLinePhase,
  SYNC_LINE_FADE_MS,
  SYNC_LINE_FINISH_MS,
  SyncLine,
  type SyncLineHost,
  syncLineStyle,
} from '../components/calendar/SyncLine';
import { SyncStatus } from '../components/calendar/SyncStatus';
import {
  PULL_MAX_OFFSET_PX,
  PULL_THRESHOLD_PX,
  pullOffset,
  scrolledBetween,
  usePullToResync,
} from '../components/calendar/usePullToResync';
import { TooltipProvider } from '../components/ui/tooltip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');
const renderToStaticMarkup = (node: React.ReactNode) =>
  renderMarkup(<TooltipProvider>{node}</TooltipProvider>);
const NOW = 1_800_000_000_000;

function fakeLineHost() {
  let next = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const frames = new Map<number, () => void>();
  const host: SyncLineHost & {
    timers: typeof timers;
    frames: typeof frames;
    flushFrames(): void;
    fire(delayMs: number): void;
  } = {
    setTimeout: (callback, delayMs) => {
      const handle = next++;
      timers.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    requestFrame: (callback) => {
      const handle = next++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number);
    },
    timers,
    frames,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    fire(delayMs) {
      for (const [handle, timer] of timers) {
        if (timer.delayMs !== delayMs) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
  };
  return host;
}

describe('SyncLine', () => {
  test('phase styles: 0 to 70 percent, hold, then 100 percent and fade', () => {
    expect(syncLineStyle('hidden')).toEqual({ width: '0%', opacity: 0, transition: 'none' });
    expect(syncLineStyle('start').width).toBe('0%');
    expect(syncLineStyle('growing')).toMatchObject({ width: '70%', opacity: 1 });
    expect(syncLineStyle('growing').transition).toContain('800ms');
    expect(syncLineStyle('growing').transition).toContain('--ease-enter');
    expect(syncLineStyle('finishing')).toMatchObject({ width: '100%', opacity: 1 });
    expect(syncLineStyle('fading')).toMatchObject({ width: '100%', opacity: 0 });
    expect(syncLineStyle('static')).toEqual({ width: '100%', opacity: 1, transition: 'none' });
  });

  test('initial phase', () => {
    expect(initialSyncLinePhase(false, false)).toBe('hidden');
    expect(initialSyncLinePhase(true, false)).toBe('start');
    expect(initialSyncLinePhase(true, true)).toBe('static');
  });

  test('renders a 2 px accent-3 line at the top of the frame', () => {
    const html = renderToStaticMarkup(<SyncLine active={false} />);
    expect(html).toContain('data-sync-line');
    expect(html).toContain('h-0.5');
    expect(html).toContain('bg-[var(--color-accent-3)]');
    expect(html).toContain('absolute inset-x-0 top-0');
    expect(html).toContain('data-phase="hidden"');
  });

  test('grows on active, then finishes and fades when the sync settles', async () => {
    const host = fakeLineHost();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SyncLine active={false} host={host} />);
    });
    const phase = () => renderer.root.findByType('div').props['data-phase'];
    expect(phase()).toBe('hidden');

    await act(async () => renderer.update(<SyncLine active host={host} />));
    expect(phase()).toBe('start');
    await act(async () => host.flushFrames());
    expect(phase()).toBe('growing');

    await act(async () => renderer.update(<SyncLine active={false} host={host} />));
    expect(phase()).toBe('finishing');
    await act(async () => host.fire(SYNC_LINE_FINISH_MS));
    expect(phase()).toBe('fading');
    await act(async () => host.fire(SYNC_LINE_FINISH_MS + SYNC_LINE_FADE_MS));
    expect(phase()).toBe('hidden');
  });

  test('a line active at mount still grows', async () => {
    const host = fakeLineHost();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SyncLine active host={host} />);
    });
    await act(async () => host.flushFrames());
    expect(renderer.root.findByType('div').props['data-phase']).toBe('growing');
  });

  test('reduced movement: a static line for the sync, then gone', async () => {
    const host = fakeLineHost();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SyncLine active reduceMotion host={host} />);
    });
    const phase = () => renderer.root.findByType('div').props['data-phase'];
    expect(phase()).toBe('static');
    expect(host.frames.size).toBe(0);
    await act(async () => renderer.update(<SyncLine active={false} reduceMotion host={host} />));
    expect(phase()).toBe('hidden');
    expect(host.timers.size).toBe(0);
  });
});

describe('SyncStatus', () => {
  test('an inline check has the relative status in its accessible tooltip', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SyncStatus
          lastSyncedAt={NOW - 4 * 60_000}
          syncing={false}
          error={null}
          nowMs={NOW}
          onResync={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('<button');
    expect(html).toContain('data-sync-status');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('title="Synced 4 minutes ago · Sync now"');
    expect(html).toContain('aria-label="Synced 4 minutes ago · Sync now"');
    expect(html).not.toContain('>Synced 4 minutes ago<');
    expect(html).toContain('lucide-check');
  });

  test('syncing, failed, and limited states', () => {
    expect(
      renderToStaticMarkup(
        <SyncStatus lastSyncedAt={NOW} syncing error={null} nowMs={NOW} onResync={() => {}} />,
      ),
    ).toContain('data-state="syncing"');
    const failed = renderToStaticMarkup(
      <TooltipProvider>
        <SyncStatus
          lastSyncedAt={NOW}
          syncing={false}
          error={{ kind: 'failed' }}
          nowMs={NOW}
          onResync={() => {}}
        />
      </TooltipProvider>,
    );
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain('Could not sync. Try again.');
    expect(failed).toContain('text-[var(--color-danger)]');
    const limited = renderToStaticMarkup(
      <TooltipProvider>
        <SyncStatus
          lastSyncedAt={NOW}
          syncing={false}
          error={{ kind: 'limited', retryAt: NOW + 120_000 }}
          nowMs={NOW}
          onResync={() => {}}
        />
      </TooltipProvider>,
    );
    expect(limited).toContain('data-state="limited"');
    expect(limited).toContain('Too many syncs. Try again in 2 minutes.');
  });

  test('a pending request uses the spinner and disables another request', () => {
    const html = renderToStaticMarkup(
      <SyncStatus lastSyncedAt={NOW} syncing={false} busy error={null} nowMs={NOW} onResync={() => {}} />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-state="syncing"');
    expect(html).toContain('lucide-loader-circle');
  });
  test('a first sync has an honest tooltip without a status sentence in the row', () => {
    const html = renderToStaticMarkup(
      <SyncStatus lastSyncedAt={null} syncing={false} error={null} nowMs={NOW} onResync={() => {}} />,
    );
    expect(html).toContain('Waiting for the first calendar sync');
    expect(html).not.toContain('Not synced yet');
  });
});

describe('usePullToResync', () => {
  test('offset uses resistance and a cap', () => {
    expect(pullOffset(0)).toBe(0);
    expect(pullOffset(-20)).toBe(0);
    expect(pullOffset(50)).toBe(20);
    expect(pullOffset(1_000)).toBe(PULL_MAX_OFFSET_PX);
  });

  test('scrolledBetween walks up to the container', () => {
    const container = { scrollTop: 0, parentElement: null } as unknown as Element;
    const list = { scrollTop: 12, parentElement: container } as unknown as Element;
    const leaf = { scrollTop: 0, parentElement: list } as unknown as Element;
    expect(scrolledBetween(leaf, container)).toBe(true);
    expect(scrolledBetween({ scrollTop: 0, parentElement: container } as any, container)).toBe(false);
    expect(scrolledBetween(null, container)).toBe(false);
  });

  test('a pull past the threshold posts once and springs back', async () => {
    let pulls = 0;
    let latest: ReturnType<typeof usePullToResync> | null = null;
    function Probe() {
      latest = usePullToResync({ onPull: () => pulls++ });
      return <div />;
    }
    await act(async () => {
      create(<Probe />);
    });
    const container = { scrollTop: 0, parentElement: null };
    const touch = (clientY: number) =>
      ({ touches: [{ clientY }], target: container, currentTarget: container }) as any;
    await act(async () => latest!.handlers.onTouchStart(touch(100)));
    await act(async () => latest!.handlers.onTouchMove(touch(100 + PULL_THRESHOLD_PX / 2)));
    expect(latest!.offset).toBe(pullOffset(PULL_THRESHOLD_PX / 2));
    expect(latest!.pulling).toBe(true);
    expect(latest!.style.transition).toBe('none');
    await act(async () => latest!.handlers.onTouchEnd());
    expect(pulls).toBe(0);
    expect(latest!.offset).toBe(0);
    expect(latest!.style.transition).toContain('300ms');

    await act(async () => latest!.handlers.onTouchStart(touch(100)));
    await act(async () => latest!.handlers.onTouchMove(touch(100 + PULL_THRESHOLD_PX)));
    expect(latest!.style.transform).toBe(`translateY(${pullOffset(PULL_THRESHOLD_PX)}px)`);
    await act(async () => latest!.handlers.onTouchEnd());
    expect(pulls).toBe(1);
    expect(latest!.offset).toBe(0);
  });

  test('a scrolled inner list does not start a pull', async () => {
    let pulls = 0;
    let latest: ReturnType<typeof usePullToResync> | null = null;
    function Probe() {
      latest = usePullToResync({ onPull: () => pulls++ });
      return <div />;
    }
    await act(async () => {
      create(<Probe />);
    });
    const container = { scrollTop: 0, parentElement: null };
    const list = { scrollTop: 40, parentElement: container };
    const touch = (clientY: number) =>
      ({ touches: [{ clientY }], target: list, currentTarget: container }) as any;
    await act(async () => latest!.handlers.onTouchStart(touch(100)));
    await act(async () => latest!.handlers.onTouchMove(touch(300)));
    expect(latest!.offset).toBe(0);
    await act(async () => latest!.handlers.onTouchEnd());
    expect(pulls).toBe(0);
  });
});

function withCalendar(node: React.ReactNode, events: IEvent[] = []) {
  return (
    <CalendarProvider users={[{ id: 'cal', name: 'Work', picturePath: null }]} events={events} view="week">
      <DndProvider>{node}</DndProvider>
    </CalendarProvider>
  );
}

describe('pending events', () => {
  test('a mirror row flagged by the surface, or a local event, is pending', () => {
    expect(isPendingEvent({ id: 'evt_1', pending: true })).toBe(true);
    expect(isPendingEvent({ id: 'local_1' })).toBe(true);
    expect(isPendingEvent({ id: 'evt_1' })).toBe(false);
    expect(isPendingEvent({ id: 'evt_1', pending: false })).toBe(false);
  });

  test('the block and the month badge wear a dashed border while pending, with no hatch', () => {
    const block = read('components/calendar/engine/event-block.tsx');
    expect(block).toContain('const pending = isPendingEvent(event);');
    expect(block).toContain("data-pending={pending ? 'true' : undefined}");
    expect(block).toContain("...(tentative || pending ? { borderStyle: 'dashed' } : {})");
    expect(block).toContain('{tentative ? (');
    expect(block).toContain('transition-colors duration-150');
    const badge = read('components/calendar/engine/month-event-badge.tsx');
    expect(badge).toContain('const pending = isPendingEvent(event);');
    expect(badge).toContain("...(pending ? { borderStyle: 'dashed' } : {})");
    expect(badge).toContain('transition-colors duration-150');
  });
});

describe('CalendarSurface wiring', () => {
  test('the header contains date controls and leaves sync in the calendar row', () => {
    const html = renderToStaticMarkup(withCalendar(<CalendarHeader />));
    expect(html).toContain('data-calendar-date-controls');
    expect(html).not.toContain('data-sync-status');
  });

  test('the surface posts view_open through the hook, wires pull and the sentence, and drops the pulse strip', () => {
    const source = read('components/calendar/CalendarSurface.tsx');
    expect(source).toContain('useCalendarResync({');
    expect(source).toContain("sync.resync('pull')");
    expect(source).toContain("sync.resync('manual_http')");
    expect(source).not.toContain('<SyncLine');
    expect(source).toContain('colorByCalendar={colorByCalendar} status={syncStatus}');
    expect(source).toContain('{...pull.handlers}');
    expect(source).toContain('pending: isPendingEventRow(row, syncedAt)');
    expect(source).not.toContain('animate-pulse');
    expect(source).not.toContain('LapsePrompt');
    expect(source).not.toContain('calendar_list_calendars');
    expect(source).not.toContain('eventsSynced');
  });
});
