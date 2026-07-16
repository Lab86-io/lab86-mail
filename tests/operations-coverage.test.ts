import { describe, expect, test } from 'bun:test';
import { newOperationBatchId, recordOperation, registerUndoExecutor } from '../lib/ai/operations';

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
