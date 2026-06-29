import { describe, expect, test } from 'bun:test';
import { categoricalColor } from '../lib/shared/format';
import { taskSourceColor, taskSourceColorKey } from '../lib/shared/task-colors';

describe('task source colors', () => {
  test('prefers source account so email-created tasks match the mail/calendar palette', () => {
    const task = {
      cardId: 'card_1',
      boardId: 'board_1',
      source: { accountId: 'work@example.com', threadId: 'thread_1' },
      sourceAccountId: 'legacy-account-id',
    };
    expect(taskSourceColorKey(task)).toBe('work@example.com');
    expect(taskSourceColor(task)).toBe(categoricalColor('work@example.com'));
  });

  test('falls back deterministically when no source account exists', () => {
    expect(taskSourceColorKey({ cardId: 'card_2', boardId: 'board_2' })).toBe('board_2');
    expect(taskSourceColor({ cardId: 'card_2', boardId: 'board_2' })).toBe(categoricalColor('board_2'));
  });
});
