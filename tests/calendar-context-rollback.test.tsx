import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import {
  type CalendarPersistence,
  CalendarProvider,
  useCalendar,
} from '../components/calendar/engine/calendar-context';
import type { IEvent } from '../components/calendar/engine/interfaces';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// UI-7: the grid changes local state first. When the write fails, the change
// must go back instead of staying until the next sync.

const user = { id: 'cal_1', name: 'Work', picturePath: null };

function event(id: string, overrides: Partial<IEvent> = {}): IEvent {
  return {
    id,
    title: id,
    startDate: '2026-09-26T14:00:00.000Z',
    endDate: '2026-09-26T15:00:00.000Z',
    color: 'blue',
    description: '',
    user,
    ...overrides,
  };
}

function mount(events: IEvent[], persistence: CalendarPersistence) {
  let ctx: ReturnType<typeof useCalendar> | null = null;
  function Probe() {
    ctx = useCalendar();
    return null;
  }
  act(() => {
    create(
      <CalendarProvider users={[user]} events={events} persistence={persistence}>
        <Probe />
      </CalendarProvider>,
    );
  });
  return () => ctx as unknown as ReturnType<typeof useCalendar>;
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('calendar optimistic rollback (UI-7)', () => {
  test('a failed create removes the phantom event', async () => {
    const reject = async () => {
      throw new Error('provider down');
    };
    const ctx = mount([event('a')], { onEventAdded: reject });
    act(() => ctx().addEvent(event('local_1')));
    expect(ctx().events.map((e) => e.id)).toEqual(['a', 'local_1']);
    await flush();
    expect(ctx().events.map((e) => e.id)).toEqual(['a']);
  });

  test('a failed drag puts the event back where it was', async () => {
    const ctx = mount([event('a')], {
      onEventUpdated: async () => {
        throw new Error('provider down');
      },
    });
    act(() =>
      ctx().updateEvent(
        event('a', { startDate: '2026-09-27T14:00:00.000Z', endDate: '2026-09-27T15:00:00.000Z' }),
      ),
    );
    expect(ctx().events[0].startDate).toBe('2026-09-27T14:00:00.000Z');
    await flush();
    expect(ctx().events[0].startDate).toBe('2026-09-26T14:00:00.000Z');
  });

  test('a failed series delete restores every occurrence', async () => {
    const ctx = mount(
      [event('i1', { masterEventId: 'm' }), event('i2', { masterEventId: 'm' }), event('b')],
      {
        onEventRemoved: async () => {
          throw new Error('provider down');
        },
      },
    );
    act(() => ctx().removeEvent('i1', { deleteSeries: true }));
    expect(ctx().events.map((e) => e.id)).toEqual(['b']);
    await flush();
    expect(
      ctx()
        .events.map((e) => e.id)
        .sort(),
    ).toEqual(['b', 'i1', 'i2']);
  });

  test('a successful write keeps the optimistic change', async () => {
    const ctx = mount([event('a')], { onEventRemoved: async () => undefined });
    act(() => ctx().removeEvent('a'));
    await flush();
    expect(ctx().events).toEqual([]);
  });
});
