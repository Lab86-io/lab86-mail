import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { GoogleApiError } from '../lib/google/errors';
import {
  __setGoogleHistoryDepsForTest,
  collectHistoryChanges,
  syncGoogleHistory,
} from '../lib/google/history-sync';

const USER = 'user-1';
const ACCOUNT = 'acct-1';
const GRANT = `google:${ACCOUNT}`;
const account = (overrides: Record<string, unknown> = {}) => ({
  userId: USER,
  accountId: ACCOUNT,
  email: 'ann@example.com',
  provider: 'google',
  status: 'connected',
  grantId: GRANT,
  scopes: [],
  ...overrides,
});

const ref = (id: string, labelIds: string[] = ['INBOX']) => ({
  message: { id, threadId: `t-${id}`, labelIds },
});

interface Recorded {
  history: URL[];
  finds: Array<{ id: string; withHeaders: boolean }>;
  applied: any[];
  saved: any[];
  reconciled: any[];
  failures: any[];
}

function setup(options: {
  row?: any;
  state?: any;
  pages?: Array<any | Error>;
  profileHistoryId?: string;
  missing?: string[];
  broken?: Record<string, Error>;
  applyFailed?: number;
}): Recorded {
  const recorded: Recorded = { history: [], finds: [], applied: [], saved: [], reconciled: [], failures: [] };
  let page = 0;
  __setGoogleHistoryDepsForTest({
    query: (async (fn: unknown) => {
      const name = getFunctionName(fn as any);
      if (name === 'accounts:getConnectedAccount') return options.row === undefined ? account() : options.row;
      if (name === 'mailCorpus:getSyncState')
        return options.state === undefined ? { historyId: '100' } : options.state;
      return null;
    }) as any,
    mutate: (async (fn: unknown, args: any) => {
      recorded.saved.push({ fn: getFunctionName(fn as any), ...args });
      return null;
    }) as any,
    googleJson: (async (_grant: string, url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/profile')) return { historyId: options.profileHistoryId ?? '999' };
      recorded.history.push(parsed);
      const next = options.pages?.[page++] ?? { historyId: '100' };
      if (next instanceof Error) throw next;
      return next;
    }) as any,
    findMessage: async (_grant: string, id: string, withHeaders: boolean) => {
      recorded.finds.push({ id, withHeaders });
      if (options.missing?.includes(id)) throw new GoogleApiError(404, 'Not Found');
      if (options.broken?.[id]) throw options.broken[id];
      return { id, threadId: `t-${id}`, folders: id.startsWith('draft') ? ['DRAFT'] : ['INBOX'] };
    },
    applyProviderMessageChanges: (async (_row: any, changes: any) => {
      recorded.applied.push(changes);
      return {
        upserted: changes.upserts.length - (options.applyFailed ?? 0),
        deleted: changes.deletes.length,
        failed: options.applyFailed ?? 0,
      };
    }) as any,
    reconcileMailCorpusAccount: (async (input: any) => {
      recorded.reconciled.push(input);
      return { ok: true };
    }) as any,
    noteGrantFailure: async (grantId: string, err: unknown) => {
      recorded.failures.push({ grantId, err });
      return false;
    },
  });
  return recorded;
}

afterEach(() => __setGoogleHistoryDepsForTest());

describe('collectHistoryChanges', () => {
  test('a later delete wins, drafts are skipped, and a relabel of new mail is one read', () => {
    const changes = collectHistoryChanges([
      { id: '1', messagesAdded: [ref('a'), ref('draft', ['DRAFT']), ref('b')] },
      { id: '2', labelsRemoved: [ref('a'), ref('c')], labelsAdded: [ref('d')] },
      { id: '3', messagesDeleted: [ref('b'), ref('d')] },
      { id: '4', messagesAdded: [ref('d')], labelsAdded: [{ message: {} }] },
      { id: '5', messagesDeleted: [{}] },
    ]);
    expect([...changes.added]).toEqual(['a', 'd']);
    expect([...changes.relabeled]).toEqual(['c']);
    expect([...changes.deleted]).toEqual(['b']);
  });
});

describe('syncGoogleHistory', () => {
  test('reads the History from the stored id and applies adds, relabels, and deletes', async () => {
    const recorded = setup({
      pages: [
        {
          history: [
            { id: '101', messagesAdded: [ref('new-1'), ref('draft-1', ['INBOX'])] },
            { id: '102', labelsRemoved: [ref('old-1', ['INBOX'])], messagesDeleted: [ref('old-2')] },
          ],
          historyId: '105',
        },
      ],
      missing: ['old-1'],
    });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    expect(result).toEqual({
      ok: true,
      accountId: ACCOUNT,
      added: 2,
      relabeled: 1,
      deleted: 2,
      historyId: '105',
    });
    const call = recorded.history[0];
    expect(call.searchParams.get('startHistoryId')).toBe('100');
    expect(call.searchParams.getAll('historyTypes')).toEqual([
      'messageAdded',
      'messageDeleted',
      'labelAdded',
      'labelRemoved',
    ]);
    expect(call.searchParams.get('maxResults')).toBe('500');
    expect(recorded.finds).toEqual([
      { id: 'new-1', withHeaders: true },
      { id: 'draft-1', withHeaders: true },
      { id: 'old-1', withHeaders: false },
    ]);
    expect(recorded.applied).toHaveLength(1);
    expect(recorded.applied[0].upserts.map((m: any) => m.id)).toEqual(['new-1']);
    expect(recorded.applied[0].deletes).toEqual(['old-2', 'old-1']);
    expect(recorded.saved[0]).toMatchObject({
      // The id moves only forward (googleDirect:advanceHistoryId).
      fn: 'googleDirect:advanceHistoryId',
      userId: USER,
      accountId: ACCOUNT,
      grantId: GRANT,
      historyId: '105',
      progress: { stage: 'google_history', added: 2, relabeled: 1, deleted: 1 },
    });
  });

  test('follows pages, and stops after a whole page when the run is full', async () => {
    const recorded = setup({
      pages: [
        { history: [{ id: '101', messagesAdded: [ref('a')] }], nextPageToken: 'p2' },
        {
          history: [
            { id: '102', messagesAdded: [ref('b')] },
            { id: '103', labelsAdded: [ref('c')] },
          ],
          nextPageToken: 'p3',
        },
      ],
    });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT, maxChanges: 3 });
    expect(result.more).toBe(true);
    expect(result.historyId).toBe('103');
    expect(recorded.history.map((url) => url.searchParams.get('pageToken'))).toEqual([null, 'p2']);
    expect(recorded.saved.at(-1).historyId).toBe('103');
  });

  test('without a stored id, the current id becomes the start and nothing is read', async () => {
    const recorded = setup({ state: null, profileHistoryId: '4242' });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    expect(result).toMatchObject({ ok: true, baseline: true, historyId: '4242' });
    expect(recorded.history).toEqual([]);
    expect(recorded.saved[0]).toMatchObject({
      historyId: '4242',
      progress: { stage: 'google_history', baseline: true },
    });
  });

  test('a History id that Google no longer has runs the reconcile and restarts from now', async () => {
    const recorded = setup({
      pages: [new GoogleApiError(404, 'Requested entity was not found.')],
      profileHistoryId: '5000',
    });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    expect(result).toMatchObject({ ok: true, reset: true, historyId: '5000' });
    expect(recorded.reconciled).toEqual([{ userId: USER, accountId: ACCOUNT }]);
    expect(recorded.saved[0]).toMatchObject({
      historyId: '5000',
      progress: { stage: 'google_history', reset: true },
    });
    expect(recorded.applied).toEqual([]);
  });

  test('a dead grant is noted and the error goes up; the stored id stays', async () => {
    const dead = new GoogleApiError(
      401,
      'invalid_grant: the Google sign-in expired or was revoked.',
      'invalid_grant',
    );
    const recorded = setup({ pages: [dead] });
    await expect(syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).rejects.toBe(dead);
    expect(recorded.failures).toEqual([{ grantId: GRANT, err: dead }]);
    expect(recorded.saved).toEqual([]);
  });

  test('one message that cannot be read is skipped and counted; the id moves forward', async () => {
    const recorded = setup({
      pages: [
        {
          history: [
            { id: '101', messagesAdded: [ref('bad'), ref('good')] },
            { id: '102', labelsAdded: [ref('old')] },
          ],
          historyId: '102',
        },
      ],
      broken: { bad: new GoogleApiError(500, 'backend'), old: new Error('socket hang up') },
    });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    expect(result).toMatchObject({ ok: true, added: 2, relabeled: 1, failed: 2, historyId: '102' });
    expect(recorded.applied[0].upserts.map((m: any) => m.id)).toEqual(['good']);
    expect(recorded.saved.at(-1)).toMatchObject({
      historyId: '102',
      progress: { stage: 'google_history', failed: 2 },
    });
    expect(recorded.failures).toEqual([]);
  });

  test('a write failure of the ingest path is counted, and the id still moves forward', async () => {
    const recorded = setup({
      pages: [{ history: [{ id: '101', messagesAdded: [ref('a'), ref('b')] }], historyId: '101' }],
      applyFailed: 1,
    });
    const result = await syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    expect(result).toMatchObject({ ok: true, failed: 1, historyId: '101' });
    expect(recorded.saved.at(-1)?.historyId).toBe('101');
  });

  test('a dead grant while messages are read stops the run and keeps the stored id', async () => {
    const dead = new GoogleApiError(
      401,
      'invalid_grant: the Google sign-in expired or was revoked.',
      'invalid_grant',
    );
    const recorded = setup({
      pages: [{ history: [{ id: '101', messagesAdded: [ref('a')] }], historyId: '101' }],
      broken: { a: dead },
    });
    await expect(syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).rejects.toBe(dead);
    expect(recorded.failures).toEqual([{ grantId: GRANT, err: dead }]);
    expect(recorded.saved).toEqual([]);
    expect(recorded.applied).toEqual([]);
  });

  test('skips accounts that are not connected, not direct, or already running', async () => {
    setup({ row: null });
    expect((await syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).skipped).toBe('not_connected');
    setup({ row: account({ status: 'error' }) });
    expect((await syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).skipped).toBe('not_connected');
    setup({ row: account({ grantId: 'nylas-grant' }) });
    expect((await syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).skipped).toBe('not_direct');
    let release: () => void = () => {};
    setup({ pages: [{ historyId: '100' }] });
    __setGoogleHistoryDepsForTest({
      query: (async (fn: unknown) =>
        getFunctionName(fn as any) === 'accounts:getConnectedAccount'
          ? account()
          : { historyId: '100' }) as any,
      googleJson: (() => new Promise((resolve) => (release = () => resolve({ historyId: '100' })))) as any,
      applyProviderMessageChanges: (async () => ({ upserted: 0, deleted: 0 })) as any,
      mutate: (async () => null) as any,
    });
    const first = syncGoogleHistory({ userId: USER, accountId: ACCOUNT });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).skipped).toBe('busy');
    release();
    expect((await first).ok).toBe(true);
  });

  test('the profile must give a History id', async () => {
    setup({ state: null });
    __setGoogleHistoryDepsForTest({
      query: (async (fn: unknown) =>
        getFunctionName(fn as any) === 'accounts:getConnectedAccount' ? account() : null) as any,
      googleJson: (async () => ({})) as any,
      noteGrantFailure: async () => false,
    });
    await expect(syncGoogleHistory({ userId: USER, accountId: ACCOUNT })).rejects.toThrow('History id');
  });
});
