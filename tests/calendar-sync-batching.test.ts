import { describe, expect, test } from 'bun:test';
import { reconcileCalendarWindowBatched } from '../lib/calendar/sync';

describe('calendar reconciliation batching', () => {
  test('follows continuation cursors and aggregates pruned rows', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const responses = [
      { done: false, continueCursor: 'cursor_1', pruned: 4 },
      { done: true, pruned: 2 },
    ];
    const result = await reconcileCalendarWindowBatched(
      { userId: 'user_1', providerCalendarId: 'calendar_1' },
      async (_fn, args) => {
        calls.push(args);
        return responses.shift();
      },
    );

    expect(result).toEqual({ ok: true, pruned: 6 });
    expect(calls).toEqual([
      { userId: 'user_1', providerCalendarId: 'calendar_1', limit: 500 },
      { userId: 'user_1', providerCalendarId: 'calendar_1', cursor: 'cursor_1', limit: 500 },
    ]);
  });

  test('fails closed if a non-final page loses its cursor', async () => {
    await expect(
      reconcileCalendarWindowBatched({}, async () => ({ done: false, pruned: 0 })),
    ).rejects.toThrow('lost its continuation cursor');
  });
});
