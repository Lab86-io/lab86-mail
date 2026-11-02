import { describe, expect, test } from 'bun:test';
import { isToolRetrySafe, ToolFailedBeforeWrite, ToolTimeoutError } from '../lib/ai/tool-errors';
import { calendarCreateEvent } from '../lib/tools/calendar';
import { saveDraftTool, scheduleSend } from '../lib/tools/compose';
import { bulkMoveThreads } from '../lib/tools/mail-mutate';
import { tasksCreateCard } from '../lib/tools/tasks';
import { runTool, TEST_USER } from './tools/harness';
import { accountRow, type HttpHarness, withHttpHarness } from './tools/http-harness';

// A handler that can prove it wrote nothing says so with a typed error, so the
// same arguments can run again. A call past its limit stops before the commit.

const ended = () => AbortSignal.abort(new ToolTimeoutError('The call passed its limit.'));
const IN_ONE_HOUR = Date.now() + 3_600_000;

function board(h: HttpHarness) {
  h.onConvex('boards:getBoard', () => ({
    board: { boardId: 'board_1', title: 'Main', ownerId: TEST_USER.userId },
    columns: [{ columnId: 'col_1', name: 'To do', position: 0 }],
    boardId: 'board_1',
    title: 'Main',
    ownerId: TEST_USER.userId,
    columnsList: [],
  }));
}

describe('tasks_create_card', () => {
  test('a call past its limit stops before the card write', async () => {
    await withHttpHarness(async (h) => {
      board(h);
      h.convexFallback = () => null;
      const failed = await runTool(
        tasksCreateCard.handler,
        { boardId: 'board_1', title: 'Call the bank' },
        { abortSignal: ended() },
      ).catch((error) => error);
      expect(isToolRetrySafe(failed)).toBe(true);
      expect(h.convexCalls.some((call) => call.path === 'boards:createCard')).toBe(false);
    });
  });

  test('a bad due date fails before any write', async () => {
    await withHttpHarness(async (h) => {
      board(h);
      h.convexFallback = () => null;
      const failed = await runTool(tasksCreateCard.handler, {
        boardId: 'board_1',
        title: 'Call the bank',
        dueIso: 'not a date',
      }).catch((error) => error);
      expect(isToolRetrySafe(failed)).toBe(true);
    });
  });
});

describe('save_draft', () => {
  test('a call past its limit stops before the save', async () => {
    await withHttpHarness(async (h) => {
      h.convexFallback = () => null;
      const failed = await runTool(
        saveDraftTool.handler,
        { account: 'acct_1', to: 'sam@example.test', subject: 'Plan', body: 'Here it is.' },
        { abortSignal: ended() },
      ).catch((error) => error);
      expect(failed).toBeInstanceOf(ToolFailedBeforeWrite);
      expect(h.convexCalls).toEqual([]);
    });
  });
});

describe('schedule_send', () => {
  const MESSAGE = { account: 'acct_1', to: 'sam@example.test', subject: 'Plan', body: 'Here it is.' };

  test('a time that has passed fails before any write', async () => {
    const failed = await runTool(scheduleSend.handler, { ...MESSAGE, scheduledFor: Date.now() - 1 }).catch(
      (error) => error,
    );
    expect(failed).toBeInstanceOf(ToolFailedBeforeWrite);
    expect(failed.message).toContain('at least a minute');
  });

  test('a call past its limit stops before the provider send', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow({ userId: TEST_USER.userId }));
      h.convexFallback = () => null;
      const failed = await runTool(
        scheduleSend.handler,
        { ...MESSAGE, scheduledFor: IN_ONE_HOUR },
        { abortSignal: ended() },
      ).catch((error) => error);
      expect(failed).toBeInstanceOf(ToolFailedBeforeWrite);
      expect(h.nylasCalls.filter((call) => call.method === 'POST')).toEqual([]);
    });
  });
});

describe('calendar_create_event', () => {
  test('a time it cannot read fails before any write', async () => {
    const failed = await runTool(calendarCreateEvent.handler, {
      account: 'acct_1',
      title: 'Review',
      startIso: 'not a date',
      endIso: 'not a date',
      allDay: false,
      attendees: [],
      busy: true,
    }).catch((error) => error);
    expect(isToolRetrySafe(failed)).toBe(true);
  });
});

describe('bulk_move_threads', () => {
  test('a call past its limit moves nothing more, and the result says so', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => accountRow({ userId: TEST_USER.userId }));
      h.convexFallback = () => null;
      const result = await runTool(
        bulkMoveThreads.handler,
        { to: 'archive', items: [{ account: 'acct_1', threadId: 't1' }] },
        { abortSignal: ended() },
      );
      expect(result.ok).toBe(false);
      expect(result.moved).toEqual([]);
      expect(result.failed[0].threadId).toBe('t1');
      expect(h.nylasCalls.filter((call) => call.method === 'PUT')).toEqual([]);
    });
  });

  test('an account that is not connected fails before any move', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => null);
      h.convexFallback = () => null;
      const result = await runTool(bulkMoveThreads.handler, {
        to: 'archive',
        items: [{ account: 'acct_1', threadId: 't1' }],
      });
      expect(result.ok).toBe(false);
    });
  });
});
