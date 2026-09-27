import { describe, expect, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { newOperationBatchId, recordOperation, registerUndoExecutor } from '../lib/ai/operations';
import * as hosted from '../lib/hosted/convex';
import { listRecentOperationsTool, undoOperationTool } from '../lib/tools/operations-tools';
import { runTool, TEST_USER } from './tools/harness';

describe('operation registry boundaries', () => {
  test('creates distinct batch ids and rejects duplicate executor registration', () => {
    expect(newOperationBatchId()).toMatch(
      /^batch_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newOperationBatchId()).not.toBe(newOperationBatchId());
    const kind = `coverage_${Date.now()}_${Math.random()}`;
    const executor = async () => undefined;
    registerUndoExecutor(kind, executor);
    expect(() => registerUndoExecutor(kind, executor)).toThrow('Undo executor already registered');
  });

  test('rejects an inverse whose executor was never registered', async () => {
    await expect(
      recordOperation({
        userId: 'user_1',
        tool: 'test_tool',
        surface: 'albatross',
        summary: 'Test operation',
        target: {},
        inverse: { kind: `missing_${Date.now()}`, payload: {} },
      }),
    ).rejects.toThrow('No undo executor registered');
  });
});

describe('operations tools', () => {
  test('list_recent_operations returns the review fields and marks only applied rows with an inverse undoable', async () => {
    const rows = [
      {
        _id: 'op_applied',
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived "Invoice 42"',
        reason: 'You asked to clear paid invoices.',
        agent: 'ai',
        batchId: 'batch_1',
        target: { threadId: 'thread_1' },
        status: 'applied',
        inverse: { kind: 'mail_unarchive', payload: {} },
        createdAt: 20,
        claimToken: 'private-claim',
      },
      {
        _id: 'op_undone',
        tool: 'archive_thread',
        surface: 'mail',
        summary: 'Archived "Receipt"',
        agent: 'user',
        batchId: 'batch_1',
        target: { threadId: 'thread_2' },
        status: 'undone',
        inverse: { kind: 'mail_unarchive', payload: {} },
        createdAt: 10,
      },
      {
        _id: 'op_final',
        tool: 'send_email',
        surface: 'mail',
        summary: 'Sent "Hello"',
        agent: 'ai',
        target: { messageId: 'message_1' },
        status: 'applied',
        createdAt: 5,
      },
    ];
    const query = spyOn(hosted, 'convexQuery').mockResolvedValue(rows as any);
    try {
      const result = await runTool(listRecentOperationsTool.handler, { batchId: 'batch_1', limit: 10 });
      expect(getFunctionName(query.mock.calls[0][0] as any)).toBe('operations:listRecent');
      expect(query.mock.calls[0][1]).toEqual({ userId: TEST_USER.userId, batchId: 'batch_1', limit: 10 });
      expect(result.operations).toEqual([
        {
          operationId: 'op_applied',
          tool: 'archive_thread',
          surface: 'mail',
          summary: 'Archived "Invoice 42"',
          reason: 'You asked to clear paid invoices.',
          agent: 'ai',
          batchId: 'batch_1',
          target: { threadId: 'thread_1' },
          status: 'applied',
          undoable: true,
          createdAt: 20,
        },
        {
          operationId: 'op_undone',
          tool: 'archive_thread',
          surface: 'mail',
          summary: 'Archived "Receipt"',
          reason: undefined,
          agent: 'user',
          batchId: 'batch_1',
          target: { threadId: 'thread_2' },
          status: 'undone',
          undoable: false,
          createdAt: 10,
        },
        {
          operationId: 'op_final',
          tool: 'send_email',
          surface: 'mail',
          summary: 'Sent "Hello"',
          reason: undefined,
          agent: 'ai',
          batchId: undefined,
          target: { messageId: 'message_1' },
          status: 'applied',
          undoable: false,
          createdAt: 5,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('private-claim');
    } finally {
      query.mockRestore();
    }
  });

  test('undo_operation reports an already undone operation as done without running it again', async () => {
    const mutation = spyOn(hosted, 'convexMutation').mockResolvedValue({
      state: 'already_undone',
      tool: 'archive_thread',
      surface: 'mail',
      summary: 'Archived "Invoice 42"',
    } as any);
    try {
      const result = await runTool(undoOperationTool.handler, { operationId: 'op_applied' });
      expect(result).toEqual({ ok: true, undone: 'Archived "Invoice 42"' });
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(getFunctionName(mutation.mock.calls[0][0] as any)).toBe('operations:claimUndo');
      expect(mutation.mock.calls[0][1]).toMatchObject({
        userId: TEST_USER.userId,
        operationId: 'op_applied',
      });
    } finally {
      mutation.mockRestore();
    }
  });
});
