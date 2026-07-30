import { describe, expect, test } from 'bun:test';
import { consumeOneTimeCode, parseCleanupMode } from '../lib/mail/one-time-code-cleanup';

interface FolderCall {
  messageId: string;
  add?: string[];
  remove?: string[];
}

function harness(options: { markUsed?: Record<string, unknown>; updateFoldersError?: Error } = {}) {
  const mutations: Array<{ name: string; args: any }> = [];
  const folderCalls: FolderCall[] = [];
  // The generated api object is a proxy that refuses to stringify, so calls are
  // told apart by their arguments: only recordCleanup carries a cleanup field.
  const mutate = (async (_fn: any, args: any) => {
    const name = args?.cleanup ? 'recordCleanup' : 'markUsed';
    mutations.push({ name, args });
    if (name === 'markUsed') {
      return {
        accountId: 'acc-1',
        providerMessageId: 'msg-1',
        providerThreadId: 'th-1',
        alreadyUsed: false,
        cleanup: null,
        ...options.markUsed,
      };
    }
    return { ok: true };
  }) as any;
  const updateFolders = (async (args: any) => {
    folderCalls.push({ messageId: args.messageId, add: args.add, remove: args.remove });
    if (options.updateFoldersError) throw options.updateFoldersError;
    return { ok: true };
  }) as any;
  return { mutate, updateFolders, mutations, folderCalls };
}

describe('parseCleanupMode', () => {
  test('accepts the known modes', () => {
    expect(parseCleanupMode('archive')).toBe('archive');
    expect(parseCleanupMode('trash')).toBe('trash');
    expect(parseCleanupMode('none')).toBe('none');
  });

  test('falls back to leaving mail alone for anything unrecognised', () => {
    expect(parseCleanupMode('delete')).toBe('none');
    expect(parseCleanupMode(undefined)).toBe('none');
    expect(parseCleanupMode(true)).toBe('none');
  });
});

describe('consumeOneTimeCode', () => {
  test('marks the code used without touching the mailbox when cleanup is off', async () => {
    const { mutate, updateFolders, folderCalls } = harness();
    const result = await consumeOneTimeCode(
      { userId: 'user-1', codeId: 'code-1', cleanup: 'none' },
      { mutate, updateFolders },
    );
    expect(result.cleanupStatus).toBe('skipped');
    expect(folderCalls).toHaveLength(0);
  });

  test('archives by removing the message from the inbox', async () => {
    const { mutate, updateFolders, folderCalls } = harness();
    const result = await consumeOneTimeCode(
      { userId: 'user-1', codeId: 'code-1', cleanup: 'archive' },
      { mutate, updateFolders },
    );
    expect(result.cleanupStatus).toBe('archived');
    expect(folderCalls).toEqual([{ messageId: 'msg-1', add: undefined, remove: ['INBOX'] }]);
  });

  test('trashes by adding the trash folder', async () => {
    const { mutate, updateFolders, folderCalls } = harness();
    const result = await consumeOneTimeCode(
      { userId: 'user-1', codeId: 'code-1', cleanup: 'trash' },
      { mutate, updateFolders },
    );
    expect(result.cleanupStatus).toBe('trashed');
    expect(folderCalls).toEqual([{ messageId: 'msg-1', add: ['TRASH'], remove: undefined }]);
  });

  test('does not file the message twice when a consume is retried', async () => {
    const { mutate, updateFolders, folderCalls } = harness({
      markUsed: { alreadyUsed: true, cleanup: 'trashed' },
    });
    const result = await consumeOneTimeCode(
      { userId: 'user-1', codeId: 'code-1', cleanup: 'trash' },
      { mutate, updateFolders },
    );
    expect(result.cleanupStatus).toBe('trashed');
    expect(folderCalls).toHaveLength(0);
  });

  test('reports a cleanup failure without un-spending the code', async () => {
    const { mutate, updateFolders, mutations } = harness({
      updateFoldersError: new Error('Nylas is unavailable'),
    });
    const result = await consumeOneTimeCode(
      { userId: 'user-1', codeId: 'code-1', cleanup: 'archive' },
      { mutate, updateFolders },
    );
    expect(result.ok).toBe(true);
    expect(result.cleanupStatus).toBe('failed');
    expect(result.error).toContain('Nylas is unavailable');
    expect(mutations.some((entry) => entry.name === 'markUsed')).toBe(true);
    expect(mutations.some((entry) => entry.name === 'recordCleanup' && entry.args.cleanup === 'failed')).toBe(
      true,
    );
  });
});
