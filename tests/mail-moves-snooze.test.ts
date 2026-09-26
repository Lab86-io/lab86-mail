import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMailSnoozePost } from '../app/api/cron/mail-snooze/route';
import { folderIdsAfterMove, moveNylasThread } from '../lib/nylas/provider';
import { restoreDueSnoozes, snoozeThread, unsnoozeThread } from '../lib/store/snooze';
import { accountRow, withHttpHarness } from './tools/http-harness';

const resolver = (map: Record<string, string | null>) => async (folder: string) => map[folder] ?? null;

describe('provider-aware moves (MUT-2)', () => {
  test('Gmail moves edit INBOX and TRASH only and keep other labels', async () => {
    const resolve = resolver({ INBOX: 'INBOX', TRASH: 'TRASH' });
    const current = ['INBOX', 'Label_7', 'CATEGORY_UPDATES', 'UNREAD'];
    expect(await folderIdsAfterMove('google', current, 'archive', resolve)).toEqual([
      'Label_7',
      'CATEGORY_UPDATES',
      'UNREAD',
    ]);
    expect(await folderIdsAfterMove('google', current, 'trash', resolve)).toEqual([
      'Label_7',
      'CATEGORY_UPDATES',
      'UNREAD',
      'TRASH',
    ]);
    expect(await folderIdsAfterMove('google', ['TRASH', 'Label_7'], 'inbox', resolver({}))).toEqual([
      'Label_7',
      'INBOX',
    ]);
  });

  test('Microsoft and iCloud moves set the one resolved folder id', async () => {
    const resolve = resolver({ ARCHIVE: 'AAMk-archive', TRASH: 'AAMk-deleted', INBOX: 'AAMk-inbox' });
    expect(await folderIdsAfterMove('microsoft', ['AAMk-inbox'], 'archive', resolve)).toEqual([
      'AAMk-archive',
    ]);
    expect(await folderIdsAfterMove('icloud', ['INBOX'], 'trash', resolve)).toEqual(['AAMk-deleted']);
    expect(await folderIdsAfterMove('imap', ['x'], 'inbox', resolve)).toEqual(['AAMk-inbox']);
    await expect(folderIdsAfterMove('icloud', ['INBOX'], 'archive', resolver({}))).rejects.toThrow(
      'This mailbox has no Archive folder',
    );
  });

  test('moveNylasThread resolves Outlook folders by name and updates the thread', async () => {
    await withHttpHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () =>
        accountRow({ provider: 'microsoft', grantId: 'grant_ms_move', accountId: 'acct_ms' }),
      );
      h.onNylas('GET', /\/v3\/grants\/grant_ms_move\/threads\/t1$/, () => ({
        json: { data: { id: 't1', folders: ['AAMk-inbox'] } },
      }));
      h.onNylas('GET', /\/v3\/grants\/grant_ms_move\/folders$/, () => ({
        json: {
          data: [
            { id: 'AAMk-inbox', name: 'Inbox' },
            { id: 'AAMk-deleted', name: 'Deleted Items' },
            { id: 'AAMk-archive', name: 'Archive' },
          ],
        },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_ms_move\/threads\/t1$/, () => ({ json: { data: { id: 't1' } } }));
      expect(
        await moveNylasThread({ userId: 'user_1', account: 'acct_ms', threadId: 't1', to: 'trash' }),
      ).toEqual({
        ok: true,
      });
      const update = h.nylasCalls.find((c) => c.method === 'PUT');
      expect(update?.body).toEqual({ folders: ['AAMk-deleted'] });
    });
  });
});

const snoozeDeps = () => ({
  query: mock(async (): Promise<any> => []),
  mutate: mock(async (): Promise<any> => ({})),
  moveThread: mock(async (): Promise<any> => ({ ok: true })),
  updateThread: mock(async (): Promise<any> => ({ ok: true })),
});

describe('real snooze (MUT-1)', () => {
  test('snooze archives the thread and records the wake time', async () => {
    const deps = snoozeDeps();
    const untilTs = Date.now() + 3_600_000;
    await snoozeThread({ userId: 'u', account: 'a', threadId: 't', messageId: 'm', untilTs }, deps as any);
    expect(deps.moveThread.mock.calls[0]).toEqual([
      { userId: 'u', account: 'a', threadId: 't', to: 'archive' },
    ] as any);
    expect((deps.mutate.mock.calls[0] as any[])[1]).toEqual({
      userId: 'u',
      accountId: 'a',
      threadId: 't',
      messageId: 'm',
      untilTs,
    });
  });

  test('a past time, a missing account, or a failed record never leaves mail hidden', async () => {
    const deps = snoozeDeps();
    await expect(
      snoozeThread({ userId: 'u', account: 'a', threadId: 't', untilTs: Date.now() - 1 }, deps as any),
    ).rejects.toThrow(/future/);
    deps.moveThread.mockImplementationOnce(async () => null);
    await expect(
      snoozeThread({ userId: 'u', account: 'a', threadId: 't', untilTs: Date.now() + 60_000 }, deps as any),
    ).rejects.toThrow(/Nylas account/);
    expect(deps.mutate).not.toHaveBeenCalled();
    deps.mutate.mockImplementationOnce(async () => {
      throw new Error('convex down');
    });
    await expect(
      snoozeThread({ userId: 'u', account: 'a', threadId: 't', untilTs: Date.now() + 60_000 }, deps as any),
    ).rejects.toThrow('convex down');
    expect((deps.moveThread.mock.calls.at(-1) as any[])[0].to).toBe('inbox');
  });

  test('unsnooze cancels the record and moves the thread back', async () => {
    const deps = snoozeDeps();
    deps.mutate.mockImplementation(async () => ({ threadIds: ['t2'] }));
    expect(await unsnoozeThread({ userId: 'u', account: 'a', messageId: 'm' }, deps as any)).toEqual({
      restored: 1,
    });
    expect((deps.moveThread.mock.calls[0] as any[])[0]).toEqual({
      userId: 'u',
      account: 'a',
      threadId: 't2',
      to: 'inbox',
    });
    await expect(unsnoozeThread({ userId: 'u', account: 'a' }, deps as any)).rejects.toThrow(/required/);
  });

  test('due snoozes come back unread; failures are counted and recorded', async () => {
    const deps = snoozeDeps();
    deps.query.mockImplementation(async () => [
      { id: 's1', userId: 'u', accountId: 'a', threadId: 't1', attempts: 0 },
      { id: 's2', userId: 'u', accountId: 'a', threadId: 't2', attempts: 0 },
    ]);
    deps.moveThread.mockImplementation(async (args: any) => {
      if (args.threadId === 't2') throw new Error('provider down');
      return { ok: true };
    });
    expect(await restoreDueSnoozes(deps as any)).toEqual({ restored: 1, failed: 1 });
    expect((deps.updateThread.mock.calls[0] as any[])[0]).toMatchObject({ threadId: 't1', unread: true });
    const settled = deps.mutate.mock.calls.map((call: any[]) => call[1]);
    expect(settled).toEqual([
      { id: 's1', ok: true },
      { id: 's2', ok: false, error: 'provider down' },
    ]);
  });

  test('the snooze cron route checks the secret', async () => {
    const restore = mock(async () => ({ restored: 0, failed: 0 }));
    const req = new NextRequest('http://localhost/api/cron/mail-snooze', { method: 'POST' });
    expect(
      (await createMailSnoozePost({ isInternalCronRequest: () => true, restoreDueSnoozes: restore })(req))
        .status,
    ).toBe(202);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(
      (await createMailSnoozePost({ isInternalCronRequest: () => false, restoreDueSnoozes: restore })(req))
        .status,
    ).toBe(401);
  });
});
